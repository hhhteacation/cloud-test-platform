import { config } from '../config.js'
import { connect as openTcpConnection } from 'node:net'
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

function networkEndpointFromSerial(serial: string) {
  const ipv6 = serial.match(/^\[([^\]]+)\]:(\d+)$/)
  if (ipv6) return { host: ipv6[1]!, port: Number(ipv6[2]) }
  const ipv4OrHost = serial.match(/^([^:]+):(\d+)$/)
  if (!ipv4OrHost) return undefined
  const port = Number(ipv4OrHost[2])
  return Number.isInteger(port) && port > 0 && port <= 65535
    ? { host: ipv4OrHost[1]!, port }
    : undefined
}

async function waitForMdnsRetry(signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, 200)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}


export function parseAdbMdnsServices(output: string): Array<{
  serviceInstance: string
  transportType: 'tcp_legacy' | 'wireless_tls'
  host: string
  port: number
  serial: string
}> {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    if (/^List of discovered services/i.test(line) || /^adb\s+mdns/i.test(line)) return []
    const service = line.match(/^(\S+)\s+(_adb(?:-[A-Za-z0-9-]+)?\._tcp\.?)\s+/i)
    const serviceType = service?.[2]?.toLowerCase().replace(/\.$/, '')
    if (serviceType && serviceType !== '_adb._tcp' && serviceType !== '_adb-tls-connect._tcp') return []
    const matches = [...line.matchAll(/(\[[^\]]+\]|(?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(?=\s|$)/g)]
    const match = matches.at(-1)
    if (!match) return []
    const host = match[1].replace(/^\[|\]$/g, '')
    const port = Number(match[2])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return []
    const serial = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
    const serviceInstance = service?.[1] ?? serial
    // The service type is authoritative for Wireless TLS. An untyped mDNS
    // line is only safe to treat as legacy ADB when it uses the well-known
    // 5555 port; never infer tcp_legacy for a dynamic port.
    const transportType = serviceType === '_adb-tls-connect._tcp'
      ? 'wireless_tls' as const
      : serviceType === '_adb._tcp' || (!serviceType && port === 5555)
        ? 'tcp_legacy' as const
        : undefined
    if (!transportType) return []
    return [{ serviceInstance, transportType, host, port, serial }]
  })
}

/**
 * Pairing advertisements are deliberately kept separate from connect
 * services.  A pairing endpoint is only a signal that user/MDM provisioning
 * may be required; it is never a runnable ADB endpoint and must not enter the
 * normal EndpointObservation adoption path.
 */
export interface AdbMdnsPairingCandidate {
  serviceInstance: string
  host: string
  port: number
}

export function parseAdbMdnsPairingServices(output: string): AdbMdnsPairingCandidate[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    if (/^List of discovered services/i.test(line) || /^adb\s+mdns/i.test(line)) return []
    const service = line.match(/^(\S+)\s+_adb-tls-pairing\._tcp\.?\s+/i)
    if (!service) return []
    const matches = [...line.matchAll(/(\[[^\]]+\]|(?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(?=\s|$)/g)]
    const match = matches.at(-1)
    if (!match) return []
    const host = match[1]!.replace(/^\[|\]$/g, '')
    const port = Number(match[2])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return []
    return [{ serviceInstance: service[1]!, host, port }]
  })
}

export class AndroidAdbDeviceProvider implements DeviceDiscoveryProvider {
  readonly platform = 'android' as const

  constructor(
    private readonly adbPath = config.adbPath,
    private readonly execute: AdbCommandExecutor = runProcess,
  ) {}

  private async discoverMdnsServices(signal?: AbortSignal) {
    let lastError: unknown
    // mDNS responses can be empty while the daemon refreshes its service
    // cache. A single short retry avoids dropping a valid TLS service without
    // extending the overall discovery budget beyond the 5 second bound.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.execute(this.adbPath, ['mdns', 'services'], {
          timeoutMs: 2_000,
          signal,
        })
        const services = parseAdbMdnsServices(result.stdout)
        if (services.length > 0 || attempt === 1) return services
        await waitForMdnsRetry(signal)
      } catch (error) {
        lastError = error
        if (attempt === 1) throw error
        await waitForMdnsRetry(signal)
      }
    }
    if (lastError) throw lastError
    return []
  }

  async discover(options: { signal?: AbortSignal } = {}): Promise<DeviceDiscoveryCandidate[]> {
    const listed = await this.execute(this.adbPath, ['devices', '-l'], {
      timeoutMs: 10_000,
      signal: options.signal,
    })
    const entries = parseAdbDevices(listed.stdout)
    return Promise.all(entries.map((entry) => this.describe(entry, options.signal)))
  }

  async discoverNetwork(options: { signal?: AbortSignal } = {}): Promise<DeviceDiscoveryCandidate[]> {
    // mDNS and the current ADB transport list are independent observations.
    // Run them concurrently so a slow/unavailable mDNS responder cannot add
    // its timeout on top of the normal `adb devices` scan.
    const [mdnsResult, devicesResult] = await Promise.allSettled([
      this.discoverMdnsServices(options.signal),
      this.execute(this.adbPath, ['devices', '-l'], {
        timeoutMs: 10_000,
        signal: options.signal,
      }),
    ])
    if (devicesResult.status === 'rejected') {
      throw mdnsResult.status === 'rejected' ? mdnsResult.reason : devicesResult.reason
    }
    const mdnsServices = mdnsResult.status === 'fulfilled'
      ? mdnsResult.value
      : []
    const listed = parseAdbDevices(devicesResult.value.stdout)

    const byEndpoint = new Map<string, DeviceDiscoveryCandidate>()
    for (const service of mdnsServices) {
      byEndpoint.set(service.serial, {
        serial: service.serial,
        platform: 'android',
        host: service.host,
        port: service.port,
        serviceInstance: service.serviceInstance,
        networkTransport: service.transportType,
        name: `${service.host}:${service.port}`,
        connectionStatus: 'unknown',
      })
    }

    const connectedNetworkEntries = listed
      .map((entry) => ({ entry, endpoint: networkEndpointFromSerial(entry.serial) }))
      .filter((item): item is { entry: AdbListEntry; endpoint: { host: string; port: number } } => Boolean(item.endpoint))
    const described = await Promise.all(connectedNetworkEntries.map(async ({ entry, endpoint }) => {
      const serial = entry.serial
      const existing = byEndpoint.get(serial)
      const candidate = await this.describe(entry, options.signal, true)
      return {
        ...existing,
        ...candidate,
        serial,
        host: endpoint.host,
        port: endpoint.port,
        serviceInstance: existing?.serviceInstance ?? serial,
        // ADB track-devices exposes only host:port. A non-5555 port has no
        // transport identity on its own, so do not manufacture a legacy TCP
        // candidate when the matching mDNS TLS observation is absent.
        // Keeping this candidate out is safer than persisting a dynamic TLS
        // port as tcp_legacy and later reconnecting through the wrong policy.
        networkTransport: existing?.networkTransport ?? (endpoint.port === 5555
          ? 'tcp_legacy' as const
          : undefined),
        name: candidate.name ?? existing?.name ?? serial,
      }
    }))
    for (const candidate of described) {
      // Only return a connected network transport when its type is known.
      // Non-5555 ports are commonly Wireless TLS dynamic ports, but track-
      // devices cannot prove that; mDNS must supply the authoritative type.
      if (candidate.networkTransport) byEndpoint.set(candidate.serial, candidate)
    }
    return [...byEndpoint.values()]
  }

  async discoverPairingCandidates(options: { signal?: AbortSignal } = {}): Promise<AdbMdnsPairingCandidate[]> {
    const result = await this.execute(this.adbPath, ['mdns', 'services'], {
      timeoutMs: 5_000,
      signal: options.signal,
    })
    return parseAdbMdnsPairingServices(result.stdout)
  }

  async probeNetwork(host: string, port: number, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const socket = openTcpConnection({ host: host.replace(/^\[|\]$/g, ''), port })
      const finish = (reachable: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        socket.destroy()
        resolve(reachable)
      }
      const onAbort = () => finish(false)
      const timer = setTimeout(() => finish(false), 2_000)
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
    })
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
