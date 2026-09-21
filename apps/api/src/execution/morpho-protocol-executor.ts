import { stat, writeFile } from 'node:fs/promises'

import {
  buildLaunchArguments,
  parseMorphoLogLine,
  resolveBatchTimeoutSeconds,
  resolveProtocolTimeoutSeconds,
} from '../apk-protocols.js'
import { TaskExecutionError } from './execution-errors.js'
import {
  collectMorphoStartupInspection,
  waitForMorphoStartup,
} from './morpho-startup.js'
import {
  BaseProtocolExecutor,
  type BatchExecutionContext,
  type BatchExecutionResult,
  type BatchVideoOutcome,
  type BatchVideoRequest,
  type DirectoryBatchProtocolExecutor,
  type ProtocolExecutionContext,
  type ProtocolExecutionResult,
} from './protocol-executor.js'

function isDirectRemoteChild(directory: string, candidate: string) {
  const prefix = `${directory.replace(/\/+$/, '')}/`
  if (!candidate.startsWith(prefix)) return false
  const relative = candidate.slice(prefix.length)
  return Boolean(relative) && !relative.includes('/') && relative.toLowerCase().endsWith('.mp4')
}

function baseName(remotePath: string) {
  return remotePath.split('/').pop() ?? remotePath
}

interface BatchVideoState {
  request: BatchVideoRequest
  inputSizeBytes: number
  announcedOutput?: string
  failureMessage?: string
}

export class MorphoProtocolExecutor extends BaseProtocolExecutor implements DirectoryBatchProtocolExecutor {
  async execute(context: ProtocolExecutionContext): Promise<ProtocolExecutionResult> {
    const { protocol, paths, signal, reporter } = context
    let stopLogcat: (() => Promise<void>) | undefined
    let logcatWarning: string | undefined
    let logcatFatal: TaskExecutionError | undefined
    let protocolFailure: string | undefined
    let detectedRemoteOutputFile: string | undefined
    let acceptStartupEvidence = false
    let businessStarted = false
    let startupProbeAttempt = 0

    try {
      const inputSizeBytes = await this.prepareInput(context)
      await this.assertLogcatDiskSpace(context.local.runDirectory)
      const logTags = protocol.progress.logTags ?? [protocol.progress.logTag]

      try {
        stopLogcat = await this.startLogcat(
          context,
          logTags,
          (line) => {
            const event = parseMorphoLogLine(line)
            if (!event || !acceptStartupEvidence) return
            if (event.businessStarted) businessStarted = true
            if (event.message) {
              reporter.addLog(event.message, event.failureMessage ? 'error' : 'info')
            }
            if (event.failureMessage) protocolFailure = event.failureMessage
            if (event.outputPath
              && isDirectRemoteChild(paths.remoteOutputDirectory, event.outputPath)) {
              detectedRemoteOutputFile = event.outputPath
              reporter.addLog(`Morpho 实际输出路径：${event.outputPath}`)
            }
            if (typeof event.progress === 'number') {
              reporter.setProcessingProgress(event.progress)
            }
          },
          (event) => {
            logcatWarning = this.describeLogcatEvent(event)
            reporter.addLog(logcatWarning, 'warning')
            if (!businessStarted
              && (event.type === 'process_exited' || event.type === 'write_failed')) {
              logcatFatal = new TaskExecutionError(logcatWarning, 'LOGCAT_START_FAILED')
            }
          },
        )
      } catch (error) {
        logcatFatal = new TaskExecutionError(
          `无法启动设备业务 Logcat：${error instanceof Error ? error.message : String(error)}`,
          'LOGCAT_START_FAILED',
        )
        logcatWarning = `LOGCAT_START_FAILED：${logcatFatal.message}`
        reporter.addLog(logcatWarning, 'warning')
      }

      if (stopLogcat) reporter.addLog(`开始采集过滤业务 Logcat：${logTags.join(', ')}`)
      await this.delay(100, signal)

      reporter.update('launching_app', 35, `正在按 ${protocol.name} 启动 APK`)
      acceptStartupEvidence = true
      const startupStartedAt = this.now()
      await this.adb(
        buildLaunchArguments(protocol, paths, context.taskId),
        signal,
        30_000,
        'APP_LAUNCH_FAILED',
      )

      const startupEvidence = await waitForMorphoStartup({
        signal,
        hasBusinessLog: () => businessStarted,
        getLogcatFailure: () => logcatFatal,
        inspect: async (remainingMs) => collectMorphoStartupInspection({
          packageName: protocol.packageName,
          diagnosticsDirectory: context.local.diagnosticsDirectory,
          attempt: ++startupProbeAttempt,
          remainingMs,
          signal,
          runner: {
            run: (args, probeSignal, timeoutMs, capture) => this.dependencies.device.observe(
              args,
              probeSignal,
              timeoutMs,
              {
                captureStdoutPath: capture.stdoutPath,
                captureStderrPath: capture.stderrPath,
              },
            ),
          },
        }),
        onIncompleteObservation: (observation) => {
          reporter.addLog(
            `Morpho 启动探测证据不完整，继续等待业务证据：${observation.summary}`,
            'warning',
          )
        },
        now: this.now,
        delay: this.delay,
      })
      businessStarted = true
      reporter.addLog(
        `Morpho 启动握手通过；证据=${startupEvidence}；耗时=${this.now() - startupStartedAt}ms`,
      )
      reporter.upsertCheck({ key: 'launch', name: '应用启动', status: 'passed' })

      reporter.update('processing', 45, 'Morpho 业务启动已确认，等待批处理完成标记和稳定后视频')
      const timeoutMs = resolveProtocolTimeoutSeconds(
        protocol,
        context.configuredTimeoutSeconds,
      ) * 1_000
      await this.waitForCompletion(
        context,
        timeoutMs,
        () => protocolFailure,
        () => detectedRemoteOutputFile ?? paths.remoteOutputFile,
      )
      reporter.upsertCheck({
        key: 'processing',
        name: 'SDK 视频处理',
        status: 'passed',
        message: 'Morpho 完成标记、日志和输出文件联合校验通过',
      })

      const remoteOutputFile = detectedRemoteOutputFile ?? paths.remoteOutputFile
      const output = await this.collectOutput(context, remoteOutputFile)
      await this.writeBackendResult(context, inputSizeBytes, output)
      return { inputSizeBytes, ...output, logcatWarning }
    } catch (error) {
      if (stopLogcat) {
        await stopLogcat().catch((stopError) => {
          reporter.addLog(
            `LOGCAT_WRITE_FAILED：${stopError instanceof Error ? stopError.message : String(stopError)}`,
            'warning',
          )
        })
        stopLogcat = undefined
      }
      if (!signal.aborted && !reporter.isCancelled()) await this.captureFailureLogcat(context)
      throw error
    } finally {
      if (stopLogcat) {
        await stopLogcat().catch((error) => {
          reporter.addLog(
            `LOGCAT_WRITE_FAILED：${error instanceof Error ? error.message : String(error)}`,
            'warning',
          )
        })
      }
      await this.bestEffortDeviceRun(
        context,
        ['shell', 'am', 'force-stop', protocol.packageName],
        '执行结束时停止 APK 失败',
      )
      const cleanupFiles = [...new Set([
        paths.remoteCompletionPath,
        paths.remoteInputFile,
        paths.remoteOutputFile,
        detectedRemoteOutputFile,
      ].filter((value): value is string => Boolean(value)))]
      await this.bestEffortDeviceRun(
        context,
        ['shell', 'rm', '-f', ...cleanupFiles],
        '清理 Morpho 远端临时文件失败',
      )
    }
  }

  private async prepareInput(context: ProtocolExecutionContext) {
    const { protocol, paths, signal, reporter } = context
    reporter.update('transferring_input', 25, '正在准备 APK 输入目录并清理本次旧结果')
    await this.adb(['shell', 'mkdir', '-p', paths.remoteInputDirectory], signal)
    await this.adb([
      'shell', 'rm', '-f', paths.remoteCompletionPath, paths.remoteInputFile,
    ], signal)
    if (protocol.output.clearDirectoryBeforeRun) {
      await this.adb(['shell', 'rm', '-rf', paths.remoteOutputDirectory], signal)
    } else {
      await this.adb(['shell', 'rm', '-f', paths.remoteOutputFile], signal)
    }
    if (!protocol.output.appCreatesDirectory) {
      await this.adb(['shell', 'mkdir', '-p', paths.remoteOutputDirectory], signal)
    }
    await this.adb(
      ['push', context.input.localPath, paths.remoteInputFile],
      signal,
      180_000,
      'INPUT_PUSH_FAILED',
    )

    const remoteSize = await this.remoteStat(paths.remoteInputFile, signal)
    const localSize = (await stat(context.input.localPath)).size
    if (!Number.isFinite(remoteSize) || remoteSize !== localSize) {
      throw new TaskExecutionError(
        '手机端输入 MP4 大小与上传文件不一致',
        'INPUT_PUSH_FAILED',
      )
    }
    reporter.upsertCheck({
      key: 'input',
      name: '输入 MP4 校验',
      status: 'passed',
      message: `${localSize} bytes`,
    })
    return localSize
  }

  private async waitForCompletion(
    context: ProtocolExecutionContext,
    timeoutMs: number,
    getFailure: () => string | undefined,
    getOutputFile: () => string,
  ) {
    const startedAt = this.now()
    while (this.now() - startedAt < timeoutMs) {
      if (context.reporter.isCancelled()) {
        throw new DOMException('任务已取消', 'AbortError')
      }

      const failure = getFailure()
      if (failure) {
        throw new TaskExecutionError(
          `Morpho SDK 处理失败：${failure}`,
          'SDK_PROCESSING_FAILED',
        )
      }

      if (await this.remoteExists(context.paths.remoteCompletionPath, context.signal)) {
        const size = await this.remoteStat(getOutputFile(), context.signal)
        if (size < 0) {
          throw new TaskExecutionError(
            'Morpho 已结束批处理，但没有生成本次稳定后视频',
            'OUTPUT_MISSING',
          )
        }
        if (size === 0) {
          throw new TaskExecutionError(
            'Morpho 已生成输出文件，但文件大小为 0',
            'OUTPUT_EMPTY',
          )
        }
        return
      }

      if (this.now() - startedAt > 3_000
        && !await this.isPackageRunning(context.protocol.packageName, context.signal)) {
        throw new TaskExecutionError(
          'Morpho 进程已退出，且没有生成完成标记',
          'APP_CRASHED',
        )
      }
      await this.delay(this.dependencies.pollIntervalMs, context.signal)
    }
    throw new TaskExecutionError(
      `超过 ${Math.round(timeoutMs / 1_000)} 秒仍未检测到 Morpho 完成标记`,
      'TASK_TIMEOUT',
    )
  }

  private async writeBackendResult(
    context: ProtocolExecutionContext,
    inputSizeBytes: number,
    output: Omit<ProtocolExecutionResult, 'inputSizeBytes' | 'logcatWarning'>,
  ) {
    await writeFile(context.local.resultPath, JSON.stringify({
      protocolVersion: 1,
      taskId: context.taskId,
      status: 'passed',
      source: 'backend-synthesized',
      protocolId: context.protocol.id,
      packageName: context.protocol.packageName,
      adapter: 'MorphoVideoPostProcessor',
      apkGeneratedResult: false,
      input: {
        name: context.input.originalName,
        sizeBytes: inputSizeBytes,
      },
      output: {
        name: 'output.mp4',
        originalRemotePath: output.remoteOutputFile,
        sizeBytes: output.outputSizeBytes,
        sha256: output.outputSha256,
      },
      checks: [
        { key: 'input', name: '输入 MP4 校验', status: 'passed' },
        { key: 'launch', name: '应用启动', status: 'passed' },
        { key: 'processing', name: 'SDK 视频处理', status: 'passed' },
        { key: 'output_generated', name: '输出 MP4 生成', status: 'passed' },
      ],
      generatedAt: new Date(this.now()).toISOString(),
    }, null, 2), 'utf8')
  }

  /**
   * 目录批处理（doc §7.3）：push 全部输入 → 一次 Action → 一次 marker 等待 → 逐视频收敛输出。
   * 真机验证的失败语义：单条致命失败会销毁批处理服务且不写 marker；此时已产出输出的视频
   * 保持 converged，在处理的视频 failed，未开始的视频 not_started（编排层重发 Action 续跑）。
   */
  async executeBatch(context: BatchExecutionContext): Promise<BatchExecutionResult> {
    const { protocol, paths, signal, reporter } = context
    const states: BatchVideoState[] = context.videos.map((request) => ({
      request,
      inputSizeBytes: 0,
    }))
    const stateByInputBaseName = new Map(states.map((state) => [
      baseName(state.request.paths.remoteInputFile), state,
    ]))

    let stopLogcat: (() => Promise<void>) | undefined
    let logcatWarning: string | undefined
    let logcatFatal: TaskExecutionError | undefined
    let serviceDestroyed = false
    let markerAnnounced = false
    let businessStarted = false
    let acceptStartupEvidence = false
    let current: BatchVideoState | undefined
    let startupProbeAttempt = 0

    try {
      await this.prepareBatchInputs(context, states)
      await this.assertLogcatDiskSpace(context.local.runDirectory)
      const logTags = protocol.progress.logTags ?? [protocol.progress.logTag]

      try {
        stopLogcat = await this.startLogcat(
          context,
          logTags,
          (line) => {
            const event = parseMorphoLogLine(line)
            if (!event || !acceptStartupEvidence) return
            if (event.businessStarted) businessStarted = true
            if (event.markerCreated) markerAnnounced = true
            if (event.serviceDestroyed) serviceDestroyed = true

            if (event.processingFile) {
              const next = stateByInputBaseName.get(event.processingFile.fileName)
              if (next) current = next
              reporter.addLog(
                `批处理进度：第 ${event.processingFile.index}/${event.processingFile.total} 条 ${event.processingFile.fileName}`,
              )
            }

            const messageTarget = current?.request.reporter ?? reporter
            if (event.pipelineFatal) {
              if (current && !current.failureMessage) current.failureMessage = event.pipelineFatal
              messageTarget.addLog(`Morpho SDK 致命失败：${event.pipelineFatal}`, 'error')
            } else if (event.failureMessage) {
              if (current && !current.failureMessage) current.failureMessage = event.failureMessage
              messageTarget.addLog(event.message!, 'error')
            } else if (event.message) {
              messageTarget.addLog(event.message)
            }

            if (event.outputPath
              && isDirectRemoteChild(paths.remoteOutputDirectory, event.outputPath)
              && current
              && !current.announcedOutput) {
              current.announcedOutput = event.outputPath
              current.request.reporter.addLog(`Morpho 实际输出路径：${event.outputPath}`)
            }
            if (typeof event.progress === 'number' && current) {
              current.request.reporter.setProcessingProgress(event.progress)
            }
          },
          (event) => {
            logcatWarning = this.describeLogcatEvent(event)
            reporter.addLog(logcatWarning, 'warning')
            if (!businessStarted
              && (event.type === 'process_exited' || event.type === 'write_failed')) {
              logcatFatal = new TaskExecutionError(logcatWarning, 'LOGCAT_START_FAILED')
            }
          },
        )
      } catch (error) {
        logcatFatal = new TaskExecutionError(
          `无法启动设备业务 Logcat：${error instanceof Error ? error.message : String(error)}`,
          'LOGCAT_START_FAILED',
        )
        logcatWarning = `LOGCAT_START_FAILED：${logcatFatal.message}`
        reporter.addLog(logcatWarning, 'warning')
      }

      if (stopLogcat) reporter.addLog(`开始采集过滤业务 Logcat：${logTags.join(', ')}`)
      await this.delay(100, signal)

      reporter.update('launching_app', 35, `正在按 ${protocol.name} 启动一次目录批处理（${states.length} 条视频）`)
      acceptStartupEvidence = true
      const startupStartedAt = this.now()
      await this.adb(
        buildLaunchArguments(protocol, paths, context.taskId),
        signal,
        30_000,
        'APP_LAUNCH_FAILED',
      )

      const startupEvidence = await waitForMorphoStartup({
        signal,
        hasBusinessLog: () => businessStarted,
        getLogcatFailure: () => logcatFatal,
        inspect: async (remainingMs) => collectMorphoStartupInspection({
          packageName: protocol.packageName,
          diagnosticsDirectory: context.local.diagnosticsDirectory,
          attempt: ++startupProbeAttempt,
          remainingMs,
          signal,
          runner: {
            run: (args, probeSignal, timeoutMs, capture) => this.dependencies.device.observe(
              args,
              probeSignal,
              timeoutMs,
              {
                captureStdoutPath: capture.stdoutPath,
                captureStderrPath: capture.stderrPath,
              },
            ),
          },
        }),
        onIncompleteObservation: (observation) => {
          reporter.addLog(
            `Morpho 启动探测证据不完整，继续等待业务证据：${observation.summary}`,
            'warning',
          )
        },
        now: this.now,
        delay: this.delay,
      })
      businessStarted = true
      reporter.addLog(
        `Morpho 批处理启动握手通过；证据=${startupEvidence}；耗时=${this.now() - startupStartedAt}ms`,
      )
      reporter.upsertCheck({ key: 'launch', name: '应用启动', status: 'passed' })

      reporter.update('processing', 45, '批处理已启动，等待完成标记并逐视频收敛输出')
      const timeoutMs = resolveBatchTimeoutSeconds(
        protocol,
        context.configuredTimeoutSeconds,
        context.videos.length,
      ) * 1_000
      const completion = await this.waitForBatchCompletion(
        context,
        timeoutMs,
        () => serviceDestroyed,
        () => markerAnnounced,
        () => businessStarted,
      )

      return await this.convergeBatchOutputs(context, states, completion)
    } catch (error) {
      if (stopLogcat) {
        await stopLogcat().catch((stopError) => {
          reporter.addLog(
            `LOGCAT_WRITE_FAILED：${stopError instanceof Error ? stopError.message : String(stopError)}`,
            'warning',
          )
        })
        stopLogcat = undefined
      }
      if (!signal.aborted && !reporter.isCancelled()) await this.captureFailureLogcat(context)
      throw error
    } finally {
      if (stopLogcat) {
        await stopLogcat().catch((error) => {
          reporter.addLog(
            `LOGCAT_WRITE_FAILED：${error instanceof Error ? error.message : String(error)}`,
            'warning',
          )
        })
      }
      await this.bestEffortDeviceRun(
        context,
        ['shell', 'am', 'force-stop', protocol.packageName],
        '执行结束时停止 APK 失败',
      )
      const cleanupFiles = [...new Set([
        paths.remoteCompletionPath,
        ...states.map((state) => state.request.paths.remoteInputFile),
        ...states.map((state) => state.request.paths.remoteOutputFile),
        ...states.map((state) => state.announcedOutput),
      ].filter((value): value is string => Boolean(value)))]
      await this.bestEffortDeviceRun(
        context,
        ['shell', 'rm', '-f', ...cleanupFiles],
        '清理 Morpho 远端批处理临时文件失败',
      )
    }
  }

  private async prepareBatchInputs(context: BatchExecutionContext, states: BatchVideoState[]) {
    const { paths, signal, reporter } = context
    reporter.update('transferring_input', 25, `正在准备批处理输入目录并推送 ${states.length} 条视频`)
    await this.adb(['shell', 'mkdir', '-p', paths.remoteInputDirectory], signal)
    // 批处理语义要求输出目录干净：残留旧输出会破坏确定性命名映射。
    await this.adb(['shell', 'rm', '-f', paths.remoteCompletionPath], signal)
    await this.adb(['shell', 'rm', '-rf', paths.remoteOutputDirectory], signal)
    if (!context.protocol.output.appCreatesDirectory) {
      await this.adb(['shell', 'mkdir', '-p', paths.remoteOutputDirectory], signal)
    }
    for (const state of states) {
      await this.adb(
        ['push', state.request.localPath, state.request.paths.remoteInputFile],
        signal,
        180_000,
        'INPUT_PUSH_FAILED',
      )
      const remoteSize = await this.remoteStat(state.request.paths.remoteInputFile, signal)
      const localSize = (await stat(state.request.localPath)).size
      if (!Number.isFinite(remoteSize) || remoteSize !== localSize) {
        throw new TaskExecutionError(
          '手机端输入 MP4 大小与上传文件不一致',
          'INPUT_PUSH_FAILED',
        )
      }
      state.inputSizeBytes = localSize
      state.request.reporter.upsertCheck({
        key: 'input',
        name: '输入 MP4 校验',
        status: 'passed',
        message: `${localSize} bytes`,
      })
    }
  }

  private async waitForBatchCompletion(
    context: BatchExecutionContext,
    timeoutMs: number,
    isServiceDestroyed: () => boolean,
    isMarkerAnnounced: () => boolean,
    hasBusinessStarted: () => boolean,
  ): Promise<'marker' | 'aborted'> {
    const { paths, signal, reporter } = context
    const startedAt = this.now()
    while (this.now() - startedAt < timeoutMs) {
      if (reporter.isCancelled()) {
        throw new DOMException('任务已取消', 'AbortError')
      }

      if (await this.remoteExists(paths.remoteCompletionPath, signal)) return 'marker'

      // 服务已销毁且日志从未宣告 marker：按批中止收敛（marker 检查在先，
      // 正常收尾时 marker 已可见，不会误入此分支）。
      if (isServiceDestroyed() && !isMarkerAnnounced()) {
        if (this.now() - startedAt > 3_000
          && !await this.isPackageRunning(context.protocol.packageName, signal)) {
          return 'aborted'
        }
      }

      if (this.now() - startedAt > 3_000
        && hasBusinessStarted()
        && !await this.isPackageRunning(context.protocol.packageName, signal)) {
        throw new TaskExecutionError(
          'Morpho 进程已退出，且没有生成完成标记',
          'APP_CRASHED',
        )
      }
      await this.delay(this.dependencies.pollIntervalMs, signal)
    }
    throw new TaskExecutionError(
      `超过 ${Math.round(timeoutMs / 1_000)} 秒仍未检测到 Morpho 批处理完成标记`,
      'TASK_TIMEOUT',
    )
  }

  private async convergeBatchOutputs(
    context: BatchExecutionContext,
    states: BatchVideoState[],
    completion: 'marker' | 'aborted',
  ): Promise<BatchExecutionResult> {
    const outcomes: BatchVideoOutcome[] = []
    let failureIndex = -1
    if (completion === 'aborted') {
      failureIndex = states.findIndex((state) => state.failureMessage)
      if (failureIndex === -1) {
        // 服务销毁但没有任何视频记录到失败：处理从未开始或窗口外的崩溃，
        // 整批按未开始收敛，由编排层决定重发或失败。
        return {
          batchAborted: true,
          outcomes: states.map((state) => ({
            taskVideoId: state.request.taskVideoId,
            status: 'not_started' as const,
          })),
        }
      }
    }

    for (const [index, state] of states.entries()) {
      const { request } = state
      if (completion === 'aborted') {
        if (index > failureIndex) {
          outcomes.push({ taskVideoId: request.taskVideoId, status: 'not_started' })
          continue
        }
        if (index === failureIndex) {
          request.reporter.upsertCheck({
            key: 'processing',
            name: 'SDK 视频处理',
            status: 'failed',
            message: `Morpho 致命失败：${state.failureMessage}`,
          })
          outcomes.push({
            taskVideoId: request.taskVideoId,
            status: 'failed',
            failure: {
              code: 'SDK_PROCESSING_FAILED',
              message: `Morpho SDK 处理失败：${state.failureMessage}`,
            },
          })
          continue
        }
      }

      const remoteOutputFile = state.announcedOutput ?? request.paths.remoteOutputFile
      try {
        const output = await this.collectOutput(
          { signal: context.signal, reporter: request.reporter, local: request.local },
          remoteOutputFile,
        )
        await this.writeBatchBackendResult(context, state, remoteOutputFile, output)
        request.reporter.upsertCheck({
          key: 'processing',
          name: 'SDK 视频处理',
          status: 'passed',
          message: 'Morpho 完成标记、日志和输出文件联合校验通过',
        })
        request.reporter.upsertCheck({
          key: 'output_generated',
          name: '输出 MP4 生成',
          status: 'passed',
          message: `${output.outputSizeBytes} bytes；手机原始路径：${remoteOutputFile}`,
        })
        outcomes.push({
          taskVideoId: request.taskVideoId,
          status: 'converged',
          inputSizeBytes: state.inputSizeBytes,
          output: {
            remoteOutputFile,
            outputSizeBytes: output.outputSizeBytes,
            outputSha256: output.outputSha256,
          },
        })
      } catch (error) {
        if (error instanceof TaskExecutionError
          && (error.code === 'OUTPUT_MISSING' || error.code === 'OUTPUT_EMPTY')) {
          request.reporter.upsertCheck({
            key: 'processing',
            name: 'SDK 视频处理',
            status: 'failed',
            message: error.message,
          })
          outcomes.push({
            taskVideoId: request.taskVideoId,
            status: 'failed',
            failure: { code: error.code, message: error.message },
          })
          continue
        }
        throw error
      }
    }
    return { batchAborted: completion === 'aborted', outcomes }
  }

  private async writeBatchBackendResult(
    context: BatchExecutionContext,
    state: BatchVideoState,
    remoteOutputFile: string,
    output: Omit<ProtocolExecutionResult, 'inputSizeBytes' | 'logcatWarning'>,
  ) {
    await writeFile(state.request.local.resultPath, JSON.stringify({
      protocolVersion: 1,
      taskId: context.taskId,
      status: 'passed',
      source: 'backend-synthesized',
      protocolId: context.protocol.id,
      packageName: context.protocol.packageName,
      adapter: 'MorphoVideoPostProcessor',
      apkGeneratedResult: false,
      batch: {
        taskVideoId: state.request.taskVideoId,
        originalName: state.request.originalName,
      },
      input: {
        name: state.request.originalName,
        sizeBytes: state.inputSizeBytes,
      },
      output: {
        name: 'output.mp4',
        originalRemotePath: remoteOutputFile,
        sizeBytes: output.outputSizeBytes,
        sha256: output.outputSha256,
      },
      checks: [
        { key: 'input', name: '输入 MP4 校验', status: 'passed' },
        { key: 'launch', name: '应用启动', status: 'passed' },
        { key: 'processing', name: 'SDK 视频处理', status: 'passed' },
        { key: 'output_generated', name: '输出 MP4 生成', status: 'passed' },
      ],
      generatedAt: new Date(this.now()).toISOString(),
    }, null, 2), 'utf8')
  }
}
