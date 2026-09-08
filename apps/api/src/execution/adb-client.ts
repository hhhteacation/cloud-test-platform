import {
  BoundedProcessRunner,
  ProcessError,
  type ProcessResult,
  type ProcessRunner,
  type RunProcessOptions,
} from '../process.js'
import { TaskExecutionError } from './execution-errors.js'

export type AdbConnectionStatus = 'online' | 'offline' | 'unauthorized'

export type AdbCommandHealthEvidence =
  | { kind: 'healthy' }
  | { kind: 'transport_failed'; failureCode: string }

export interface AdbDeviceClientOptions {
  onHealthEvidence?: (evidence: AdbCommandHealthEvidence) => void
}

export type AdbObservation<T> =
  | { kind: 'present'; value: T; result: ProcessResult }
  | { kind: 'absent'; result: ProcessResult }
  | { kind: 'failed'; error: TaskExecutionError; result?: ProcessResult }

function describeOperation(args: readonly string[]) {
  const [command, ...rest] = args
  if (command === 'install' || command === 'push' || command === 'pull') return command
  if (command === 'uninstall') return `uninstall ${rest[0] ?? ''}`.trim()
  if (command === 'shell') return `shell ${rest.slice(0, 4).join(' ')}`.trim()
  return [command, ...rest.slice(0, 2)].filter(Boolean).join(' ')
}

/**
 * Deep adapter for one ADB device.
 *
 * The worker only needs device operations; command construction, timeout
 * handling and process errors stay inside this module.
 */
function isMissingPathResult(result: ProcessResult) {
  const detail = `${result.stdout}\n${result.stderr}`.toLowerCase()
  return /no such file|cannot stat|not found|does not exist/.test(detail)
}

function formatProcessResult(result: ProcessResult) {
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('；')
  return `退出码=${result.code}${detail ? `；${detail}` : ''}`
}

function classifyTransportFailure(error: unknown): string | undefined {
  const result = error instanceof ProcessError ? error.result : undefined
  const detail = [
    error instanceof Error ? error.message : String(error),
    result?.stdout,
    result?.stderr,
  ].filter(Boolean).join('\n').toLowerCase()
  if (/\bunauthorized\b/.test(detail)) return 'ADB_UNAUTHORIZED'
  if (/\bdevice(?:\s+\S+)?\s+offline\b|\bdevice offline\b/.test(detail)) return 'ADB_DEVICE_OFFLINE'
  if (/\bdevice(?:\s+\S+)?\s+not found\b|no devices\/emulators found/.test(detail)) return 'ADB_DEVICE_NOT_FOUND'
  if (/connection refused|failed to connect|cannot connect/.test(detail)) return 'ADB_PORT_REFUSED'
  if (/network is unreachable|no route to host|network is down/.test(detail)) return 'ADB_NETWORK_UNREACHABLE'
  if (/connection reset|connection closed|transport (?:error|is closing)|protocol fault/.test(detail)) {
    return 'ADB_TRANSPORT_LOST'
  }
  return undefined
}

export class AdbDeviceClient {
  constructor(
    private readonly adbPath: string,
    private readonly deviceSerial: string,
    private readonly runner: ProcessRunner = new BoundedProcessRunner(),
    private readonly options: AdbDeviceClientOptions = {},
  ) {}

  private recordSuccess() {
    this.publishHealthEvidence({ kind: 'healthy' })
  }

  private publishHealthEvidence(evidence: AdbCommandHealthEvidence) {
    try {
      this.options.onHealthEvidence?.(evidence)
    } catch {
      // Health telemetry is best-effort and must never change ADB command semantics.
    }
  }

  private recordFailure(error: unknown, signal: AbortSignal) {
    if (signal.aborted) return
    const failureCode = classifyTransportFailure(error)
    if (failureCode) {
      this.publishHealthEvidence({ kind: 'transport_failed', failureCode })
      return
    }
    // ADB returned a command result from the selected device. Even when the
    // command itself was rejected, that response is positive transport health.
    if (error instanceof ProcessError && error.result && error.result.code >= 0) this.recordSuccess()
  }

  async connectionStatus(signal?: AbortSignal): Promise<AdbConnectionStatus> {
    try {
      const result = await this.runner.run(this.adbPath, ['devices'], { signal, timeoutMs: 10_000 })
      const line = result.stdout
        .split(/\r?\n/)
        .find((item) => item.startsWith(this.deviceSerial))

      if (!line) return 'offline'
      if (line.includes('\tdevice')) return 'online'
      if (line.includes('\tunauthorized')) return 'unauthorized'
      return 'offline'
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      return 'offline'
    }
  }

  async run(
    args: string[],
    signal: AbortSignal,
    timeoutMs = 30_000,
    code = 'SDK_PROCESSING_FAILED',
  ): Promise<ProcessResult> {
    try {
      const result = await this.runner.run(
        this.adbPath,
        ['-s', this.deviceSerial, ...args],
        { signal, timeoutMs },
      )
      this.recordSuccess()
      return result
    } catch (error) {
      if (signal.aborted) throw error
      this.recordFailure(error, signal)
      const detail = error instanceof ProcessError
        ? error.result?.stderr || error.result?.stdout
        : undefined
      const processContext = error instanceof ProcessError
        ? `设备=${this.deviceSerial}，操作=${describeOperation(args)}，退出码=${error.result?.code ?? '未知'}`
        : `设备=${this.deviceSerial}，操作=${describeOperation(args)}`
      throw new TaskExecutionError(
        detail?.trim()
          ? `${processContext}：${detail.trim()}`
          : `${processContext}：${error instanceof Error ? error.message : String(error)}（命令没有返回 stdout/stderr）`,
        code,
        {
          processResult: error instanceof ProcessError ? error.result : undefined,
        },
      )
    }
  }

  async observe(
    args: string[],
    signal: AbortSignal,
    timeoutMs = 30_000,
    capture: Pick<RunProcessOptions, 'captureStdoutPath' | 'captureStderrPath'> = {},
  ): Promise<ProcessResult> {
    try {
      const result = await this.runner.run(
        this.adbPath,
        ['-s', this.deviceSerial, ...args],
        { signal, timeoutMs, ...capture },
      )
      this.recordSuccess()
      return result
    } catch (error) {
      if (signal.aborted) throw error
      this.recordFailure(error, signal)
      if (error instanceof ProcessError && error.result) return error.result
      throw new TaskExecutionError(
        `设备=${this.deviceSerial}，观察=${describeOperation(args)}：${error instanceof Error ? error.message : String(error)}`,
        'STARTUP_OBSERVATION_FAILED',
      )
    }
  }

  async clearLogcat(signal: AbortSignal) {
    return this.run(['logcat', '-b', 'all', '-c'], signal, 30_000, 'LOGCAT_CLEAR_FAILED')
  }

  async stat(remotePath: string, signal: AbortSignal): Promise<AdbObservation<number>> {
    const args = ['shell', 'stat', '-c', '%s', remotePath]
    let result: ProcessResult
    try {
      result = await this.observe(args, signal, 15_000)
    } catch (error) {
      if (signal.aborted) throw error
      return this.failedObservation(args, error)
    }

    if (result.code === 0) {
      const value = Number(result.stdout.trim())
      if (Number.isFinite(value) && value >= 0) {
        return { kind: 'present', value, result }
      }
      return {
        kind: 'failed',
        result,
        error: this.observationError(
          args,
          `ADB stat 返回了无法解析的文件大小：${result.stdout.trim() || '空输出'}`,
        ),
      }
    }

    if (isMissingPathResult(result)) return { kind: 'absent', result }
    return {
      kind: 'failed',
      result,
      error: this.observationError(args, formatProcessResult(result)),
    }
  }

  async exists(remotePath: string, signal: AbortSignal): Promise<AdbObservation<boolean>> {
    const args = ['shell', 'test', '-e', remotePath]
    let result: ProcessResult
    try {
      result = await this.observe(args, signal, 15_000)
    } catch (error) {
      if (signal.aborted) throw error
      return this.failedObservation(args, error)
    }

    if (result.code === 0) return { kind: 'present', value: true, result }
    // `test -e` uses exit code 1 for a normal negative observation.
    if (result.code === 1) return { kind: 'absent', result }
    return {
      kind: 'failed',
      result,
      error: this.observationError(args, formatProcessResult(result)),
    }
  }

  async isPackageRunning(packageName: string, signal: AbortSignal): Promise<AdbObservation<boolean>> {
    const args = ['shell', 'pidof', packageName]
    let result: ProcessResult
    try {
      result = await this.observe(args, signal, 10_000)
    } catch (error) {
      if (signal.aborted) throw error
      return this.failedObservation(args, error)
    }

    if (result.code === 0 && result.stdout.trim()) {
      return { kind: 'present', value: true, result }
    }
    // `pidof` returns 1 when the process is absent. Empty output is also a
    // negative observation on some vendor builds.
    if (result.code === 0 || result.code === 1) return { kind: 'absent', result }
    return {
      kind: 'failed',
      result,
      error: this.observationError(args, formatProcessResult(result)),
    }
  }

  private failedObservation(args: string[], error: unknown): AdbObservation<never> {
    if (error instanceof TaskExecutionError) {
      return { kind: 'failed', error }
    }
    return {
      kind: 'failed',
      error: this.observationError(
        args,
        error instanceof Error ? error.message : String(error),
      ),
    }
  }

  private observationError(args: string[], detail: string) {
    return new TaskExecutionError(
      `设备=${this.deviceSerial}，观察=${describeOperation(args)}：${detail}`,
      'ADB_OBSERVATION_FAILED',
    )
  }

  async isPackageInstalled(packageName: string, signal: AbortSignal) {
    const result = await this.run(
      ['shell', 'pm', 'list', 'packages', packageName],
      signal,
      15_000,
      'APK_INSTALL_FAILED',
    )
    return result.stdout
      .split(/\r?\n/)
      .some((line) => line.trim() === `package:${packageName}`)
  }
}
