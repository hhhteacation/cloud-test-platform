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


export function parseAdbMdnsServices(output: string): Array<{ host: string; port: number; serial: string }> {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    if (/^List of discovered services/i.test(line) || /^adb\s+mdns/i.test(line)) return []
    if (/_adb-tls-pairing\._tcp/i.test(line)) return []
    if (line.includes('_adb-') && !/_adb-tls-connect\._tcp/i.test(line)) return []
    const matches = [...line.matchAll(/(\[[^\]]+\]|(?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(?=\s|$)/g)]
    const match = matches.at(-1)
    if (!match) return []
    const host = match[1].replace(/^\[|\]$/g, '')
    const port = Number(match[2])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return []
    const serial = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
    return [{ host, port, serial }]
  })
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

  async discoverNetwork(): Promise<DeviceDiscoveryCandidate[]> {
    try {
      const result = await this.execute(this.adbPath, ['mdns', 'services'], { timeoutMs: 10_000 })
      return parseAdbMdnsServices(result.stdout).map((service) => ({
        serial: service.serial, platform: 'android' as const, host: service.host, port: service.port,
        name: `${service.host}:${service.port}`, connectionStatus: 'unknown' as const,
      }))
    } catch {
      return []
    }
  }

  async connectNetwork(host: string, port: number): Promise<DeviceDiscoveryCandidate> {
    const normalizedHost = host.replace(/^\[|\]$/g, '')
    const serial = normalizedHost.includes(':') ? `[${normalizedHost}]:${port}` : `${normalizedHost}:${port}`
    try {
      await this.execute(this.adbPath, ['connect', serial], { timeoutMs: 15_000 })
      const listed = await this.execute(this.adbPath, ['devices', '-l'], { timeoutMs: 10_000 })
      const entry = parseAdbDevices(listed.stdout).find((item) => item.serial === serial)
      if (!entry) return { serial, host, port, platform: 'android', connectionStatus: 'offline' }
      return { ...(await this.describe(entry)), host, port }
    } catch {
      return { serial, host, port, platform: 'android', connectionStatus: 'offline' }
    }
  }

  async disconnect(serial: string) {
    await this.execute(this.adbPath, ['disconnect', serial], { timeoutMs: 10_000 }).catch(() => undefined)
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
      const hardwareSerial = first(props, 'ro.serialno', 'ro.boot.serialno', 'ro.vendor.serialno')
        ?? (/:\d+$/.test(entry.serial) ? undefined : entry.serial)
      const manufacturer = first(props, 'ro.product.manufacturer', 'ro.product.brand')
      const model = first(props, 'ro.product.model', 'ro.product.vendor.model') ?? fallbackModel
      const marketName = first(props, 'ro.config.marketing_name', 'ro.product.marketname')
      const androidVersion = first(props, 'ro.build.version.release')
      const apiText = first(props, 'ro.build.version.sdk')
      return {
        serial: entry.serial,
        hardwareSerial,
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
