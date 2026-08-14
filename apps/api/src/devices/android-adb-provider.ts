import { config } from '../config.js'
import { ProcessError, runProcess, type ProcessResult, type RunProcessOptions } from '../process.js'
import type { DeviceDiscoveryCandidate, DeviceConnectionStatus } from '../types.js'
import type { DeviceDiscoveryProvider } from './device-provider.js'

export type AdbCommandExecutor = (
  command: string,
  args: string[],
  options?: Pick<RunProcessOptions, 'timeoutMs' | 'signal'>,
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

  async connectNetwork(host: string, port: number, options: { signal?: AbortSignal } = {}): Promise<DeviceDiscoveryCandidate> {
    const normalizedHost = host.replace(/^\[|\]$/g, '')
    const serial = normalizedHost.includes(':') ? `[${normalizedHost}]:${port}` : `${normalizedHost}:${port}`
    try {
      const connect = await this.execute(this.adbPath, ['connect', serial], { timeoutMs: 15_000, signal: options.signal })
      const listed = await this.execute(this.adbPath, ['devices', '-l'], { timeoutMs: 10_000, signal: options.signal })
      const entry = parseAdbDevices(listed.stdout).find((item) => item.serial === serial)
      if (!entry) {
        const detail = `${connect.stdout}\n${connect.stderr}`.trim()
        const code = classifyAdbDiagnostic(detail)
        return {
          serial, host, port, platform: 'android', connectionStatus: 'offline',
          ...diagnostic(code, diagnosticMessage(connect, 'adb devices 未返回目标联网设备'), connect),
        }
      }
      const described = await this.describe(entry, options.signal, true)
      if (described.connectionStatus !== 'online' && !described.failureCode) {
        const code = described.connectionStatus === 'unauthorized' ? 'ADB_UNAUTHORIZED' : described.connectionStatus === 'offline' ? 'ADB_DEVICE_OFFLINE' : 'ADB_COMMAND_FAILED'
        return {
          ...described, host, port,
          ...diagnostic(code, described.connectionStatus === 'unauthorized' ? 'ADB 设备未授权' : `ADB 设备状态：${described.connectionStatus}`, connect),
        }
      }
      return { ...described, host, port }
    } catch (error) {
      // Cancellation is a domain-visible outcome, not an offline diagnosis. Keep
      // the ProcessRunner result so the operation store can retain the evidence
      // collected before the adb child was terminated.
      if (options.signal?.aborted) {
        const evidence = error instanceof ProcessError ? error.result : undefined
        return {
          serial, host, port, platform: 'android', connectionStatus: 'offline',
          ...diagnostic('NETWORK_CONNECTION_CANCELLED', error instanceof Error ? error.message : '联网连接已取消', evidence),
        }
      }
      if (error instanceof ProcessError) {
        const evidence = error.result
        const message = evidence?.stderr.trim() || evidence?.stdout.trim() || error.message
        return {
          serial, host, port, platform: 'android', connectionStatus: 'offline',
          ...diagnostic(classifyAdbFailure(error, message), message, evidence),
        }
      }
      return { serial, host, port, platform: 'android', connectionStatus: 'offline', failureCode: 'ADB_COMMAND_FAILED', failureMessage: error instanceof Error ? error.message : String(error) }
    }
  }

  async disconnect(serial: string) {
    await this.execute(this.adbPath, ['disconnect', serial], { timeoutMs: 10_000 }).catch(() => undefined)
  }

  private async describe(entry: AdbListEntry, signal?: AbortSignal, includeDiagnostics = false): Promise<DeviceDiscoveryCandidate> {
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
        { timeoutMs: 15_000, signal },
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
    } catch (error) {
      if (signal?.aborted) throw error
      return {
        serial: entry.serial,
        platform: 'android',
        model: fallbackModel,
        name: fallbackModel ?? entry.serial,
        connectionStatus: 'unknown',
        ...(includeDiagnostics ? {
          failureCode: error instanceof ProcessError ? classifyAdbFailure(error, error.result?.stderr || error.message) : 'ADB_COMMAND_FAILED',
          failureMessage: error instanceof Error ? error.message : String(error),
          ...(error instanceof ProcessError && error.result ? diagnosticEvidence(error.result) : {}),
        } : {}),
      }
    }
  }
}

function diagnosticEvidence(result?: ProcessResult) {
  return result ? {
    adbExitCode: result.code,
    adbStdout: result.stdout,
    adbStderr: result.stderr,
    adbStdoutTruncated: result.stdoutTruncated,
    adbStderrTruncated: result.stderrTruncated,
  } : {}
}

function diagnosticMessage(result: ProcessResult | undefined, fallback: string) {
  return result?.stderr.trim() || result?.stdout.trim() || fallback
}

function diagnostic(code: string, message: string, result?: ProcessResult) {
  return { failureCode: code, failureMessage: message, ...diagnosticEvidence(result) }
}

function classifyAdbDiagnostic(detail: string) {
  const value = detail.toLowerCase()
  if (value.includes('timeout') || value.includes('timed out') || value.includes('超时')) return 'ADB_CONNECT_TIMEOUT'
  if (value.includes('refused') || value.includes('拒绝')) return 'ADB_PORT_REFUSED'
  if (value.includes('unreachable') || value.includes('no route') || value.includes('network is down')) return 'ADB_NETWORK_UNREACHABLE'
  if (value.includes('unauthorized') || value.includes('未授权')) return 'ADB_UNAUTHORIZED'
  if (value.includes('offline')) return 'ADB_DEVICE_OFFLINE'
  return 'ADB_COMMAND_FAILED'
}

function classifyAdbFailure(error: ProcessError, detail: string) {
  return classifyAdbDiagnostic(`${error.message} ${detail}`)
}
