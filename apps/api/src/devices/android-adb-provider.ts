import { config } from '../config.js'
import { runProcess, type ProcessResult } from '../process.js'
import type { DeviceDiscoveryCandidate, DeviceConnectionStatus } from '../types.js'
import type { DeviceDiscoveryProvider } from './device-provider.js'

export type AdbCommandExecutor = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<ProcessResult>

interface AdbListEntry {
  serial: string
  state: string
  attributes: Record<string, string>
}

export function parseAdbDevices(output: string): AdbListEntry[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial = '', state = 'unknown', ...parts] = line.split(/\s+/)
      const attributes = Object.fromEntries(parts.flatMap((part) => {
        const separator = part.indexOf(':')
        return separator > 0 ? [[part.slice(0, separator), part.slice(separator + 1)]] : []
      }))
      return { serial, state, attributes }
    })
    .filter((entry) => Boolean(entry.serial))
}

function connectionStatus(state: string): DeviceConnectionStatus {
  if (state === 'device') return 'online'
  if (state === 'unauthorized') return 'unauthorized'
  if (state === 'offline') return 'offline'
  return 'unknown'
}

function parseGetProp(output: string) {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\[([^\]]+)\]: \[(.*)\]$/)
    if (match) values.set(match[1], match[2])
  }
  return values
}

function first(values: Map<string, string>, ...keys: string[]) {
  return keys.map((key) => values.get(key)?.trim()).find(Boolean)
}

export class AndroidAdbDeviceProvider implements DeviceDiscoveryProvider {
  readonly platform = 'android' as const

  constructor(
    private readonly adbPath = config.adbPath,
    private readonly execute: AdbCommandExecutor = runProcess,
  ) {}

  async discover(): Promise<DeviceDiscoveryCandidate[]> {
    const listed = await this.execute(this.adbPath, ['devices', '-l'], { timeoutMs: 10_000 })
    const entries = parseAdbDevices(listed.stdout)
    return Promise.all(entries.map((entry) => this.describe(entry)))
  }

  private async describe(entry: AdbListEntry): Promise<DeviceDiscoveryCandidate> {
    const status = connectionStatus(entry.state)
    const fallbackModel = entry.attributes.model?.replaceAll('_', ' ')
    if (status !== 'online') {
      return {
        serial: entry.serial,
        platform: 'android',
        model: fallbackModel,
        name: fallbackModel,
        connectionStatus: status,
      }
    }

    try {
      const result = await this.execute(
        this.adbPath,
        ['-s', entry.serial, 'shell', 'getprop'],
        { timeoutMs: 15_000 },
      )
      const props = parseGetProp(result.stdout)
      const manufacturer = first(props, 'ro.product.manufacturer', 'ro.product.brand')
      const model = first(props, 'ro.product.model', 'ro.product.vendor.model') ?? fallbackModel
      const marketName = first(props, 'ro.config.marketing_name', 'ro.product.marketname')
      const androidVersion = first(props, 'ro.build.version.release')
      const apiText = first(props, 'ro.build.version.sdk')
      return {
        serial: entry.serial,
        platform: 'android',
        manufacturer,
        name: marketName ?? model ?? entry.serial,
        model,
        androidVersion,
        apiLevel: apiText ? Number(apiText) : undefined,
        architecture: first(props, 'ro.product.cpu.abi', 'ro.product.cpu.abilist'),
        buildVersion: first(props, 'ro.build.display.id', 'ro.build.fingerprint'),
        securityPatch: first(props, 'ro.build.version.security_patch'),
        connectionStatus: 'online',
      }
    } catch {
      return {
        serial: entry.serial,
        platform: 'android',
        model: fallbackModel,
        name: fallbackModel ?? entry.serial,
        connectionStatus: 'unknown',
      }
    }
  }
}
