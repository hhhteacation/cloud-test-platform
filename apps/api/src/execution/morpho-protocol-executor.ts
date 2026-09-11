import type { Dirent } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  buildLaunchArguments,
  parseMorphoLogLine,
  resolveProtocolTimeoutSeconds,
} from '../apk-protocols.js'
import { TaskExecutionError } from './execution-errors.js'
import {
  collectMorphoStartupInspection,
  waitForMorphoStartup,
} from './morpho-startup.js'
import {
  BaseProtocolExecutor,
  type ProtocolExecutionContext,
  type ProtocolExecutionResult,
} from './protocol-executor.js'

function isDirectRemoteChild(directory: string, candidate: string) {
  const prefix = `${directory.replace(/\/+$/, '')}/`
  if (!candidate.startsWith(prefix)) return false
  const relative = candidate.slice(prefix.length)
  return Boolean(relative) && !relative.includes('/') && relative.toLowerCase().endsWith('.mp4')
}

export class MorphoProtocolExecutor extends BaseProtocolExecutor {
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
    const pushedAssets = await this.pushCompanionAssets(context)
    if (pushedAssets > 0) {
      // The SDK decides its feature mask when the process starts. The warm-up
      // launch already created a live process without these configs, so the
      // batch intent must reach a fresh process (verified on vivo V2324A).
      await this.adb(['shell', 'am', 'force-stop', protocol.packageName], signal)
      reporter.addLog('已停止预热进程，批处理将冷启动并读取伴生配置')
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

  /**
   * The demo batch_process.sh only pushes the MP4; vendor configs such as
   * morpho_video_denoiser_setting.xml are pushed by hand in manual tests and
   * decide the SDK feature mask (0x4 stabilizer-only vs 0xc with denoiser).
   * Clean install wipes the DataPack directory, so they must be pushed per attempt.
   * Returns the number of files pushed.
   */
  private async pushCompanionAssets(context: ProtocolExecutionContext): Promise<number> {
    const { paths, signal, reporter } = context
    const directory = this.dependencies.companionAssetsDir
    if (!directory) return 0

    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reporter.addLog(`未找到伴生资产目录 ${directory}，Morpho 将以仅防抖模式运行`, 'warning')
        return 0
      }
      throw new TaskExecutionError(
        `读取伴生资产目录失败：${error instanceof Error ? error.message : String(error)}`,
        'INPUT_PUSH_FAILED',
      )
    }

    const names = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
    if (names.length === 0) {
      reporter.addLog(`伴生资产目录 ${directory} 为空，Morpho 将以仅防抖模式运行`, 'warning')
      return 0
    }

    const pushed: string[] = []
    for (const name of names) {
      const localPath = path.join(directory, name)
      await this.adb(
        ['push', localPath, `${paths.remoteInputDirectory}/${name}`],
        signal,
        60_000,
        'INPUT_PUSH_FAILED',
      )
      pushed.push(`${name} (${(await stat(localPath)).size} bytes)`)
    }
    reporter.addLog(`已推送伴生资产：${pushed.join('、')}`)
    return pushed.length
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
}
