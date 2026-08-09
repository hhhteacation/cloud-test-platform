import {
  BoundedProcessRunner,
  ProcessError,
  type ProcessResult,
  type ProcessRunner,
  type RunProcessOptions,
} from '../process.js'
import { TaskExecutionError } from './execution-errors.js'

export type AdbConnectionStatus = 'online' | 'offline' | 'unauthorized'

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

export class AdbDeviceClient {
  constructor(
    private readonly adbPath: string,
    private readonly deviceSerial: string,
    private readonly runner: ProcessRunner = new BoundedProcessRunner(),
  ) {}

  async connectionStatus(): Promise<AdbConnectionStatus> {
    try {
      const result = await this.runner.run(this.adbPath, ['devices'], { timeoutMs: 10_000 })
      const line = result.stdout
        .split(/\r?\n/)
        .find((item) => item.startsWith(this.deviceSerial))

      if (!line) return 'offline'
      if (line.includes('\tdevice')) return 'online'
      if (line.includes('\tunauthorized')) return 'unauthorized'
      return 'offline'
    } catch {
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
      return await this.runner.run(
        this.adbPath,
        ['-s', this.deviceSerial, ...args],
        { signal, timeoutMs },
      )
    } catch (error) {
      if (signal.aborted) throw error
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
      return await this.runner.run(
        this.adbPath,
        ['-s', this.deviceSerial, ...args],
        { signal, timeoutMs, ...capture },
      )
    } catch (error) {
      if (signal.aborted) throw error
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
