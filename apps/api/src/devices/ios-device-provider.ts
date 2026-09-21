import { ProcessError, runProcess, type ProcessResult, type RunProcessOptions } from '../process.js'
import type { DeviceDiscoveryCandidate } from '../types.js'
import type { DeviceDiscoveryProvider } from './device-provider.js'

export type IosCommandExecutor = (
  command: string,
  args: string[],
  options?: Pick<RunProcessOptions, 'timeoutMs' | 'signal'>,
) => Promise<ProcessResult>

/**
 * usbmux lists one UDID per line. Only paired/trusted devices reach this list;
 * an untrusted iPhone stays invisible to idevice_id until the user accepts
 * the "Trust This Computer" prompt.
 */
export function parseIdeviceIdList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[0-9A-Fa-f-]+$/.test(line) && line.length >= 8)
}

/** lockdown key/value pairs, one per line as `Key: value`. */
export function parseIdeviceInfo(output: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf(': ')
    if (separator > 0) {
      values.set(line.slice(0, separator).trim(), line.slice(separator + 2).trim())
    }
  }
  return values
}

function classifyLockdownFailure(detail: string) {
  const value = detail.toLowerCase()
  if (value.includes('pair') || value.includes('refused') || value.includes('password')) {
    return 'IOS_PAIRING_REJECTED'
  }
  if (value.includes('timeout') || value.includes('timed out')) return 'IOS_LOCKDOWN_TIMEOUT'
  return 'IOS_LOCKDOWN_UNAVAILABLE'
}

/**
 * iOS discovery over libimobiledevice (usbmux). The UDID is the device
 * identity across usbmux and devicectl, so it doubles as the serial.
 * Network discovery (Wi-Fi/CoreDevice) is intentionally not implemented yet;
 * see docs/iOS自动化测试-需求与技术方案-v1.md milestone M4.
 */
export class IosLibimobiledeviceProvider implements DeviceDiscoveryProvider {
  readonly platform = 'ios' as const

  constructor(
    private readonly ideviceIdPath = 'idevice_id',
    private readonly ideviceInfoPath = 'ideviceinfo',
    private readonly execute: IosCommandExecutor = runProcess,
  ) {}

  async discover(options: { signal?: AbortSignal } = {}): Promise<DeviceDiscoveryCandidate[]> {
    const listed = await this.execute(this.ideviceIdPath, ['-l'], {
      timeoutMs: 10_000,
      signal: options.signal,
    })
    const udids = parseIdeviceIdList(listed.stdout)
    return Promise.all(udids.map((udid) => this.describe(udid, options.signal)))
  }

  private async describe(udid: string, signal?: AbortSignal): Promise<DeviceDiscoveryCandidate> {
    try {
      const result = await this.execute(this.ideviceInfoPath, ['-u', udid], {
        timeoutMs: 10_000,
        signal,
      })
      const info = parseIdeviceInfo(result.stdout)
      return {
        serial: udid,
        hardwareSerial: info.get('SerialNumber'),
        platform: 'ios',
        manufacturer: 'Apple',
        name: info.get('DeviceName') ?? info.get('ProductName') ?? udid,
        model: info.get('ProductType'),
        iosVersion: info.get('ProductVersion'),
        architecture: info.get('CPUArchitecture'),
        buildVersion: info.get('BuildVersion'),
        connectionStatus: 'online',
      }
    } catch (error) {
      if (signal?.aborted) throw error
      // usbmux sees the device but lockdown refuses: pairing was revoked on
      // the phone (Settings > General > Reset > Reset Location & Privacy).
      const detail = error instanceof ProcessError
        ? `${error.result?.stderr ?? ''}\n${error.result?.stdout ?? ''}`.trim() || error.message
        : error instanceof Error ? error.message : String(error)
      return {
        serial: udid,
        platform: 'ios',
        manufacturer: 'Apple',
        connectionStatus: 'unknown',
        failureCode: error instanceof ProcessError
          ? classifyLockdownFailure(detail)
          : 'IOS_DISCOVERY_FAILED',
        failureMessage: detail,
      }
    }
  }
}
