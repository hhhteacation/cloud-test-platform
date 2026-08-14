import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  buildExecutionPaths,
  findApkExecutionProtocol,
} from './apk-protocols.js'
import { config as defaultConfig, type AppConfig } from './config.js'
import { PlatformDatabase, type DeviceRunExecution, type DeviceRunJob, type VideoRunExecution } from './database.js'
import { MediaIntegrityChecker } from './media-integrity.js'
import { BoundedProcessRunner, type ProcessRunner } from './process.js'
import { TaskExecutionError } from './execution/execution-errors.js'
import { createExecutionFailure, executionFailureFromError, type ExecutionFailure } from './execution/execution-failures.js'
import {
  ANDROID_DIALOG_PROFILE_VERSION,
  buildAttemptManifest,
  captureAndroidDeviceSnapshot,
  readSourceIdentity,
  writeAttemptManifest,
  type SourceIdentity,
} from './execution/attempt-manifest.js'
import { AdbDeviceClient } from './execution/adb-client.js'
import { AdbStreams } from './execution/adb-streams.js'
import { AttemptEvidenceRecorder } from './execution/attempt-evidence-recorder.js'
import { TaskProcessRegistry } from './execution/process-registry.js'
import { createProtocolExecutor } from './execution/protocol-executor-factory.js'
import type {
  ProtocolExecutionDevice,
  ProtocolExecutionStreams,
  ProtocolExecutor,
  ProtocolExecutorDependencies,
} from './execution/protocol-executor.js'
import {
  DefaultAndroidAppPreparer,
  type AndroidAppPreparer,
} from './execution/android-app-preparation/index.js'
import { AndroidDeviceReadiness } from './execution/android-app-preparation/device-readiness.js'
import type { DeviceRunPhase } from './types.js'

export { parseCarrierResult } from './execution/carrier-protocol-executor.js'

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
    private readonly recoverExecution?: (job: DeviceRunJob) => Promise<DeviceRunExecution | undefined>,
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
      { recoverExecution: this.recoverExecution ? () => this.recoverExecution!(job) : undefined },
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

export interface AdbExecutionDevice extends ProtocolExecutionDevice {
  connectionStatus(): Promise<'online' | 'offline' | 'unauthorized'>
  isPackageInstalled(packageName: string, signal: AbortSignal): Promise<boolean>
}

export interface AdbExecutionStreams extends ProtocolExecutionStreams {
  captureScreenshot(taskId: string, targetPath: string, signal: AbortSignal): Promise<void>
}

export interface AdbRunExecutorDependencies {
  createDevice?: (adbPath: string, serial: string, runner: ProcessRunner) => AdbExecutionDevice
  createStreams?: (adbPath: string, serial: string, processes: TaskProcessRegistry, options: { maxLogBytes: number; killGraceMs: number }) => AdbExecutionStreams
  createAppPreparer?: (device: AdbExecutionDevice, captureScreenshot: (targetPath: string, signal: AbortSignal) => Promise<void>) => AndroidAppPreparer
  createProtocolExecutor?: (
    dependencies: ProtocolExecutorDependencies,
  ) => ProtocolExecutor
  readSourceIdentity?: () => Promise<SourceIdentity>
  recoverExecution?: () => Promise<DeviceRunExecution | undefined>
  now?: () => Date
}

interface VideoAttemptOutcome {
  passed: boolean
  cancelled: boolean
  failure?: ExecutionFailure
}

export class AdbRunExecutor {
  readonly taskId: string
  private readonly runId: string
  private readonly processes: TaskProcessRegistry
  private execution: DeviceRunExecution
  private device!: AdbExecutionDevice
  private streams!: AdbExecutionStreams
  private appPreparer!: AndroidAppPreparer
  private activeExecutionKey?: string

  constructor(
    private readonly database: PlatformDatabase,
    execution: DeviceRunExecution,
    private readonly mediaIntegrityChecker: MediaIntegrityChecker,
    private readonly appConfig: AppConfig,
    private readonly processRunner: ProcessRunner,
    private readonly dependencies: AdbRunExecutorDependencies = {},
  ) {
    this.execution = execution
    this.taskId = execution.taskId
    this.runId = execution.runId
    this.processes = new TaskProcessRegistry(appConfig.processKillGraceMs)
    this.bindRuntime(execution)
  }

  private bindRuntime(execution: DeviceRunExecution) {
    this.execution = execution
    this.device = this.dependencies.createDevice?.(this.appConfig.adbPath, execution.deviceSerial, this.processRunner)
      ?? new AdbDeviceClient(this.appConfig.adbPath, execution.deviceSerial, this.processRunner)
    this.streams = this.dependencies.createStreams?.(
      this.appConfig.adbPath,
      execution.deviceSerial,
      this.processes,
      { maxLogBytes: this.appConfig.maxLogcatBytes, killGraceMs: this.appConfig.processKillGraceMs },
    ) ?? new AdbStreams(
      this.appConfig.adbPath,
      execution.deviceSerial,
      this.processes,
      { maxLogBytes: this.appConfig.maxLogcatBytes, killGraceMs: this.appConfig.processKillGraceMs },
    )
    this.appPreparer = this.dependencies.createAppPreparer?.(
      this.device,
      (targetPath, signal) => this.streams.captureScreenshot(this.activeExecutionKey ?? this.runId, targetPath, signal),
    ) ?? new DefaultAndroidAppPreparer({
      createDevice: () => this.device,
      captureScreenshot: (targetPath, signal) => this.streams.captureScreenshot(
        this.activeExecutionKey ?? this.runId,
        targetPath,
        signal,
      ),
    })
  }

  cancel() {
    const executionKey = this.activeExecutionKey ?? this.runId
    this.processes.abort(executionKey)
    this.processes.killChildren(executionKey)
    const packageName = this.processes.packageName(executionKey) || this.execution.apkPackageName
    if (packageName) {
      void this.bestEffortDeviceRun(
        ['shell', 'am', 'force-stop', packageName],
        '取消任务时停止 APK 失败',
      )
    }
  }

  async execute() {
    const pendingVideos = this.execution.videos.filter((video) => video.runStatus === 'queued')
    for (const video of pendingVideos) {
      if (this.database.isCancelled(this.taskId)) return
      let attemptNumber = 0
      while (attemptNumber < 2) {
        attemptNumber += 1
        const attemptDirectory = this.localAttemptDirectory(video, attemptNumber)
        const attempt = this.database.createVideoAttempt(video.videoRunResultId, {
          evidenceDirectory: attemptDirectory,
        })
        const outcome = await this.executeVideoAttempt(video, attempt.id, attempt.attemptNumber, attemptDirectory)
        if (outcome.cancelled) return
        if (outcome.passed) {
          this.database.finishVideoAttempt(attempt.id, { status: 'passed' })
          break
        }

        this.database.finishVideoAttempt(attempt.id, { status: 'failed', failure: outcome.failure })
        if (outcome.failure?.code === 'UNSUPPORTED_APK_PROTOCOL') return
        if (!outcome.failure || !this.isRecoverableInfrastructureFailure(outcome.failure)) break
        if (attemptNumber >= 2) {
          this.blockLaterVideos(video, outcome.failure)
          return
        }

        this.database.addVideoLog(
          this.taskId,
          this.runId,
          video.videoRunResultId,
          `${outcome.failure.code}：准备恢复设备连接并重试当前视频（最多一次）`,
          'warning',
        )
        const recovered = await this.recoverConnection()
        if (!recovered) {
          this.blockLaterVideos(video, outcome.failure)
          return
        }
      }
    }
  }

  private localAttemptDirectory(video: VideoRunExecution, attemptNumber: number) {
    const runRoot = path.join(this.appConfig.tasksDir, this.taskId, 'device-runs', this.runId)
    // Preserve the historical single-video evidence path while isolating every multi-video attempt.
    if (this.execution.videos.length === 1 && attemptNumber === 1) return runRoot
    return path.join(runRoot, 'videos', video.taskVideoId, 'attempts', String(attemptNumber))
  }

  private blockLaterVideos(video: VideoRunExecution, failure: ExecutionFailure) {
    this.database.blockRemainingVideoResults({
      taskId: this.taskId,
      deviceRunId: this.runId,
      afterSequence: video.sequence,
      failure: createExecutionFailure({
        code: failure.code,
        phase: failure.phase,
        message: `设备连接恢复失败，后续视频未执行：${failure.message}`,
        evidenceRefs: failure.evidenceRefs,
      }),
    })
  }

  private isRecoverableInfrastructureFailure(failure: ExecutionFailure) {
    return failure.category === 'infrastructure'
      || (failure.category === 'device' && failure.retryability === 'safe')
  }

  private async recoverConnection() {
    try {
      const refreshed = await this.dependencies.recoverExecution?.()
      if (refreshed?.endpointId && refreshed.connectionKind && refreshed.deviceSerial) {
        this.bindRuntime(refreshed)
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
      return await this.device.connectionStatus() === 'online'
    } catch (error) {
      this.database.addLog(
        this.taskId,
        this.runId,
        `设备连接恢复失败：${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
      return false
    }
  }

  private async executeVideoAttempt(
    video: VideoRunExecution,
    attemptId: string,
    attemptNumber: number,
    localRunDir: string,
  ): Promise<VideoAttemptOutcome> {
    const execution = this.execution
    const { taskId, runId } = execution
    const protocol = findApkExecutionProtocol(execution.apkPackageName)
    let currentPhase: DeviceRunPhase = 'validating_device'
    const manifestAttemptId = execution.videos.length === 1 && attemptNumber === 1 ? runId : attemptId
    const attemptManifestPath = path.join(localRunDir, 'attempt-manifest.json')
    const deviceSnapshotPath = path.join(localRunDir, 'device-snapshot.json')
    let attemptManifest = await buildAttemptManifest({
      attemptId: manifestAttemptId,
      deviceSerial: execution.deviceSerial,
      deviceName: execution.deviceName,
      protocolId: protocol?.id ?? 'unsupported',
      profileVersion: ANDROID_DIALOG_PROFILE_VERSION,
      inputPath: video.videoPath,
      evidenceDirectory: localRunDir,
    }, {
      now: this.dependencies.now,
      readSourceIdentity: this.dependencies.readSourceIdentity
        ?? (() => readSourceIdentity(this.appConfig.rootDir)),
    })
    await writeAttemptManifest(attemptManifestPath, attemptManifest)

    if (!protocol) {
      currentPhase = 'validating_apk'
      const failure = createExecutionFailure({
        code: 'UNSUPPORTED_APK_PROTOCOL',
        phase: currentPhase,
        message: `APK 包名 ${execution.apkPackageName || '未知'} 没有执行协议`,
        evidenceRefs: [this.evidenceRef(localRunDir, 'attempt-manifest.json')],
      })
      this.database.setVideoExecutionState({
        videoRunResultId: video.videoRunResultId,
        runStatus: 'failed', phase: currentPhase, progress: 100, finished: true,
        executionStatus: 'failed', executionFailureCode: failure.code, failure,
      })
      this.blockLaterVideos(video, failure)
      return { passed: false, cancelled: false, failure }
    }

    const controller = new AbortController()
    const signal = controller.signal
    const executionKey = attemptId
    this.activeExecutionKey = executionKey
    this.processes.begin(executionKey, controller, protocol.packageName)

    const localResult = path.join(localRunDir, 'result.json')
    const localOutput = path.join(localRunDir, 'output.mp4')
    const localLogcat = path.join(localRunDir, 'logcat.txt')
    const screenshotDir = path.join(localRunDir, 'screenshots')
    const diagnosticsDirectory = path.join(localRunDir, 'diagnostics')
    let protocolExecutorOwnsCleanup = false
    const evidenceRecorder = new AttemptEvidenceRecorder({
      executionKey,
      runDirectory: localRunDir,
      maxLogcatBytes: this.appConfig.maxLogcatBytes,
      device: this.device,
      streams: this.streams,
      captureScreenshot: (targetPath, evidenceSignal) => this.streams.captureScreenshot(
        executionKey,
        targetPath,
        evidenceSignal,
      ),
      now: this.dependencies.now,
    })

    const update = (phase: DeviceRunPhase, progress: number, message: string) => {
      currentPhase = phase
      this.database.setVideoExecutionState({
        videoRunResultId: video.videoRunResultId,
        runStatus: 'running', phase, progress,
      })
      this.database.addVideoLog(taskId, runId, video.videoRunResultId, message)
    }

    try {
      await mkdir(screenshotDir, { recursive: true })
      this.database.setVideoExecutionState({
        videoRunResultId: video.videoRunResultId,
        runStatus: 'running', phase: 'validating_device', progress: 2, started: true,
        executionStatus: 'running', executionFailureCode: null, failure: null,
      })
      this.database.addVideoLog(
        taskId, runId, video.videoRunResultId,
        `开始检查 ADB 真机连接；视频 ${video.sequence + 1}/${execution.videos.length}；执行协议：${protocol.name}`,
      )

      const deviceStatus = await this.device.connectionStatus()
      const deviceSnapshot = await captureAndroidDeviceSnapshot(
        deviceStatus,
        (args) => this.device.observe(args, signal, 30_000),
      )
      await writeFile(deviceSnapshotPath, `${JSON.stringify(deviceSnapshot, null, 2)}\n`)
      attemptManifest = {
        ...attemptManifest,
        device: {
          serial: execution.deviceSerial,
          manufacturer: deviceSnapshot.manufacturer,
          model: deviceSnapshot.model,
          androidVersion: deviceSnapshot.androidVersion,
          buildFingerprint: deviceSnapshot.buildFingerprint,
        },
      }
      await writeAttemptManifest(attemptManifestPath, attemptManifest)
      if (deviceStatus === 'unauthorized') {
        throw new TaskExecutionError(`${execution.deviceName} 尚未授权此电脑，请在手机上确认 USB 调试授权`, 'DEVICE_UNAUTHORIZED')
      }
      if (deviceStatus !== 'online') {
        throw new TaskExecutionError(`${execution.deviceName} 未连接或 ADB 状态异常`, 'DEVICE_OFFLINE')
      }

      update('validating_apk', 8, `正在校验 APK 执行协议：${protocol.id}`)
      const manufacturer = (await this.adb(['shell', 'getprop', 'ro.product.manufacturer'], signal)).stdout.trim()
      const model = (await this.adb(['shell', 'getprop', 'ro.product.model'], signal)).stdout.trim()
      const remoteExecutionId = `${taskId}-${video.taskVideoId}-attempt-${attemptNumber}`
      const remoteInputName = protocol.launch.supportsTaskId
        ? video.videoOriginalName
        : `${video.taskVideoId}-attempt-${attemptNumber}-${video.videoOriginalName}`
      const paths = buildExecutionPaths(protocol, {
        taskId: remoteExecutionId,
        manufacturer,
        model,
        inputFileName: remoteInputName,
      })

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
      this.database.addVideoLog(
        taskId,
        runId,
        video.videoRunResultId,
        `应用准备完成：${preparation.cleanInstalled ? '干净安装' : '覆盖安装'}；`
          + `已授权 ${preparation.grantedPermissions.length} 项权限；`
          + `自动处理 ${preparation.handledDialogs.length} 个系统弹窗；`
          + `APK 安装耗时=${preparation.timings.installMs}ms；`
          + `权限与启动前兼容处理耗时=${preparation.timings.permissionMs}ms；`
          + `应用准备总耗时=${Date.now() - preparationStartedAt}ms`,
      )

      const launchReadiness = new AndroidDeviceReadiness(this.device)
      const launchObservation = await launchReadiness.prepare(signal)
      if (launchObservation.condition !== 'ready') {
        this.database.addVideoLog(
          taskId, runId, video.videoRunResultId,
          `DEVICE_READINESS condition=${launchObservation.condition} evidence=${launchObservation.summary} phase=before_final_launch`,
          'warning',
        )
      }

      const executorDependencies: ProtocolExecutorDependencies = {
        device: this.device,
        streams: this.streams,
        pollIntervalMs: this.appConfig.pollIntervalMs,
        maxLogcatBytes: this.appConfig.maxLogcatBytes,
        minFreeDiskBytes: this.appConfig.minFreeDiskBytes,
      }
      const protocolExecutor = this.dependencies.createProtocolExecutor?.(executorDependencies)
        ?? createProtocolExecutor(protocol, executorDependencies)

      const protocolStartedAt = Date.now()
      protocolExecutorOwnsCleanup = true
      const protocolResult = await protocolExecutor.execute({
        executionKey,
        taskId: remoteExecutionId,
        protocol,
        paths,
        input: {
          localPath: video.videoPath,
          originalName: video.videoOriginalName,
        },
        local: {
          runDirectory: localRunDir,
          resultPath: localResult,
          outputPath: localOutput,
          logcatPath: localLogcat,
          diagnosticsDirectory,
        },
        configuredTimeoutSeconds: execution.timeoutSeconds,
        signal,
        reporter: {
          update,
          addLog: (message, level = 'info') => this.database.addVideoLog(
            taskId, runId, video.videoRunResultId, message, level,
          ),
          setProcessingProgress: (progress) => this.database.setVideoExecutionState({
            videoRunResultId: video.videoRunResultId,
            runStatus: 'running', phase: 'processing', progress,
          }),
          upsertCheck: (check) => this.database.upsertVideoCheck(runId, video.videoRunResultId, check),
          isCancelled: () => this.database.isCancelled(taskId),
        },
      })
      this.database.addVideoLog(
        taskId, runId, video.videoRunResultId,
        `协议执行与输出回收耗时=${Date.now() - protocolStartedAt}ms`,
      )

      this.database.addVideoOutput({
        videoRunResultId: video.videoRunResultId,
        storagePath: localOutput,
        sizeBytes: protocolResult.outputSizeBytes,
        sha256: protocolResult.outputSha256,
      })
      this.database.upsertVideoCheck(runId, video.videoRunResultId, {
        key: 'output_generated', name: '输出 MP4 生成', status: 'passed',
        message: `${protocolResult.outputSizeBytes} bytes；手机原始路径：${protocolResult.remoteOutputFile}`,
      })
      this.database.setVideoExecutionState({
        videoRunResultId: video.videoRunResultId,
        executionStatus: 'passed', executionFailureCode: null,
      })

      const mediaIntegrity = await this.mediaIntegrityChecker.check(localOutput, signal)
      this.database.recordVideoMediaIntegrity(video.videoRunResultId, mediaIntegrity)
      this.database.upsertVideoCheck(runId, video.videoRunResultId, {
        key: 'media_integrity', name: '输出视频基础完整性', status: mediaIntegrity.status,
        message: mediaIntegrity.message,
      })
      if (mediaIntegrity.status === 'failed') {
        throw new TaskExecutionError(mediaIntegrity.message, mediaIntegrity.failureCode ?? 'MEDIA_INTEGRITY_FAILED')
      }

      update('generating_report', 96, '正在保存日志、截图和兼容性报告')
      await this.captureScreenshot(executionKey, path.join(screenshotDir, 'final.png'), signal).catch(() => undefined)
      this.database.setVideoExecutionState({
        videoRunResultId: video.videoRunResultId,
        runStatus: 'passed', phase: 'completed', progress: 100, finished: true,
        executionStatus: 'passed', executionFailureCode: null, failure: null,
      })
      this.database.addVideoLog(
        taskId, runId, video.videoRunResultId,
        `真实 APK 处理完成；协议 ${protocol.id}；输出 MP4 已回收到平台`
          + `${protocolResult.logcatWarning ? `；Logcat 告警：${protocolResult.logcatWarning}` : ''}`,
      )
      return { passed: true, cancelled: false }
    } catch (error) {
      const cancelled = signal.aborted || this.database.isCancelled(taskId)
      const failureEvidenceRefs = await evidenceRecorder.captureFailure({
        phase: currentPhase,
        error,
        cancelled,
      }).catch(() => [])
      const failure = executionFailureFromError({
        error,
        phase: currentPhase,
        cancelled,
        evidenceRefs: [
          this.evidenceRef(localRunDir, 'attempt-manifest.json'),
          ...failureEvidenceRefs.map((ref) => this.evidenceRef(localRunDir, ref)),
        ],
      })
      if (!cancelled) {
        const mediaFailure = failure.code.startsWith('MEDIA_')
        this.database.setVideoExecutionState({
          videoRunResultId: video.videoRunResultId,
          runStatus: 'failed', phase: failure.phase, progress: 100, finished: true, failure,
          executionStatus: mediaFailure ? 'passed' : 'failed',
          executionFailureCode: mediaFailure ? null : failure.code,
        })
        this.database.addVideoLog(taskId, runId, video.videoRunResultId, `${failure.code}：${failure.message}`, 'error')
      }
      await writeFile(localLogcat, '', { flag: 'a' }).catch(() => undefined)
      return { passed: false, cancelled, failure }
    } finally {
      if (!protocolExecutorOwnsCleanup) {
        await this.bestEffortDeviceRun(
          ['shell', 'am', 'force-stop', protocol.packageName],
          '执行结束时停止 APK 失败',
        )
      }
      this.processes.clear(executionKey)
      if (this.activeExecutionKey === executionKey) this.activeExecutionKey = undefined
    }
  }

  private evidenceRef(localRunDir: string, ref: string) {
    const runRoot = path.join(this.appConfig.tasksDir, this.taskId, 'device-runs', this.runId)
    const relativeDirectory = path.relative(runRoot, localRunDir)
    return relativeDirectory ? path.posix.join(relativeDirectory.split(path.sep).join('/'), ref) : ref
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

  private adb(args: string[], signal: AbortSignal, timeoutMs = 30_000, code = 'SDK_PROCESSING_FAILED') {
    return this.device.run(args, signal, timeoutMs, code)
  }

  private captureScreenshot(executionKey: string, targetPath: string, signal: AbortSignal) {
    return this.streams.captureScreenshot(executionKey, targetPath, signal)
  }
}
