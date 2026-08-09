import { mkdir, stat, statfs } from 'node:fs/promises'
import path from 'node:path'

import type { ApkExecutionPaths, ApkExecutionProtocol } from '../apk-protocols.js'
import type { ProcessResult } from '../process.js'
import { TaskExecutionError } from './execution-errors.js'
import { delay as abortableDelay, sha256File } from './file-utils.js'
import type { AdbObservation } from './adb-client.js'
import type { LogcatStreamEvent } from './adb-streams.js'
import type { CheckResult, DeviceRunPhase } from '../types.js'

export interface ProtocolExecutionDevice {
  run(
    args: string[],
    signal: AbortSignal,
    timeoutMs?: number,
    code?: string,
  ): Promise<ProcessResult>
  observe(
    args: string[],
    signal: AbortSignal,
    timeoutMs?: number,
    capture?: { captureStdoutPath?: string; captureStderrPath?: string },
  ): Promise<ProcessResult>
  stat(remotePath: string, signal: AbortSignal): Promise<AdbObservation<number>>
  exists(remotePath: string, signal: AbortSignal): Promise<AdbObservation<boolean>>
  isPackageRunning(packageName: string, signal: AbortSignal): Promise<AdbObservation<boolean>>
}

export interface ProtocolExecutionStreams {
  startLogcat(
    executionKey: string,
    targetPath: string,
    signal: AbortSignal,
    tags: readonly string[],
    onLine: (line: string) => void,
    onEvent?: (event: LogcatStreamEvent) => void,
    maxBytes?: number,
  ): Promise<() => Promise<void>>
  captureLogcatSnapshot(
    executionKey: string,
    targetPath: string,
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<void>
}

export interface ProtocolExecutionReporter {
  update(phase: DeviceRunPhase, progress: number, message: string): void
  addLog(message: string, level?: 'info' | 'warning' | 'error'): void
  setProcessingProgress(progress: number): void
  upsertCheck(check: CheckResult): void
  isCancelled(): boolean
}

export interface ProtocolExecutionContext {
  executionKey: string
  taskId: string
  protocol: ApkExecutionProtocol
  paths: ApkExecutionPaths
  input: {
    localPath: string
    originalName: string
  }
  local: {
    runDirectory: string
    resultPath: string
    outputPath: string
    logcatPath: string
    diagnosticsDirectory: string
  }
  configuredTimeoutSeconds: number
  signal: AbortSignal
  reporter: ProtocolExecutionReporter
}

export interface ProtocolExecutionResult {
  inputSizeBytes: number
  outputSizeBytes: number
  outputSha256: string
  remoteOutputFile: string
  logcatWarning?: string
}

export interface ProtocolExecutor {
  execute(context: ProtocolExecutionContext): Promise<ProtocolExecutionResult>
}

export interface ProtocolExecutorDependencies {
  device: ProtocolExecutionDevice
  streams: ProtocolExecutionStreams
  pollIntervalMs: number
  maxLogcatBytes: number
  minFreeDiskBytes: number
  now?: () => number
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Shared implementation hidden behind the single ProtocolExecutor seam. */
export abstract class BaseProtocolExecutor implements ProtocolExecutor {
  protected readonly now: () => number
  protected readonly delay: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(protected readonly dependencies: ProtocolExecutorDependencies) {
    this.now = dependencies.now ?? Date.now
    this.delay = dependencies.delay ?? abortableDelay
  }

  abstract execute(context: ProtocolExecutionContext): Promise<ProtocolExecutionResult>

  protected adb(
    args: string[],
    signal: AbortSignal,
    timeoutMs = 30_000,
    code = 'SDK_PROCESSING_FAILED',
  ) {
    return this.dependencies.device.run(args, signal, timeoutMs, code)
  }

  protected requireObservationValue<T>(observation: AdbObservation<T>, absentValue: T): T {
    if (observation.kind === 'failed') throw observation.error
    if (observation.kind === 'absent') return absentValue
    return observation.value
  }

  protected async remoteStat(remotePath: string, signal: AbortSignal) {
    return this.requireObservationValue(
      await this.dependencies.device.stat(remotePath, signal),
      -1,
    )
  }

  protected async remoteExists(remotePath: string, signal: AbortSignal) {
    return this.requireObservationValue(
      await this.dependencies.device.exists(remotePath, signal),
      false,
    )
  }

  protected async isPackageRunning(packageName: string, signal: AbortSignal) {
    return this.requireObservationValue(
      await this.dependencies.device.isPackageRunning(packageName, signal),
      false,
    )
  }

  protected async assertLogcatDiskSpace(localRunDirectory: string) {
    await mkdir(localRunDirectory, { recursive: true })
    const disk = await statfs(localRunDirectory)
    const availableBytes = disk.bavail * disk.bsize
    const requiredBytes = this.dependencies.minFreeDiskBytes
      + Math.min(this.dependencies.maxLogcatBytes, 16 * 1024 * 1024)
    if (availableBytes < requiredBytes) {
      throw new TaskExecutionError(
        `Logcat 磁盘空间不足：当前 ${availableBytes} 字节，需要至少 ${requiredBytes} 字节`,
        'INSUFFICIENT_LOGCAT_DISK_SPACE',
      )
    }
  }

  protected describeLogcatEvent(event: LogcatStreamEvent) {
    if (event.type === 'truncated') {
      return `LOGCAT_TRUNCATED：日志达到 ${event.maxBytes} 字节上限，已停止当前设备的日志采集，业务测试继续`
    }
    if (event.type === 'write_failed') return `LOGCAT_WRITE_FAILED：${event.error.message}`
    const detail = event.stderr ? `；${event.stderr}` : ''
    return `LOGCAT_PROCESS_EXITED：Logcat 进程异常退出（code=${event.code ?? 'null'}，signal=${event.signal ?? 'null'}）${detail}`
  }

  protected startLogcat(
    context: ProtocolExecutionContext,
    tags: readonly string[],
    onLine: (line: string) => void,
    onEvent: (event: LogcatStreamEvent) => void,
  ) {
    return this.dependencies.streams.startLogcat(
      context.executionKey,
      context.local.logcatPath,
      context.signal,
      tags,
      onLine,
      onEvent,
      Math.min(this.dependencies.maxLogcatBytes, 16 * 1024 * 1024),
    )
  }

  protected async captureFailureLogcat(context: ProtocolExecutionContext) {
    await this.dependencies.streams.captureLogcatSnapshot(
      context.executionKey,
      path.join(context.local.diagnosticsDirectory, 'logcat-full-failure.txt'),
      context.signal,
      16 * 1024 * 1024,
    ).catch((error) => {
      context.reporter.addLog(
        `失败 Logcat 快照采集失败：${error instanceof Error ? error.message : String(error)}`,
        'warning',
      )
    })
  }

  protected async collectOutput(
    context: ProtocolExecutionContext,
    remoteOutputFile: string,
  ): Promise<Omit<ProtocolExecutionResult, 'inputSizeBytes' | 'logcatWarning'>> {
    context.reporter.update('validating_output', 78, '正在验证 APK 生成的输出 MP4')
    const outputStat = await this.remoteStat(remoteOutputFile, context.signal)
    if (outputStat <= 0) {
      throw new TaskExecutionError(
        `APK 未生成有效输出：${remoteOutputFile}`,
        outputStat === 0 ? 'OUTPUT_EMPTY' : 'OUTPUT_MISSING',
      )
    }

    context.reporter.update(
      'collecting_output',
      88,
      '正在从手机拉取处理后的 MP4，并在平台统一保存为 output.mp4',
    )
    await this.adb(
      ['pull', remoteOutputFile, context.local.outputPath],
      context.signal,
      180_000,
      'OUTPUT_MISSING',
    )
    const localOutput = await stat(context.local.outputPath)
    if (localOutput.size <= 0) {
      throw new TaskExecutionError('拉取的输出 MP4 为空', 'OUTPUT_EMPTY')
    }
    return {
      remoteOutputFile,
      outputSizeBytes: localOutput.size,
      outputSha256: await sha256File(context.local.outputPath),
    }
  }

  protected async bestEffortDeviceRun(
    context: ProtocolExecutionContext,
    args: string[],
    description: string,
  ) {
    try {
      await this.dependencies.device.run(
        args,
        new AbortController().signal,
        30_000,
        'DEVICE_CLEANUP_FAILED',
      )
    } catch (error) {
      context.reporter.addLog(
        `${description}：${error instanceof Error ? error.message : String(error)}`,
        'warning',
      )
    }
  }
}
