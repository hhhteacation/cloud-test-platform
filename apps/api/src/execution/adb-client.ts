import { BoundedProcessRunner, ProcessError, type ProcessResult, type ProcessRunner } from '../process.js'
import { TaskExecutionError } from './execution-errors.js'

export type AdbConnectionStatus = 'online' | 'offline' | 'unauthorized'

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
      )
    }
  }

  async clearLogcat(signal: AbortSignal) {
    return this.run(['logcat', '-b', 'all', '-c'], signal, 30_000, 'LOGCAT_CLEAR_FAILED')
  }

  async stat(remotePath: string, signal: AbortSignal) {
    try {
      const result = await this.run(
        ['shell', 'stat', '-c', '%s', remotePath],
        signal,
        15_000,
        'OUTPUT_MISSING',
      )
      return Number(result.stdout.trim())
    } catch {
      return -1
    }
  }

  async exists(remotePath: string, signal: AbortSignal) {
    try {
      await this.run(['shell', 'test', '-e', remotePath], signal, 15_000, 'OUTPUT_MISSING')
      return true
    } catch {
      return false
    }
  }

  async isPackageRunning(packageName: string, signal: AbortSignal) {
    const result = await this.run(
      ['shell', 'pidof', packageName],
      signal,
      10_000,
      'APP_CRASHED',
    ).catch(() => undefined)
    return Boolean(result?.stdout.trim())
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
