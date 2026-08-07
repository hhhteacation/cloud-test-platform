import { mkdir, readFile, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  buildExecutionPaths,
  buildLaunchArguments,
  findApkExecutionProtocol,
  parseMorphoLogLine,
  resolveProtocolTimeoutSeconds,
  type ApkExecutionPaths,
  type ApkExecutionProtocol,
} from './apk-protocols.js'
import { config as defaultConfig, type AppConfig } from './config.js'
import { PlatformDatabase, type DeviceRunExecution, type DeviceRunJob } from './database.js'
import { MediaIntegrityChecker } from './media-integrity.js'
import { BoundedProcessRunner, type ProcessRunner } from './process.js'
import { TaskExecutionError } from './execution/execution-errors.js'
import { getCheckName } from './execution/check-names.js'
import { delay, sha256File } from './execution/file-utils.js'
import { AdbDeviceClient, type AdbObservation } from './execution/adb-client.js'
import { AdbStreams, type LogcatStreamEvent } from './execution/adb-streams.js'
import { TaskProcessRegistry } from './execution/process-registry.js'
import {
  collectMorphoStartupInspection,
  waitForMorphoStartup,
} from './execution/morpho-startup.js'
import {
  DefaultAndroidAppPreparer,
  type AndroidAppPreparer,
} from './execution/android-app-preparation/index.js'
import { AndroidDeviceReadiness } from './execution/android-app-preparation/device-readiness.js'
import type { AndroidCheckEvent, AndroidResult, DeviceRunPhase } from './types.js'

function isDirectRemoteChild(directory: string, candidate: string) {
  const prefix = `${directory.replace(/\/+$/, '')}/`
  if (!candidate.startsWith(prefix)) return false
  const relative = candidate.slice(prefix.length)
  return Boolean(relative) && !relative.includes('/') && relative.toLowerCase().endsWith('.mp4')
}

export class AdbWorker {
  private readonly active = new Map<string, AdbRunExecutor>()

  constructor(
    private readonly database: PlatformDatabase,
    private readonly mediaIntegrityChecker = new MediaIntegrityChecker(),
    private readonly appConfig: AppConfig = defaultConfig,
    private readonly processRunner: ProcessRunner = new BoundedProcessRunner({
      maxOutputBytes: appConfig.maxProcessOutputBytes,
      killGraceMs: appConfig.processKillGraceMs,
    }),
  ) {}

  async execute(job: DeviceRunJob) {
    const execution = this.database.getDeviceRunExecution(job.taskId, job.runId)
    if (!execution) throw new Error(`设备执行不存在：${job.runId}`)
    if (execution.taskStatus === 'cancelled' || execution.runStatus !== 'queued') return
    if (!execution.endpointId || !execution.connectionKind || !execution.deviceSerial) {
      throw new Error(`设备执行尚未解析 ADB Endpoint：${job.runId}`)
    }

    const runner = new AdbRunExecutor(
      this.database, execution, this.mediaIntegrityChecker, this.appConfig, this.processRunner,
    )
    this.active.set(job.runId, runner)
    try {
      await runner.execute()
    } finally {
      this.active.delete(job.runId)
    }
  }

  cancelTask(taskId: string) {
    for (const runner of this.active.values()) {
      if (runner.taskId === taskId) runner.cancel()
    }
  }
}

export interface AdbExecutionDevice {
  connectionStatus(): Promise<'online' | 'offline' | 'unauthorized'>
  run(args: string[], signal: AbortSignal, timeoutMs?: number, code?: string): Promise<Awaited<ReturnType<AdbDeviceClient['run']>>>
  observe(args: string[], signal: AbortSignal, timeoutMs?: number, capture?: { captureStdoutPath?: string; captureStderrPath?: string }): Promise<Awaited<ReturnType<AdbDeviceClient['observe']>>>
  stat(remotePath: string, signal: AbortSignal): Promise<AdbObservation<number>>
  exists(remotePath: string, signal: AbortSignal): Promise<AdbObservation<boolean>>
  isPackageRunning(packageName: string, signal: AbortSignal): Promise<AdbObservation<boolean>>
  isPackageInstalled(packageName: string, signal: AbortSignal): Promise<boolean>
}

export interface AdbExecutionStreams {
  startLogcat(
    taskId: string,
    targetPath: string,
    signal: AbortSignal,
    tags: readonly string[],
    onLine: (line: string) => void,
    onEvent?: (event: LogcatStreamEvent) => void,
    maxBytes?: number,
  ): Promise<() => Promise<void>>
  captureLogcatSnapshot(taskId: string, targetPath: string, signal: AbortSignal, maxBytes: number): Promise<void>
  captureScreenshot(taskId: string, targetPath: string, signal: AbortSignal): Promise<void>
}

export interface AdbRunExecutorDependencies {
  createDevice?: (adbPath: string, serial: string, runner: ProcessRunner) => AdbExecutionDevice
  createStreams?: (adbPath: string, serial: string, processes: TaskProcessRegistry, options: { maxLogBytes: number; killGraceMs: number }) => AdbExecutionStreams
  createAppPreparer?: (device: AdbExecutionDevice, captureScreenshot: (targetPath: string, signal: AbortSignal) => Promise<void>) => AndroidAppPreparer
}

export function parseCarrierResult(content: string): AndroidResult {
  if (!content.trim()) {
    throw new TaskExecutionError('APK 返回的 result.json 为空', 'RESULT_INVALID')
  }

  let result: unknown
  try {
    result = JSON.parse(content)
  } catch (error) {
    throw new TaskExecutionError(
      `APK 返回的 result.json 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      'RESULT_INVALID',
    )
  }

  if (
    !result
    || typeof result !== 'object'
    || Array.isArray(result)
    || typeof (result as { taskId?: unknown }).taskId !== 'string'
    || !['passed', 'failed'].includes((result as { status?: unknown }).status as string)
  ) {
    throw new TaskExecutionError('APK 返回的 result.json 缺少有效的 taskId 或 status', 'RESULT_INVALID')
  }

  return result as AndroidResult
}


export class AdbRunExecutor {
  readonly taskId: string
  private readonly runId: string
  private readonly processes: TaskProcessRegistry
  private readonly device: AdbExecutionDevice
  private readonly streams: AdbExecutionStreams
  private readonly appPreparer: AndroidAppPreparer

  constructor(
    private readonly database: PlatformDatabase,
    private readonly execution: DeviceRunExecution,
    private readonly mediaIntegrityChecker: MediaIntegrityChecker,
    private readonly appConfig: AppConfig,
    private readonly processRunner: ProcessRunner,
    private readonly dependencies: AdbRunExecutorDependencies = {},
  ) {
    this.taskId = execution.taskId
    this.runId = execution.runId
    this.processes = new TaskProcessRegistry(appConfig.processKillGraceMs)
    this.device = dependencies.createDevice?.(appConfig.adbPath, execution.deviceSerial, processRunner)
      ?? new AdbDeviceClient(appConfig.adbPath, execution.deviceSerial, processRunner)
    this.streams = dependencies.createStreams?.(appConfig.adbPath, execution.deviceSerial, this.processes, {
      maxLogBytes: appConfig.maxLogcatBytes,
      killGraceMs: appConfig.processKillGraceMs,
    }) ?? new AdbStreams(appConfig.adbPath, execution.deviceSerial, this.processes, {
      maxLogBytes: appConfig.maxLogcatBytes,
      killGraceMs: appConfig.processKillGraceMs,
    })
    this.appPreparer = dependencies.createAppPreparer?.(
      this.device,
      (targetPath, signal) => this.streams.captureScreenshot(this.runId, targetPath, signal),
    ) ?? new DefaultAndroidAppPreparer({
      createDevice: () => this.device,
      captureScreenshot: (targetPath, signal) => this.streams.captureScreenshot(
        this.runId,
        targetPath,
        signal,
      ),
    })
  }

  cancel() {
    this.processes.abort(this.runId)
    this.processes.killChildren(this.runId)
    const packageName = this.processes.packageName(this.runId) || this.execution.apkPackageName
    if (packageName) {
      void this.bestEffortDeviceRun(
        ['shell', 'am', 'force-stop', packageName],
        '取消任务时停止 APK 失败',
      )
    }
  }

  async execute() {
    const execution = this.execution
    const { taskId, runId } = execution

    const protocol = findApkExecutionProtocol(execution.apkPackageName)
    if (!protocol) {
      this.database.setExecutionState({
        taskId,
        runId: execution.runId,
        taskStatus: 'failed',
        runStatus: 'failed',
        progress: 100,
        finished: true,
        executionStatus: 'failed', executionFailureCode: 'UNSUPPORTED_APK_PROTOCOL',
        failureCode: 'UNSUPPORTED_APK_PROTOCOL',
        failureMessage: `APK 包名 ${execution.apkPackageName || '未知'} 没有执行协议`,
      })
      return
    }

    const controller = new AbortController()
    const signal = controller.signal
    this.processes.begin(runId, controller, protocol.packageName)

    const localRunDir = path.join(this.appConfig.tasksDir, taskId, 'device-runs', runId)
    const localResult = path.join(localRunDir, 'result.json')
    const localOutput = path.join(localRunDir, 'output.mp4')
    const localLogcat = path.join(localRunDir, 'logcat.txt')
    const screenshotDir = path.join(localRunDir, 'screenshots')
    const diagnosticsDirectory = path.join(localRunDir, 'diagnostics')
    let paths: ApkExecutionPaths | undefined
    let detectedRemoteOutputFile: string | undefined
    let protocolFailure: string | undefined
    let stopLogcat: (() => Promise<void>) | undefined
    let logcatWarning: string | undefined
    let businessStarted = false
    let acceptMorphoStartupEvidence = false
    let morphoBusinessLogStarted = false
    let logcatFatal: TaskExecutionError | undefined
    let morphoStartupProbeAttempt = 0

    const update = (phase: DeviceRunPhase, progress: number, message: string) => {
      this.database.setExecutionState({
        taskId, runId, taskStatus: 'running', runStatus: 'running', phase, progress,
      })
      this.database.addLog(taskId, runId, message)
    }

    try {
      await mkdir(screenshotDir, { recursive: true })
      this.database.setExecutionState({
        taskId, runId, taskStatus: 'running', runStatus: 'running',
        phase: 'validating_device', progress: 2, started: true,
        executionStatus: 'running', executionFailureCode: null,
        failureCode: null, failureMessage: null,
      })
      this.database.addLog(taskId, runId, `开始检查 ADB 真机连接；执行协议：${protocol.name}`)

      const deviceStatus = await this.device.connectionStatus()
      if (deviceStatus === 'unauthorized') {
        throw new TaskExecutionError(`${execution.deviceName} 尚未授权此电脑，请在手机上确认 USB 调试授权`, 'DEVICE_UNAUTHORIZED')
      }
      if (deviceStatus !== 'online') {
        throw new TaskExecutionError(`${execution.deviceName} 未连接或 ADB 状态异常`, 'DEVICE_OFFLINE')
      }

      update('validating_apk', 8, `正在校验 APK 执行协议：${protocol.id}`)
      const manufacturer = (await this.adb(['shell', 'getprop', 'ro.product.manufacturer'], signal)).stdout.trim()
      const model = (await this.adb(['shell', 'getprop', 'ro.product.model'], signal)).stdout.trim()
      paths = buildExecutionPaths(protocol, {
        taskId,
        manufacturer,
        model,
        inputFileName: execution.videoOriginalName,
      })
      detectedRemoteOutputFile = paths.remoteOutputFile

      const preparationStartedAt = Date.now()
      const preparation = await this.appPreparer.prepareApplication({
        deviceSerial: execution.deviceSerial,
        deviceManufacturer: manufacturer,
        deviceModel: model,
        apkPath: execution.apkPath,
        protocol,
        diagnosticsDirectory,
        signal,
        onEvent: (event) => update(event.phase, event.progress ?? 15, event.message),
      })
      if (logcatFatal) throw logcatFatal
      this.database.addLog(
        taskId,
        runId,
        `应用准备完成：${preparation.cleanInstalled ? '干净安装' : '覆盖安装'}；`
          + `已授权 ${preparation.grantedPermissions.length} 项权限；`
          + `自动处理 ${preparation.handledDialogs.length} 个系统弹窗；`
          + `APK 安装耗时=${preparation.timings.installMs}ms；`
          + `权限与启动前兼容处理耗时=${preparation.timings.permissionMs}ms；`
          + `应用准备总耗时=${Date.now() - preparationStartedAt}ms`,
      )

      update('transferring_input', 25, '正在准备 APK 输入目录并清理本次旧结果')
      const transferStartedAt = Date.now()
      await this.prepareRemotePaths(protocol, paths, signal)
      await this.adb(['push', execution.videoPath, paths.remoteInputFile], signal, 180_000, 'INPUT_PUSH_FAILED')
      const remoteSize = await this.remoteStat(paths.remoteInputFile, signal)
      const localSize = (await stat(execution.videoPath)).size
      if (!Number.isFinite(remoteSize) || remoteSize !== localSize) {
        throw new TaskExecutionError('手机端输入 MP4 大小与上传文件不一致', 'INPUT_PUSH_FAILED')
      }
      this.database.upsertCheck(runId, {
        key: 'input', name: '输入 MP4 校验', status: 'passed', message: `${localSize} bytes`,
      })
      this.database.addLog(taskId, runId, `视频上传与远端校验耗时=${Date.now() - transferStartedAt}ms`)


      const launchReadiness = new AndroidDeviceReadiness(this.device)
      const launchObservation = await launchReadiness.prepare(signal)
      if (launchObservation.condition !== 'ready') {
        this.database.addLog(
          taskId,
          runId,
          `DEVICE_READINESS condition=${launchObservation.condition} evidence=${launchObservation.summary} phase=before_final_launch`,
          'warning',
        )
      }

      await this.assertLogcatDiskSpace(localRunDir)
      const logTags = protocol.progress.logTags ?? [protocol.progress.logTag]
      try {
        stopLogcat = await this.startLogcat(
          runId,
          localLogcat,
          signal,
          logTags,
          (line) => {
            if (protocol.progress.mode === 'structured_log') {
              this.consumeStructuredEvent(taskId, runId, line)
              return
            }

            const event = parseMorphoLogLine(line)
            if (!event || !acceptMorphoStartupEvidence) return
            if (event.businessStarted) morphoBusinessLogStarted = true
            if (event.message) this.database.addLog(taskId, runId, event.message, event.failureMessage ? 'error' : 'info')
            if (event.failureMessage) protocolFailure = event.failureMessage
            if (event.outputPath && paths && isDirectRemoteChild(paths.remoteOutputDirectory, event.outputPath)) {
              detectedRemoteOutputFile = event.outputPath
              this.database.addLog(taskId, runId, `Morpho 实际输出路径：${event.outputPath}`)
            }
            if (typeof event.progress === 'number') {
              this.database.setExecutionState({
                taskId, runId, taskStatus: 'running', runStatus: 'running',
                phase: 'processing', progress: event.progress,
              })
            }
          },
          (event) => {
            logcatWarning = this.describeLogcatEvent(event)
            this.database.addLog(taskId, runId, logcatWarning, 'warning')
            if (!businessStarted && (event.type === 'process_exited' || event.type === 'write_failed')) {
              logcatFatal = new TaskExecutionError(logcatWarning, 'LOGCAT_START_FAILED')
            }
          },
        )
      } catch (error) {
        throw new TaskExecutionError(
          `无法启动设备 ${execution.deviceSerial} 的业务 Logcat：${error instanceof Error ? error.message : String(error)}`,
          'LOGCAT_START_FAILED',
        )
      }
      this.database.addLog(
        taskId,
        runId,
        `开始采集设备 ${execution.deviceSerial} 的过滤业务 Logcat：${logTags.join(', ')}`,
      )
      // Allow the filtered stream to drain any pre-existing matching line, then
      // accept startup evidence only from the final business launch onward.
      await delay(100, signal)

      if (logcatFatal) throw logcatFatal
      update('launching_app', 35, `正在按 ${protocol.name} 启动 APK`)
      acceptMorphoStartupEvidence = true
      const startupStartedAt = Date.now()
      await this.adb(buildLaunchArguments(protocol, paths, taskId), signal, 30_000, 'APP_LAUNCH_FAILED')

      if (protocol.id === 'morpho-video-postprocessor-batch-v2') {
        const startupEvidence = await waitForMorphoStartup({
          signal,
          hasBusinessLog: () => morphoBusinessLogStarted,
          getLogcatFailure: () => logcatFatal,
          inspect: async (remainingMs) => collectMorphoStartupInspection({
            packageName: protocol.packageName,
            diagnosticsDirectory,
            attempt: ++morphoStartupProbeAttempt,
            remainingMs,
            signal,
            runner: {
              run: (args, probeSignal, timeoutMs, capture) => this.device.observe(
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
            this.database.addLog(
              taskId,
              runId,
              `Morpho 启动探测证据不完整，继续等待业务证据：${observation.summary}`,
              'warning',
            )
          },
        })
        businessStarted = true
        this.database.addLog(
          taskId,
          runId,
          `Morpho 启动握手通过；证据=${startupEvidence}；耗时=${Date.now() - startupStartedAt}ms`,
        )
      } else {
        if (logcatFatal) throw logcatFatal
        businessStarted = true
      }
      this.database.upsertCheck(runId, { key: 'launch', name: '应用启动', status: 'passed' })

      update('processing', 45, protocol.id === 'morpho-video-postprocessor-batch-v2'
        ? 'Morpho 业务启动已确认，等待批处理完成标记和稳定后视频'
        : 'APK 已自动启动，等待真实 SDK 生成 result.json 和 output.mp4')

      const processingStartedAt = Date.now()
      if (protocol.completion.mode === 'result_json') {
        if (!paths.remoteResultFile) throw new TaskExecutionError('协议缺少 result.json 路径', 'INVALID_TEST_APK')
        await this.waitForResultJson(taskId, protocol, paths.remoteResultFile, execution.timeoutSeconds * 1000, signal)
        await this.collectCarrierResult(taskId, runId, paths, localResult, signal)
      } else {
        const effectiveTimeoutSeconds = resolveProtocolTimeoutSeconds(protocol, execution.timeoutSeconds)
        await this.waitForMorphoCompletion(
          taskId,
          protocol,
          paths,
          effectiveTimeoutSeconds * 1000,
          signal,
          () => protocolFailure,
          () => detectedRemoteOutputFile ?? paths!.remoteOutputFile,
        )
        this.database.upsertCheck(runId, {
          key: 'processing', name: 'SDK 视频处理', status: 'passed',
          message: 'Morpho 完成标记、日志和输出文件联合校验通过',
        })
      }
      this.database.addLog(taskId, runId, `SDK 处理耗时=${Date.now() - processingStartedAt}ms`)

      update('validating_output', 78, '正在验证 APK 生成的输出 MP4')
      const outputCollectionStartedAt = Date.now()
      const remoteOutputFile = detectedRemoteOutputFile ?? paths.remoteOutputFile
      const outputStat = await this.remoteStat(remoteOutputFile, signal)
      if (outputStat <= 0) {
        throw new TaskExecutionError(
          `APK 未生成有效输出：${remoteOutputFile}`,
          outputStat === 0 ? 'OUTPUT_EMPTY' : 'OUTPUT_MISSING',
        )
      }

      update('collecting_output', 88, '正在从手机拉取处理后的 MP4，并在平台统一保存为 output.mp4')
      await this.adb(['pull', remoteOutputFile, localOutput], signal, 180_000, 'OUTPUT_MISSING')
      const outputLocalStat = await stat(localOutput)
      if (outputLocalStat.size <= 0) throw new TaskExecutionError('拉取的输出 MP4 为空', 'OUTPUT_EMPTY')
      const outputSha256 = await sha256File(localOutput)
      this.database.addOutput({
        taskId, runId, storagePath: localOutput, sizeBytes: outputLocalStat.size, sha256: outputSha256,
      })
      this.database.upsertCheck(runId, {
        key: 'output_generated', name: '输出 MP4 生成', status: 'passed',
        message: `${outputLocalStat.size} bytes；手机原始路径：${remoteOutputFile}`,
      })
      this.database.setExecutionState({
        taskId, runId, executionStatus: 'passed', executionFailureCode: null,
      })
      const mediaIntegrity = await this.mediaIntegrityChecker.check(localOutput, signal)
      this.database.recordMediaIntegrity(runId, mediaIntegrity)
      this.database.upsertCheck(runId, {
        key: 'media_integrity', name: '输出视频基础完整性', status: mediaIntegrity.status,
        message: mediaIntegrity.message,
      })
      if (mediaIntegrity.status === 'failed') {
        throw new TaskExecutionError(mediaIntegrity.message, mediaIntegrity.failureCode ?? 'MEDIA_INTEGRITY_FAILED')
      }

      if (!protocol.result.apkGeneratesResultJson) {
        await this.writeBackendResult({
          taskId,
          protocol,
          localResult,
          inputSizeBytes: localSize,
          inputName: execution.videoOriginalName,
          outputSizeBytes: outputLocalStat.size,
          outputSha256,
          remoteOutputFile,
        })
      }
      this.database.addLog(taskId, runId, `输出验证与回收耗时=${Date.now() - outputCollectionStartedAt}ms`)

      update('generating_report', 96, '正在保存日志、截图和兼容性报告')
      // Screenshot collection is part of the test evidence boundary. Keep
      // Logcat alive until it completes, then stop only this run's process
      // before device cleanup begins in finally.
      await this.captureScreenshot(runId, path.join(screenshotDir, 'final.png'), signal).catch(() => undefined)
      if (stopLogcat) {
        try {
          await stopLogcat()
        } catch (error) {
          logcatWarning = `LOGCAT_WRITE_FAILED：${error instanceof Error ? error.message : String(error)}`
          this.database.addLog(taskId, runId, logcatWarning, 'warning')
        }
        stopLogcat = undefined
      }
      this.database.setExecutionState({
        taskId, runId, taskStatus: 'passed', runStatus: 'passed',
        phase: 'completed', progress: 100, finished: true,
        executionStatus: 'passed', executionFailureCode: null,
      })
      this.database.addLog(
        taskId,
        runId,
        `真实 APK 处理完成；协议 ${protocol.id}；输出 MP4 已回收到平台${logcatWarning ? `；Logcat 告警：${logcatWarning}` : ''}`,
      )
    } catch (error) {
      const cancelled = signal.aborted || this.database.isCancelled(taskId)
      const failureCode = cancelled
        ? 'TASK_CANCELLED'
        : error instanceof TaskExecutionError
          ? error.code
          : 'SDK_PROCESSING_FAILED'
      const failureMessage = cancelled ? '用户取消任务' : error instanceof Error ? error.message : String(error)
      if (!cancelled) {
        if (stopLogcat) {
          await stopLogcat().catch((stopError) => {
            this.database.addLog(
              taskId,
              runId,
              `LOGCAT_WRITE_FAILED：${stopError instanceof Error ? stopError.message : String(stopError)}`,
              'warning',
            )
          })
          stopLogcat = undefined
        }
        await this.streams.captureLogcatSnapshot(
          runId,
          path.join(diagnosticsDirectory, 'logcat-full-failure.txt'),
          signal,
          16 * 1024 * 1024,
        ).catch((snapshotError) => {
          this.database.addLog(
            taskId,
            runId,
            `失败 Logcat 快照采集失败：${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}`,
            'warning',
          )
        })
        this.database.setExecutionState({
          taskId, runId, taskStatus: 'failed', runStatus: 'failed',
          progress: 100, finished: true, failureCode, failureMessage,
          executionStatus: failureCode.startsWith('MEDIA_') ? 'passed' : 'failed',
          executionFailureCode: failureCode.startsWith('MEDIA_') ? null : failureCode,
        })
        this.database.addLog(taskId, runId, `${failureCode}：${failureMessage}`, 'error')
      }
      await writeFile(localLogcat, '', { flag: 'a' }).catch(() => undefined)
    } finally {
      if (stopLogcat) {
        await stopLogcat().catch((error) => {
          this.database.addLog(taskId, runId, `LOGCAT_WRITE_FAILED：${error instanceof Error ? error.message : String(error)}`, 'warning')
        })
      }
      await this.bestEffortDeviceRun(
        ['shell', 'am', 'force-stop', protocol.packageName],
        '执行结束时停止 APK 失败',
      )

      if (paths) {
        if (protocol.completion.mode === 'result_json') {
          await this.bestEffortDeviceRun(
            ['shell', 'rm', '-rf', paths.remoteTaskRoot],
            '清理 APK 远端任务目录失败',
          )
        } else {
          const cleanupFiles = [...new Set([
            paths.remoteCompletionPath,
            paths.remoteInputFile,
            paths.remoteOutputFile,
            detectedRemoteOutputFile,
          ].filter((value): value is string => Boolean(value)))]
          await this.bestEffortDeviceRun(
            ['shell', 'rm', '-f', ...cleanupFiles],
            '清理 Morpho 远端临时文件失败',
          )
        }
      }

      this.processes.clear(runId)
    }
  }

  private async prepareRemotePaths(
    protocol: ApkExecutionProtocol,
    paths: ApkExecutionPaths,
    signal: AbortSignal,
  ) {
    if (protocol.completion.mode === 'result_json') {
      await this.adb(['shell', 'rm', '-rf', paths.remoteTaskRoot], signal)
      await this.adb(['shell', 'mkdir', '-p', paths.remoteInputDirectory], signal)
      await this.adb(['shell', 'mkdir', '-p', paths.remoteOutputDirectory, `${paths.remoteTaskRoot}/result`], signal)
      return
    }

    // Morpho 必须使用厂商 Demo 约定的共享根目录，不能替换成平台自创的 tasks/{taskId} 目录。
    await this.adb(['shell', 'mkdir', '-p', paths.remoteInputDirectory], signal)
    await this.adb(['shell', 'rm', '-f', paths.remoteCompletionPath, paths.remoteInputFile], signal)
    if (protocol.output.clearDirectoryBeforeRun) {
      await this.adb(['shell', 'rm', '-rf', paths.remoteOutputDirectory], signal)
    } else {
      await this.adb(['shell', 'rm', '-f', paths.remoteOutputFile], signal)
    }
    if (!protocol.output.appCreatesDirectory) {
      await this.adb(['shell', 'mkdir', '-p', paths.remoteOutputDirectory], signal)
    }
  }

  private async collectCarrierResult(
    taskId: string,
    runId: string,
    paths: ApkExecutionPaths,
    localResult: string,
    signal: AbortSignal,
  ) {
    if (!paths.remoteResultFile) throw new TaskExecutionError('APK 协议缺少 result.json 路径', 'RESULT_MISSING')

    await this.adb(['pull', paths.remoteResultFile, localResult], signal, 30_000, 'RESULT_MISSING')
    const result = await this.readCarrierResult(localResult)
    if (result.taskId !== taskId) {
      throw new TaskExecutionError('APK 返回的 taskId 与当前任务不一致', 'RESULT_TASK_MISMATCH')
    }
    for (const check of result.checks ?? []) this.database.upsertCheck(runId, check)
    if (result.status !== 'passed') {
      throw new TaskExecutionError(
        result.failureMessage ?? '真实 SDK 视频处理失败',
        result.failureCode ?? 'SDK_PROCESSING_FAILED',
      )
    }
  }

  private async readCarrierResult(localResult: string): Promise<AndroidResult> {
    let content: string
    try {
      content = await readFile(localResult, 'utf8')
    } catch (error) {
      throw new TaskExecutionError(
        `无法读取 APK 返回的 result.json：${error instanceof Error ? error.message : String(error)}`,
        'RESULT_INVALID',
      )
    }
    return parseCarrierResult(content)
  }

  private async bestEffortDeviceRun(args: string[], description: string) {
    try {
      await this.device.run(args, new AbortController().signal, 30_000, 'DEVICE_CLEANUP_FAILED')
    } catch (error) {
      this.database.addLog(
        this.execution.taskId,
        this.execution.runId,
        `${description}：${error instanceof Error ? error.message : String(error)}`,
        'warning',
      )
    }
  }

  private async writeBackendResult(input: {
    taskId: string
    protocol: ApkExecutionProtocol
    localResult: string
    inputSizeBytes: number
    inputName: string
    outputSizeBytes: number
    outputSha256: string
    remoteOutputFile: string
  }) {
    await writeFile(input.localResult, JSON.stringify({
      protocolVersion: 1,
      taskId: input.taskId,
      status: 'passed',
      source: 'backend-synthesized',
      protocolId: input.protocol.id,
      packageName: input.protocol.packageName,
      adapter: 'MorphoVideoPostProcessor',
      apkGeneratedResult: false,
      input: {
        name: input.inputName,
        sizeBytes: input.inputSizeBytes,
      },
      output: {
        name: 'output.mp4',
        originalRemotePath: input.remoteOutputFile,
        sizeBytes: input.outputSizeBytes,
        sha256: input.outputSha256,
      },
      checks: [
        { key: 'input', name: '输入 MP4 校验', status: 'passed' },
        { key: 'launch', name: '应用启动', status: 'passed' },
        { key: 'processing', name: 'SDK 视频处理', status: 'passed' },
        { key: 'output_generated', name: '输出 MP4 生成', status: 'passed' },
      ],
      generatedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
  }

  private adb(
    args: string[],
    signal: AbortSignal,
    timeoutMs = 30_000,
    code = 'SDK_PROCESSING_FAILED',
  ) {
    return this.device.run(args, signal, timeoutMs, code)
  }

  private async remoteStat(remotePath: string, signal: AbortSignal) {
    const observation = await this.device.stat(remotePath, signal)
    return this.requireObservationValue(observation, -1)
  }

  private async remoteExists(remotePath: string, signal: AbortSignal) {
    const observation = await this.device.exists(remotePath, signal)
    return this.requireObservationValue(observation, false)
  }

  private async isPackageRunning(packageName: string, signal: AbortSignal) {
    const observation = await this.device.isPackageRunning(packageName, signal)
    return this.requireObservationValue(observation, false)
  }

  private requireObservationValue<T>(observation: AdbObservation<T>, absentValue: T): T {
    if (observation.kind === 'present') return observation.value
    if (observation.kind === 'absent') return absentValue
    throw observation.error
  }

  private async waitForResultJson(
    taskId: string,
    protocol: ApkExecutionProtocol,
    remoteResult: string,
    timeoutMs: number,
    signal: AbortSignal,
  ) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (this.database.isCancelled(taskId)) throw new DOMException('任务已取消', 'AbortError')
      // The carrier's result path is the completion marker. Once it exists,
      // pull it and classify empty/malformed content as RESULT_INVALID instead
      // of hiding the protocol violation behind a later timeout.
      if (await this.remoteStat(remoteResult, signal) >= 0) return

      if (Date.now() - startedAt > 2_000 && !await this.isPackageRunning(protocol.packageName, signal)) {
        throw new TaskExecutionError('测试 APK 进程已退出，且未生成 result.json', 'APP_CRASHED')
      }
      await delay(this.appConfig.pollIntervalMs, signal)
    }
    throw new TaskExecutionError(`超过 ${Math.round(timeoutMs / 1000)} 秒仍未收到 result.json`, 'TASK_TIMEOUT')
  }

  private async waitForMorphoCompletion(
    taskId: string,
    protocol: ApkExecutionProtocol,
    paths: ApkExecutionPaths,
    timeoutMs: number,
    signal: AbortSignal,
    getFailure: () => string | undefined,
    getOutputFile: () => string,
  ) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (this.database.isCancelled(taskId)) throw new DOMException('任务已取消', 'AbortError')

      const failure = getFailure()
      if (failure) throw new TaskExecutionError(`Morpho SDK 处理失败：${failure}`, 'SDK_PROCESSING_FAILED')

      if (await this.remoteExists(paths.remoteCompletionPath, signal)) {
        const size = await this.remoteStat(getOutputFile(), signal)
        if (size < 0) {
          throw new TaskExecutionError('Morpho 已结束批处理，但没有生成本次稳定后视频', 'OUTPUT_MISSING')
        }
        if (size === 0) {
          throw new TaskExecutionError('Morpho 已生成输出文件，但文件大小为 0', 'OUTPUT_EMPTY')
        }
        return
      }

      if (Date.now() - startedAt > 3_000 && !await this.isPackageRunning(protocol.packageName, signal)) {
        throw new TaskExecutionError('Morpho 进程已退出，且没有生成完成标记', 'APP_CRASHED')
      }
      await delay(this.appConfig.pollIntervalMs, signal)
    }
    throw new TaskExecutionError(
      `超过 ${Math.round(timeoutMs / 1000)} 秒仍未检测到 Morpho 完成标记`,
      'TASK_TIMEOUT',
    )
  }

  private consumeStructuredEvent(taskId: string, runId: string, line: string) {
    const jsonStart = line.indexOf('{')
    if (jsonStart < 0) return
    try {
      const event = JSON.parse(line.slice(jsonStart)) as AndroidCheckEvent
      if (event.taskId !== taskId) return
      if (event.message) this.database.addLog(taskId, runId, event.message)
      if (event.checkKey && event.status && event.status !== 'running') {
        this.database.upsertCheck(runId, {
          key: event.checkKey,
          name: event.name ?? getCheckName(event.checkKey),
          status: event.status,
          durationMs: event.durationMs,
          message: event.message,
        })
      }
      if (typeof event.progress === 'number') {
        const progress = Math.max(45, Math.min(75, event.progress))
        this.database.setExecutionState({
          taskId, runId, taskStatus: 'running', runStatus: 'running',
          phase: 'processing', progress,
        })
      }
    } catch {
      // 非结构化 SDK_COMPAT 行仍保存在 logcat.txt 中。
    }
  }

  private async assertLogcatDiskSpace(localRunDir: string) {
    await mkdir(localRunDir, { recursive: true })
    const disk = await statfs(localRunDir)
    const availableBytes = disk.bavail * disk.bsize
    const requiredBytes = this.appConfig.minFreeDiskBytes + Math.min(this.appConfig.maxLogcatBytes, 16 * 1024 * 1024)
    if (availableBytes < requiredBytes) {
      throw new TaskExecutionError(
        `Logcat 磁盘空间不足：当前 ${availableBytes} 字节，需要至少 ${requiredBytes} 字节`,
        'INSUFFICIENT_LOGCAT_DISK_SPACE',
      )
    }
  }

  private describeLogcatEvent(event: LogcatStreamEvent) {
    if (event.type === 'truncated') return `LOGCAT_TRUNCATED：日志达到 ${event.maxBytes} 字节上限，已停止当前设备的日志采集，业务测试继续`
    if (event.type === 'write_failed') return `LOGCAT_WRITE_FAILED：${event.error.message}`
    const detail = event.stderr ? `；${event.stderr}` : ''
    return `LOGCAT_PROCESS_EXITED：Logcat 进程异常退出（code=${event.code ?? 'null'}，signal=${event.signal ?? 'null'}）${detail}`
  }

  private startLogcat(
    executionKey: string,
    targetPath: string,
    signal: AbortSignal,
    tags: readonly string[],
    onLine: (line: string) => void,
    onEvent: (event: LogcatStreamEvent) => void,
  ) {
    return this.streams.startLogcat(
      executionKey,
      targetPath,
      signal,
      tags,
      onLine,
      onEvent,
      Math.min(this.appConfig.maxLogcatBytes, 16 * 1024 * 1024),
    )
  }

  private captureScreenshot(executionKey: string, targetPath: string, signal: AbortSignal) {
    return this.streams.captureScreenshot(executionKey, targetPath, signal)
  }
}
