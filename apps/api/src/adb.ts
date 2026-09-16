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
import {
  DefaultAdbExecutionGateway,
  type AdbExecutionConnectionHealthEvidence,
  type AdbExecutionDevice,
  type AdbExecutionGateway,
  type AdbExecutionStreams,
} from './execution/adb-gateway.js'
import { AttemptEvidenceRecorder } from './execution/attempt-evidence-recorder.js'
import { delay as abortableDelay } from './execution/file-utils.js'
import { TaskProcessRegistry } from './execution/process-registry.js'
import { createProtocolExecutor } from './execution/protocol-executor-factory.js'
import type {
  ProtocolExecutor,
  ProtocolExecutorDependencies,
} from './execution/protocol-executor.js'
import {
  DefaultAndroidAppPreparer,
  type AndroidAppPreparer,
} from './execution/android-app-preparation/index.js'
import { AndroidDeviceReadiness } from './execution/android-app-preparation/device-readiness.js'
import type { DeviceRunPhase, VideoRunAttemptView } from './types.js'

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
    private readonly recoverExecution?: (
      job: DeviceRunJob,
      context: AdbConnectionRecoveryContext,
    ) => Promise<DeviceRunExecution | undefined>,
    private readonly recordConnectionHealth?: (input: AdbExecutionConnectionHealthEvidence) => void,
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
      {
        recoverExecution: this.recoverExecution
          ? (context) => this.recoverExecution!(job, context)
          : undefined,
        recordConnectionHealth: this.recordConnectionHealth,
      },
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

export type {
  AdbExecutionConnectionHealthEvidence,
  AdbExecutionDevice,
  AdbExecutionStreams,
} from './execution/adb-gateway.js'

export interface AdbRunExecutorDependencies {
  gateway?: AdbExecutionGateway
  createAppPreparer?: (device: AdbExecutionDevice, captureScreenshot: (targetPath: string, signal: AbortSignal) => Promise<void>) => AndroidAppPreparer
  createProtocolExecutor?: (
    dependencies: ProtocolExecutorDependencies,
  ) => ProtocolExecutor
  readSourceIdentity?: () => Promise<SourceIdentity>
  recoverExecution?: (context: AdbConnectionRecoveryContext) => Promise<DeviceRunExecution | undefined>
  recordConnectionHealth?: (input: AdbExecutionConnectionHealthEvidence) => void
  now?: () => Date
}

export interface AdbConnectionRecoveryContext {
  signal: AbortSignal
  deadlineAt: string
}

type AdbConnectionRecoveryResult =
  | { status: 'recovered' }
  | { status: 'unavailable'; failureCode: 'CONNECTION_RECOVERY_UNAVAILABLE' }
  | { status: 'cancelled'; failureCode: 'TASK_CANCELLED' }
  | { status: 'deadline_exceeded'; failureCode: 'CONNECTION_RECOVERY_DEADLINE_EXCEEDED' }

class AdbConnectionRecoveryDeadlineError extends Error {
  constructor() {
    super('Attempt 间设备连接恢复超过 deadline')
    this.name = 'AdbConnectionRecoveryDeadlineError'
  }
}

interface VideoAttemptOutcome {
  passed: boolean
  cancelled: boolean
  failure?: ExecutionFailure
}

/**
 * The Morpho demo app enables the denoiser (pipeline feature=0xc) only for
 * inputs whose filename STARTS WITH the original test stem — a prefixed name
 * silently degrades every run to stabilizer-only 0x4 (2026-09-14 PJV110
 * device-proven with prefix/suffix variants). The per-attempt uniqueness
 * marker therefore goes AFTER the stem, not before it.
 */
function morphoAttemptInputName(originalName: string, taskVideoId: string, attemptNumber: number) {
  const stem = originalName.toLowerCase().endsWith('.mp4')
    ? originalName.slice(0, -4)
    : originalName
  return `${stem}-${taskVideoId}-attempt-${attemptNumber}.mp4`
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
  private recoveryController?: AbortController
  private readonly gateway: AdbExecutionGateway

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
    this.gateway = dependencies.gateway ?? new DefaultAdbExecutionGateway(
      appConfig.adbPath,
      processRunner,
      appConfig,
      dependencies.recordConnectionHealth,
    )
    this.bindRuntime(execution)
  }

  private bindRuntime(execution: DeviceRunExecution) {
    if (!execution.endpointId || !execution.connectionKind || !execution.deviceSerial) {
      throw new Error(`设备执行缺少完整 Actual Connection：${execution.runId}`)
    }
    this.execution = execution
  }

  private openAttemptSession(
    execution: DeviceRunExecution,
    attempt: VideoRunAttemptView,
    signal: AbortSignal,
    deadlineAt: string,
  ) {
    if (!attempt.endpointId || !attempt.connectionKind || !attempt.adbSerial) {
      throw new Error(`Attempt 缺少完整 Actual Connection：${attempt.id}`)
    }
    const connectionState = this.database.getDeviceConnectionState(execution.deviceId)
    const healthSnapshot = attempt.connectionKind === 'network'
      && connectionState?.activeEndpointId === attempt.endpointId
      && connectionState.connectionGeneration === attempt.endpointGeneration
      ? {
          deviceId: execution.deviceId,
          endpointId: attempt.endpointId,
          generation: attempt.endpointGeneration,
        }
      : undefined
    const session = this.gateway.open({
      connection: {
        deviceId: execution.deviceId,
        endpointId: attempt.endpointId,
        kind: attempt.connectionKind,
        adbSerial: attempt.adbSerial,
        generation: attempt.endpointGeneration,
      },
      processes: this.processes,
      attempt: { signal, deadlineAt },
      healthGeneration: healthSnapshot?.generation,
    })
    this.device = session.device
    this.streams = session.streams
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
    this.recoveryController?.abort(new TaskExecutionError('用户取消任务', 'TASK_CANCELLED'))
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
        if (this.database.isCancelled(this.taskId)) return
        attemptNumber += 1
        const attemptDirectory = this.localAttemptDirectory(video, attemptNumber)
        const attempt = this.database.createVideoAttempt(video.videoRunResultId, {
          evidenceDirectory: attemptDirectory,
        })
        const outcome = await this.executeVideoAttempt(video, attempt, attemptDirectory)
        if (outcome.cancelled) return
        if (outcome.passed) {
          this.database.finishVideoAttempt(attempt.id, { status: 'passed' })
          break
        }

        if (outcome.failure?.code === 'UNSUPPORTED_APK_PROTOCOL') {
          this.database.finishVideoAttempt(attempt.id, { status: 'failed', failure: outcome.failure })
          return
        }
        if (!outcome.failure || !this.isRecoverableInfrastructureFailure(outcome.failure)) {
          this.database.finishVideoAttempt(attempt.id, { status: 'failed', failure: outcome.failure })
          break
        }
        if (attemptNumber >= 2) {
          this.finalizeRecoverableFailure(video, attempt.id, outcome.failure)
          this.database.finishVideoAttempt(attempt.id, { status: 'failed', failure: outcome.failure })
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
        const recovery = await this.recoverConnection()
        if (this.database.isCancelled(this.taskId)) return
        if (recovery.status !== 'recovered') {
          this.database.addVideoLog(
            this.taskId,
            this.runId,
            video.videoRunResultId,
            `${recovery.failureCode}：设备连接恢复未完成，当前视频不再重试`,
            'error',
          )
          this.finalizeRecoverableFailure(video, attempt.id, outcome.failure)
          this.database.finishVideoAttempt(attempt.id, { status: 'failed', failure: outcome.failure })
          this.blockLaterVideos(video, outcome.failure)
          return
        }
        this.database.finishVideoAttempt(attempt.id, { status: 'failed', failure: outcome.failure })
      }
    }
  }

  private finalizeRecoverableFailure(
    video: VideoRunExecution,
    attemptId: string,
    failure: ExecutionFailure,
  ) {
    this.database.setVideoExecutionState({
      videoRunResultId: video.videoRunResultId,
      attemptId,
      runStatus: 'failed',
      phase: failure.phase,
      progress: 100,
      finished: true,
      failure,
      executionStatus: 'failed',
      executionFailureCode: failure.code,
    })
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

  private async recoverConnection(): Promise<AdbConnectionRecoveryResult> {
    const controller = new AbortController()
    this.recoveryController = controller
    const deadlineMs = this.appConfig.attemptRecoveryDeadlineMs
    const deadlineAt = new Date(Date.now() + deadlineMs).toISOString()
    const timer = setTimeout(() => {
      controller.abort(new AdbConnectionRecoveryDeadlineError())
    }, deadlineMs)
    timer.unref()
    const cancellation = new Promise<AdbConnectionRecoveryResult>((resolve) => {
      const onAbort = () => resolve(
        controller.signal.reason instanceof AdbConnectionRecoveryDeadlineError
          ? { status: 'deadline_exceeded', failureCode: 'CONNECTION_RECOVERY_DEADLINE_EXCEEDED' }
          : { status: 'cancelled', failureCode: 'TASK_CANCELLED' },
      )
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const operation = this.runConnectionRecovery({ signal: controller.signal, deadlineAt })
    try {
      const result = await Promise.race([operation, cancellation])
      if (result.status === 'deadline_exceeded') {
        this.database.addLog(
          this.taskId,
          this.runId,
          `设备连接恢复超过 ${deadlineMs}ms 预算`,
          'error',
        )
      }
      return result
    } finally {
      clearTimeout(timer)
      if (this.recoveryController === controller) this.recoveryController = undefined
    }
  }

  private async runConnectionRecovery(
    context: AdbConnectionRecoveryContext,
  ): Promise<AdbConnectionRecoveryResult> {
    try {
      const refreshed = await this.dependencies.recoverExecution?.(context)
      if (context.signal.aborted) {
        return context.signal.reason instanceof AdbConnectionRecoveryDeadlineError
          ? { status: 'deadline_exceeded', failureCode: 'CONNECTION_RECOVERY_DEADLINE_EXCEEDED' }
          : { status: 'cancelled', failureCode: 'TASK_CANCELLED' }
      }
      if (refreshed?.endpointId && refreshed.connectionKind && refreshed.deviceSerial) {
        this.bindRuntime(refreshed)
        return { status: 'recovered' }
      }
      await abortableDelay(500, context.signal)
      const online = await this.device.connectionStatus(context.signal) === 'online'
      return online
        ? { status: 'recovered' }
        : { status: 'unavailable', failureCode: 'CONNECTION_RECOVERY_UNAVAILABLE' }
    } catch (error) {
      if (context.signal.aborted) {
        return context.signal.reason instanceof AdbConnectionRecoveryDeadlineError
          ? { status: 'deadline_exceeded', failureCode: 'CONNECTION_RECOVERY_DEADLINE_EXCEEDED' }
          : { status: 'cancelled', failureCode: 'TASK_CANCELLED' }
      }
      this.database.addLog(
        this.taskId,
        this.runId,
        `设备连接恢复失败：${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
      return { status: 'unavailable', failureCode: 'CONNECTION_RECOVERY_UNAVAILABLE' }
    }
  }

  private async executeVideoAttempt(
    video: VideoRunExecution,
    attempt: VideoRunAttemptView,
    localRunDir: string,
  ): Promise<VideoAttemptOutcome> {
    const execution = this.execution
    const { taskId, runId } = execution
    const { id: attemptId, attemptNumber } = attempt
    const attemptStartedAt = this.dependencies.now?.() ?? new Date()
    const deadlineAt = new Date(
      attemptStartedAt.getTime() + execution.timeoutSeconds * 1_000,
    ).toISOString()
    const controller = new AbortController()
    const signal = controller.signal
    const deadlineTimer = setTimeout(() => {
      controller.abort(new TaskExecutionError(
        `Attempt 超过全局执行预算 ${execution.timeoutSeconds} 秒`,
        'TASK_TIMEOUT',
      ))
    }, execution.timeoutSeconds * 1_000)
    deadlineTimer.unref()
    const protocol = findApkExecutionProtocol(execution.apkPackageName)
    let currentPhase: DeviceRunPhase = 'validating_device'
    const manifestAttemptId = execution.videos.length === 1 && attemptNumber === 1 ? runId : attemptId
    const attemptManifestPath = path.join(localRunDir, 'attempt-manifest.json')
    const deviceSnapshotPath = path.join(localRunDir, 'device-snapshot.json')
    let attemptManifest
    try {
      attemptManifest = await buildAttemptManifest({
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
    } catch (error) {
      clearTimeout(deadlineTimer)
      throw error
    }

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
        attemptId,
        runStatus: 'failed', phase: currentPhase, progress: 100, finished: true,
        executionStatus: 'failed', executionFailureCode: failure.code, failure,
      })
      this.blockLaterVideos(video, failure)
      clearTimeout(deadlineTimer)
      return { passed: false, cancelled: false, failure }
    }

    const executionKey = attemptId
    this.activeExecutionKey = executionKey
    this.processes.begin(executionKey, controller, protocol.packageName)
    try {
      this.openAttemptSession(execution, attempt, signal, deadlineAt)
    } catch (error) {
      clearTimeout(deadlineTimer)
      this.processes.clear(executionKey)
      if (this.activeExecutionKey === executionKey) this.activeExecutionKey = undefined
      throw error
    }

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
      requireCurrentAttempt(this.database.setVideoExecutionState({
        videoRunResultId: video.videoRunResultId,
        attemptId,
        runStatus: 'running', phase, progress,
      }))
      this.database.addVideoLog(taskId, runId, video.videoRunResultId, message)
    }
    const requireCurrentAttempt = (written: boolean) => {
      if (written) return
      throw new TaskExecutionError(
        'Attempt 的设备 Lease 或联网 Endpoint generation 已过期，已停止旧执行',
        'STALE_DEVICE_LEASE',
      )
    }

    try {
      await mkdir(screenshotDir, { recursive: true })
      requireCurrentAttempt(this.database.setVideoExecutionState({
        videoRunResultId: video.videoRunResultId,
        attemptId,
        runStatus: 'running', phase: 'validating_device', progress: 2, started: true,
        executionStatus: 'running', executionFailureCode: null, failure: null,
      }))
      this.database.addVideoLog(
        taskId, runId, video.videoRunResultId,
        `开始检查 ADB 真机连接；视频 ${video.sequence + 1}/${execution.videos.length}；执行协议：${protocol.name}`,
      )

      const deviceStatus = await this.device.connectionStatus(signal)
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
        : morphoAttemptInputName(video.videoOriginalName, video.taskVideoId, attemptNumber)
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
        companionAssetsDir: this.appConfig.morphoDataPackAssetsDir,
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
          setProcessingProgress: (progress) => requireCurrentAttempt(
            this.database.setVideoExecutionState({
              videoRunResultId: video.videoRunResultId,
              attemptId,
              runStatus: 'running', phase: 'processing', progress,
            }),
          ),
          upsertCheck: (check) => requireCurrentAttempt(this.database.upsertVideoCheck(
            runId, video.videoRunResultId, check, attemptId,
          )),
          isCancelled: () => this.database.isCancelled(taskId),
        },
      })
      this.database.addVideoLog(
        taskId, runId, video.videoRunResultId,
        `协议执行与输出回收耗时=${Date.now() - protocolStartedAt}ms`,
      )

      requireCurrentAttempt(Boolean(this.database.addVideoOutput({
        videoRunResultId: video.videoRunResultId,
        attemptId,
        storagePath: localOutput,
        sizeBytes: protocolResult.outputSizeBytes,
        sha256: protocolResult.outputSha256,
      })))
      requireCurrentAttempt(this.database.upsertVideoCheck(runId, video.videoRunResultId, {
        key: 'output_generated', name: '输出 MP4 生成', status: 'passed',
        message: `${protocolResult.outputSizeBytes} bytes；手机原始路径：${protocolResult.remoteOutputFile}`,
      }, attemptId))
      requireCurrentAttempt(this.database.setVideoExecutionState({
        videoRunResultId: video.videoRunResultId,
        attemptId,
        executionStatus: 'passed', executionFailureCode: null,
      }))

      const mediaIntegrity = await this.mediaIntegrityChecker.check(localOutput, signal)
      requireCurrentAttempt(this.database.recordVideoMediaIntegrity(
        video.videoRunResultId, mediaIntegrity, attemptId,
      ))
      requireCurrentAttempt(this.database.upsertVideoCheck(runId, video.videoRunResultId, {
        key: 'media_integrity', name: '输出视频基础完整性', status: mediaIntegrity.status,
        message: mediaIntegrity.message,
      }, attemptId))
      if (mediaIntegrity.status === 'failed') {
        throw new TaskExecutionError(mediaIntegrity.message, mediaIntegrity.failureCode ?? 'MEDIA_INTEGRITY_FAILED')
      }

      update('generating_report', 96, '正在保存日志、截图和兼容性报告')
      await this.captureScreenshot(executionKey, path.join(screenshotDir, 'final.png'), signal).catch(() => undefined)
      requireCurrentAttempt(this.database.setVideoExecutionState({
        videoRunResultId: video.videoRunResultId,
        attemptId,
        runStatus: 'passed', phase: 'completed', progress: 100, finished: true,
        executionStatus: 'passed', executionFailureCode: null, failure: null,
      }))
      this.database.addVideoLog(
        taskId, runId, video.videoRunResultId,
        `真实 APK 处理完成；协议 ${protocol.id}；输出 MP4 已回收到平台`
          + `${protocolResult.logcatWarning ? `；Logcat 告警：${protocolResult.logcatWarning}` : ''}`,
      )
      return { passed: true, cancelled: false }
    } catch (error) {
      const deadlineFailure = signal.aborted
        && signal.reason instanceof TaskExecutionError
        && signal.reason.code === 'TASK_TIMEOUT'
        ? signal.reason
        : undefined
      const effectiveError = deadlineFailure ?? error
      const cancelled = !deadlineFailure && (signal.aborted || this.database.isCancelled(taskId))
      const failureEvidenceRefs = await evidenceRecorder.captureFailure({
        phase: currentPhase,
        error: effectiveError,
        cancelled,
      }).catch(() => [])
      const failure = executionFailureFromError({
        error: effectiveError,
        phase: currentPhase,
        cancelled,
        evidenceRefs: [
          this.evidenceRef(localRunDir, 'attempt-manifest.json'),
          ...failureEvidenceRefs.map((ref) => this.evidenceRef(localRunDir, ref)),
        ],
      })
      if (!cancelled) {
        const mediaFailure = failure.code.startsWith('MEDIA_')
        const retryable = this.isRecoverableInfrastructureFailure(failure)
        this.database.setVideoExecutionState({
          videoRunResultId: video.videoRunResultId,
          attemptId,
          runStatus: retryable ? 'running' : 'failed',
          phase: failure.phase,
          progress: retryable ? 95 : 100,
          finished: !retryable,
          failure,
          executionStatus: mediaFailure ? 'passed' : 'failed',
          executionFailureCode: mediaFailure ? null : failure.code,
        })
        this.database.addVideoLog(taskId, runId, video.videoRunResultId, `${failure.code}：${failure.message}`, 'error')
      }
      await writeFile(localLogcat, '', { flag: 'a' }).catch(() => undefined)
      return { passed: false, cancelled, failure }
    } finally {
      clearTimeout(deadlineTimer)
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
