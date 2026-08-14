import { createHash } from 'node:crypto'

import type { PlatformDatabase } from '../database.js'
import type {
  DeviceConnectionKind,
  DeviceConnectionStatus,
  DeviceDiscoveryCandidate,
  DeviceEndpoint,
  DevicePlatform,
  DeviceProfile,
  TaskConnectionMode,
  NetworkConnectionOperationStart,
} from '../types.js'
import type { DeviceDiscoveryProvider } from './device-provider.js'

export class DeviceRegistrationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
    readonly evidence?: {
      adbExitCode?: number
      adbStdout?: string
      adbStderr?: string
      adbStdoutTruncated?: boolean
      adbStderrTruncated?: boolean
    },
  ) {
    super(message)
    this.name = 'DeviceRegistrationError'
  }
}

function stableDeviceId(serial: string) {
  return `adb-${createHash('sha256').update(serial).digest('hex').slice(0, 16)}`
}

function endpointMap(endpoints: DeviceEndpoint[]) {
  return Object.fromEntries(endpoints.map((endpoint) => [endpoint.kind, endpoint])) as Partial<Record<DeviceConnectionKind, DeviceEndpoint>>
}

function overallStatus(endpoints: DeviceEndpoint[]): DeviceConnectionStatus {
  if (endpoints.some((endpoint) => endpoint.status === 'online')) return 'online'
  if (endpoints.some((endpoint) => endpoint.status === 'unauthorized')) return 'unauthorized'
  if (endpoints.some((endpoint) => endpoint.status === 'offline')) return 'offline'
  return 'unknown'
}

function likelyNetworkSerial(serial: string) {
  return /:\d+$/.test(serial) || /^\[[^\]]+\]:\d+$/.test(serial)
}

function networkSerial(host: string, port: number) {
  const normalizedHost = host.replace(/^\[|\]$/g, '')
  return normalizedHost.includes(':') ? `[${normalizedHost}]:${port}` : `${normalizedHost}:${port}`
}

function normalizeIdentity(value?: string) {
  return value?.trim().toLowerCase()
}

function unavailableReason(device: DeviceProfile, endpoints: DeviceEndpoint[]) {
  if (device.platform !== 'android' || device.executionMode !== 'adb') return '设备不是 Android ADB 真机'
  if (!device.eligible) return '设备当前不可调度'
  if (endpoints.some((endpoint) => endpoint.status === 'online')) return undefined
  if (endpoints.some((endpoint) => endpoint.kind === 'usb' && endpoint.status === 'unauthorized')) return 'USB 调试未授权，且没有可用的联网连接'
  if (endpoints.length === 0) return 'USB 和联网 Endpoint 均未配置'
  return 'USB 和联网连接均不可用'
}

/**
 * Device Registry is the deep device-domain module. Routes and task creation use
 * this small interface instead of understanding ADB commands, endpoint identity,
 * persistence, or connection selection rules.
 */
export class DeviceRegistryService {
  private readonly providers = new Map<DevicePlatform, DeviceDiscoveryProvider>()
  private readonly registeredRefreshes = new Map<DevicePlatform, Promise<DeviceProfile[]>>()
  private readonly networkOperationControllers = new Map<string, AbortController>()
  private readonly networkEndpointLocks = new Set<string>()

  constructor(
    private readonly database: PlatformDatabase,
    providers: DeviceDiscoveryProvider[],
  ) {
    for (const provider of providers) this.providers.set(provider.platform, provider)
  }

  private provider(platform: DevicePlatform) {
    const provider = this.providers.get(platform)
    if (!provider) throw new DeviceRegistrationError(`${platform} 设备发现尚未实现`, 'PLATFORM_NOT_AVAILABLE', 409)
    return provider
  }

  /** USB discovery intentionally excludes already connected network ADB serials. */
  async discover(platform: DevicePlatform = 'android') {
    const candidates = await this.provider(platform).discover()
    return candidates.flatMap((candidate) => {
      const endpoint = this.database.getDeviceEndpointBySerial(candidate.serial)
      const kind = endpoint?.kind ?? candidate.kind ?? (likelyNetworkSerial(candidate.serial) ? 'network' : 'usb')
      if (kind !== 'usb') return []
      return [{
        ...candidate,
        kind: 'usb' as const,
        registeredDeviceId: endpoint?.deviceId ?? this.database.getDeviceBySerial(candidate.serial)?.id,
      }]
    })
  }

  async discoverNetwork(platform: DevicePlatform = 'android') {
    const provider = this.provider(platform)
    if (!provider.discoverNetwork) return []
    const candidates = await provider.discoverNetwork()
    const devices = this.database.listDevices()
    return candidates.map((candidate) => {
      const registeredDeviceId = candidate.host && candidate.port
        ? devices.find((device) => this.database.listDeviceEndpoints(device.id).some((endpoint) => (
          endpoint.kind === 'network' && endpoint.host === candidate.host && endpoint.port === candidate.port
        )))?.id
        : this.database.getDeviceEndpointBySerial(candidate.serial)?.deviceId
      return { ...candidate, kind: 'network' as const, registeredDeviceId }
    })
  }

  /** Read the persisted device/Endpoint/queue snapshot without performing discovery or writes. */
  async listRegisteredSnapshot(platform: DevicePlatform = 'android'): Promise<DeviceProfile[]> {
    return this.buildRegisteredSnapshot(platform)
  }

  /**
   * Refresh registered devices from the platform provider. Concurrent full refreshes
   * for the same platform share one scan instead of queueing duplicate ADB work.
   */
  refreshRegistered(platform: DevicePlatform = 'android'): Promise<DeviceProfile[]> {
    this.assertNoActiveNetworkOperation()
    const activeRefresh = this.registeredRefreshes.get(platform)
    if (activeRefresh) return activeRefresh

    const refresh = this.performRegisteredRefresh(platform)
    this.registeredRefreshes.set(platform, refresh)
    const clear = () => {
      if (this.registeredRefreshes.get(platform) === refresh) this.registeredRefreshes.delete(platform)
    }
    void refresh.then(clear, clear)
    return refresh
  }

  private buildRegisteredSnapshot(platform: DevicePlatform): DeviceProfile[] {
    return this.database.listDevices()
      .filter((device) => device.platform === platform)
      .map((device) => {
        const endpoints = this.database.listDeviceEndpoints(device.id)
        const status = overallStatus(endpoints)
        const reason = unavailableReason(device, endpoints)
        return {
          ...device,
          endpoints: endpointMap(endpoints),
          connectionStatus: status,
          overallConnectionStatus: status,
          selectable: !reason,
          unavailableReason: reason,
          queueStatus: this.database.getDeviceQueueStatus(device.id),
        }
      })
  }

  private async performRegisteredRefresh(platform: DevicePlatform): Promise<DeviceProfile[]> {
    const devices = this.database.listDevices().filter((device) => device.platform === platform)
    const discovered = await this.provider(platform).discover()
    const liveBySerial = new Map(discovered.map((candidate) => [candidate.serial, candidate]))

    for (const device of devices) {
      const storedEndpoints = this.database.listDeviceEndpoints(device.id)
      const verifiedLiveByEndpointId = new Map<string, DeviceDiscoveryCandidate>()
      const endpoints = storedEndpoints.map((endpoint) => {
        const live = liveBySerial.get(endpoint.adbSerial)
        if (live?.connectionStatus === 'online' && endpoint.kind === 'network') {
          const identityError = this.networkIdentityError(device, live)
          if (identityError) {
            return this.database.updateDeviceEndpointStatus(endpoint.id, 'unknown', identityError) ?? endpoint
          }
        }
        if (live) verifiedLiveByEndpointId.set(endpoint.id, live)
        const nextStatus = live?.connectionStatus ?? 'offline'
        return this.database.updateDeviceEndpointStatus(endpoint.id, nextStatus) ?? endpoint
      })

      const liveCandidates = endpoints
        .map((endpoint) => ({ endpoint, candidate: verifiedLiveByEndpointId.get(endpoint.id) }))
        .filter((entry): entry is { endpoint: DeviceEndpoint; candidate: DeviceDiscoveryCandidate } => Boolean(entry.candidate))
      const preferred = liveCandidates.find((entry) => entry.endpoint.kind === 'usb' && entry.candidate.connectionStatus === 'online')
        ?? liveCandidates.find((entry) => entry.candidate.connectionStatus === 'online')
        ?? liveCandidates.find((entry) => entry.endpoint.kind === 'usb')
        ?? liveCandidates[0]
      const live = preferred?.candidate

      if (endpoints.some((endpoint) => endpoint.status === 'online')) this.database.markDeviceSeen(device.id)
      if (live?.connectionStatus === 'online') this.updateDeviceFromCandidate(device.id, live)
    }

    return this.listRegisteredSnapshot(platform)
  }

  async register(serial: string, platform: DevicePlatform = 'android') {
    if (!serial.trim()) throw new DeviceRegistrationError('ADB Serial 不能为空', 'INVALID_DEVICE_SERIAL')
    const candidate = (await this.discover(platform)).find((item) => item.serial === serial)
    if (!candidate) throw new DeviceRegistrationError('设备当前未连接', 'DEVICE_OFFLINE', 409)
    if (candidate.connectionStatus === 'unauthorized') {
      throw new DeviceRegistrationError('请在手机上确认 USB 调试授权后重新扫描', 'DEVICE_UNAUTHORIZED', 409)
    }
    if (candidate.connectionStatus !== 'online') {
      throw new DeviceRegistrationError('设备当前不可录入，请检查 ADB 连接', 'DEVICE_OFFLINE', 409)
    }

    const existing = this.database.getDeviceBySerial(serial)
    return this.database.upsertAdbDevice({
      id: existing?.id ?? stableDeviceId(serial),
      serial,
      name: candidate.name ?? candidate.model ?? serial,
      manufacturer: candidate.manufacturer ?? 'Android',
      model: candidate.model,
      osVersion: candidate.androidVersion ? `Android ${candidate.androidVersion}` : 'Android',
      apiLevel: candidate.apiLevel ?? 0,
      architecture: candidate.architecture ?? 'unknown',
      buildVersion: candidate.buildVersion,
      securityPatch: candidate.securityPatch,
    })
  }

  async resolveExecutionEndpoint(deviceId: string, mode: TaskConnectionMode = 'auto') {
    const device = (await this.refreshRegistered('android')).find((item) => item.id === deviceId)
    if (!device) throw new DeviceRegistrationError(`设备 ${deviceId} 尚未录入`, 'DEVICE_NOT_REGISTERED')
    if (device.platform !== 'android' || device.executionMode !== 'adb' || !device.eligible) {
      throw new DeviceRegistrationError(`${device.name} 不能执行 Android ADB 真机任务`, 'DEVICE_NOT_ELIGIBLE')
    }
    const candidates = [
      ...(mode === 'network' ? [] : [device.endpoints?.usb]),
      ...(mode === 'usb' ? [] : [device.endpoints?.network]),
    ].filter(Boolean) as DeviceEndpoint[]
    const endpoint = candidates.find((item) => item.status === 'online' && item.adbSerial)
    if (!endpoint) {
      const modeLabel = mode === 'usb' ? 'USB' : mode === 'network' ? '联网' : 'USB 或联网'
      throw new DeviceRegistrationError(`${device.name} 当前没有可用的${modeLabel} ADB 连接`, 'DEVICE_NOT_ONLINE', 409)
    }
    return endpoint
  }

  async connectNetwork(deviceId: string, host: string, port: number) {
    this.assertNoActiveNetworkOperation()
    return this.connectNetworkInternal(deviceId, host, port)
  }

  private async connectNetworkInternal(deviceId: string, host: string, port: number, options: { signal?: AbortSignal; detailedFailure?: boolean } = {}) {
    const device = this.database.getDevice(deviceId)
    if (!device) throw new DeviceRegistrationError('物理设备不存在', 'DEVICE_NOT_FOUND', 404)
    const normalizedHost = host?.trim().replace(/^\[|\]$/g, '')
    if (!normalizedHost || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new DeviceRegistrationError('请输入有效的主机名/IP 和端口', 'INVALID_NETWORK_ENDPOINT')
    }

    const serial = networkSerial(normalizedHost, port)
    const existingBinding = this.findNetworkEndpoint(normalizedHost, port, serial)
    if (existingBinding && existingBinding.deviceId !== deviceId) {
      throw new DeviceRegistrationError('该联网 Endpoint 已绑定到另一台物理设备，需要人工确认，系统不会自动合并', 'NETWORK_ENDPOINT_ALREADY_BOUND', 409)
    }

    const provider = this.provider('android')
    if (!provider.connectNetwork) throw new DeviceRegistrationError('当前 Android Provider 不支持联网 ADB', 'NETWORK_ADB_NOT_AVAILABLE', 409)
    const candidate = await provider.connectNetwork(normalizedHost, port, options)
    if (candidate.connectionStatus !== 'online') {
      const evidence = {
        adbExitCode: candidate.adbExitCode,
        adbStdout: candidate.adbStdout,
        adbStderr: candidate.adbStderr,
        adbStdoutTruncated: candidate.adbStdoutTruncated,
        adbStderrTruncated: candidate.adbStderrTruncated,
      }
      const cancelled = options.signal?.aborted || candidate.failureCode === 'NETWORK_CONNECTION_CANCELLED'
      if (cancelled) {
        throw new DeviceRegistrationError(
          candidate.failureMessage ?? '联网连接已取消',
          'NETWORK_CONNECTION_CANCELLED',
          409,
          evidence,
        )
      }
      const endpoint = this.database.upsertDeviceEndpoint({
        deviceId,
        kind: 'network',
        adbSerial: serial,
        host: normalizedHost,
        port,
        status: candidate.connectionStatus,
        lastError: candidate.failureMessage ?? 'adb connect 未能建立可用连接',
      })
      throw new DeviceRegistrationError(
        `联网设备连接失败：${endpoint.lastError}`,
        options.detailedFailure ? candidate.failureCode ?? 'ADB_DEVICE_OFFLINE' : 'NETWORK_DEVICE_OFFLINE',
        409,
        {
          adbExitCode: candidate.adbExitCode,
          adbStdout: candidate.adbStdout,
          adbStderr: candidate.adbStderr,
          adbStdoutTruncated: candidate.adbStdoutTruncated,
          adbStderrTruncated: candidate.adbStderrTruncated,
        },
      )
    }

    this.assertNetworkIdentityMatches(device, candidate)
    this.updateDeviceFromCandidate(device.id, candidate)
    this.database.markDeviceSeen(device.id)
    return this.database.upsertDeviceEndpoint({
      deviceId,
      kind: 'network',
      adbSerial: candidate.serial,
      host: normalizedHost,
      port,
      status: 'online',
    })
  }

  async disconnectNetwork(deviceId: string, endpointId: string) {
    this.assertNoActiveNetworkOperation()
    const endpoint = this.requireNetworkEndpoint(deviceId, endpointId)
    await this.provider('android').disconnect?.(endpoint.adbSerial)
    return this.database.updateDeviceEndpointStatus(endpoint.id, 'offline')
  }

  async refreshNetwork(deviceId: string, endpointId: string) {
    this.assertNoActiveNetworkOperation()
    const endpoint = this.requireNetworkEndpoint(deviceId, endpointId)
    if (!endpoint.host || !endpoint.port) throw new DeviceRegistrationError('联网 Endpoint 缺少主机地址', 'INVALID_NETWORK_ENDPOINT')
    return this.connectNetworkInternal(deviceId, endpoint.host, endpoint.port)
  }

  async removeNetworkEndpoint(deviceId: string, endpointId: string) {
    this.assertNoActiveNetworkOperation()
    const endpoint = this.requireNetworkEndpoint(deviceId, endpointId)
    await this.provider('android').disconnect?.(endpoint.adbSerial)
    return this.database.removeDeviceEndpoint(endpointId)
  }

  startNetworkConnectionOperation(): NetworkConnectionOperationStart {
    if (this.database.hasActiveNetworkConnectionOperation()) {
      throw new DeviceRegistrationError('已有联网批量连接操作正在执行', 'NETWORK_CONNECT_OPERATION_ALREADY_RUNNING', 409)
    }
    const items = this.database.listDevices()
      .flatMap((device) => {
        const endpoint = this.database.listDeviceEndpoints(device.id).find((item) => item.kind === 'network' && item.host && item.port)
        if (!endpoint?.host || !endpoint.port) return []
        return [{ deviceId: device.id, endpointId: endpoint.id, host: endpoint.host, port: endpoint.port }]
      })
    if (items.length === 0) {
      throw new DeviceRegistrationError('没有配置联网 Endpoint 的设备', 'NO_NETWORK_ENDPOINTS', 409)
    }
    const operation = this.database.networkConnectionOperations.create({ items })
    const controller = new AbortController()
    this.networkOperationControllers.set(operation.id, controller)
    void this.runNetworkConnectionOperation(operation.id, controller)
    return { operationId: operation.id, status: operation.status, totalCount: operation.totalCount }
  }

  getNetworkConnectionOperation(operationId: string) {
    const operation = this.database.getNetworkConnectionOperation(operationId)
    if (!operation) throw new DeviceRegistrationError('联网批量连接操作不存在', 'NETWORK_CONNECT_OPERATION_NOT_FOUND', 404)
    return operation
  }

  cancelNetworkConnectionOperation(operationId: string) {
    const operation = this.getNetworkConnectionOperation(operationId)
    if (operation.status === 'queued' || operation.status === 'running') {
      this.database.networkConnectionOperations.requestCancel(operationId)
      this.networkOperationControllers.get(operationId)?.abort()
    }
    return this.getNetworkConnectionOperation(operationId)
  }

  private assertNoActiveNetworkOperation() {
    if (this.database.hasActiveNetworkConnectionOperation()) {
      throw new DeviceRegistrationError('批量联网连接正在执行，当前单台操作被拒绝', 'NETWORK_CONNECT_OPERATION_CONFLICT', 409)
    }
  }

  private async runNetworkConnectionOperation(operationId: string, controller: AbortController) {
    const store = this.database.networkConnectionOperations
    try {
      store.markRunning(operationId)
      const operation = store.get(operationId)
      if (!operation) return
      let cursor = 0
      const worker = async () => {
        while (true) {
          const current = store.get(operationId)
          if (!current || cursor >= current.items.length) return
          const item = current.items[cursor++]
          if (store.isCancelRequested(operationId)) {
            store.updateItem(item.id, {
              status: 'cancelled',
              failureCode: 'NETWORK_CONNECTION_CANCELLED',
              failureMessage: '联网连接已取消',
              cancelReason: current.cancelReason ?? 'USER_REQUESTED',
              finishedAt: new Date().toISOString(),
            })
            continue
          }
          const device = this.database.getDevice(item.deviceId)
          const queueStatus = device ? this.database.getDeviceQueueStatus(device.id) : 'idle'
          if (queueStatus === 'queued' || queueStatus === 'running') {
            store.updateItem(item.id, { status: 'skipped', skipReason: 'DEVICE_BUSY', failureCode: 'DEVICE_BUSY', failureMessage: '设备正在执行测试任务', finishedAt: new Date().toISOString() })
            continue
          }
          if (this.networkEndpointLocks.has(item.endpointId)) {
            store.updateItem(item.id, { status: 'skipped', skipReason: 'NETWORK_ENDPOINT_BUSY', failureCode: 'NETWORK_ENDPOINT_BUSY', failureMessage: '该联网 Endpoint 正在执行其他连接操作', finishedAt: new Date().toISOString() })
            continue
          }
          this.networkEndpointLocks.add(item.endpointId)
          store.updateItem(item.id, { status: 'running', startedAt: new Date().toISOString() })
          try {
            await this.connectNetworkInternal(item.deviceId, item.host, item.port, { signal: controller.signal, detailedFailure: true })
            store.updateItem(item.id, { status: 'succeeded', finishedAt: new Date().toISOString() })
          } catch (error) {
            const cancelled = controller.signal.aborted || store.isCancelRequested(operationId)
            const registrationError = error instanceof DeviceRegistrationError ? error : undefined
            store.updateItem(item.id, {
              status: cancelled ? 'cancelled' : 'failed',
              failureCode: cancelled ? 'NETWORK_CONNECTION_CANCELLED' : registrationError?.code ?? 'ADB_COMMAND_FAILED',
              failureMessage: cancelled ? '联网连接已取消' : registrationError?.message ?? (error instanceof Error ? error.message : String(error)),
              adbExitCode: registrationError?.evidence?.adbExitCode,
              adbStdout: registrationError?.evidence?.adbStdout,
              adbStderr: registrationError?.evidence?.adbStderr,
              adbStdoutTruncated: registrationError?.evidence?.adbStdoutTruncated,
              adbStderrTruncated: registrationError?.evidence?.adbStderrTruncated,
              cancelReason: cancelled ? store.get(operationId)?.cancelReason ?? 'USER_REQUESTED' : undefined,
              finishedAt: new Date().toISOString(),
            })
          } finally {
            this.networkEndpointLocks.delete(item.endpointId)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, operation.items.length) }, () => worker()))
      const final = store.get(operationId)
      if (!final) return
      const hasPending = final.items.some((item) => item.status === 'pending' || item.status === 'running')
      if (hasPending || store.isCancelRequested(operationId)) {
        for (const item of final.items.filter((candidate) => candidate.status === 'pending' || candidate.status === 'running')) {
          store.updateItem(item.id, { status: 'cancelled', failureCode: 'NETWORK_CONNECTION_CANCELLED', failureMessage: '联网连接已取消', cancelReason: final.cancelReason ?? 'USER_REQUESTED', finishedAt: new Date().toISOString() })
        }
        store.finish(operationId, 'cancelled', final.cancelReason ?? 'USER_REQUESTED')
      } else {
        store.finish(operationId, 'completed')
      }
      store.purgeCompleted(100)
    } catch (error) {
      const current = store.get(operationId)
      if (current) {
        for (const item of current.items.filter((candidate) => candidate.status === 'pending' || candidate.status === 'running')) {
          store.updateItem(item.id, { status: 'failed', failureCode: 'NETWORK_CONNECT_OPERATION_FAILED', failureMessage: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() })
        }
        store.finish(operationId, 'failed')
      }
    } finally {
      this.networkOperationControllers.delete(operationId)
    }
  }

  private findNetworkEndpoint(host: string, port: number, adbSerial: string) {
    const bySerial = this.database.getDeviceEndpointBySerial(adbSerial)
    if (bySerial) return bySerial
    for (const device of this.database.listDevices()) {
      const endpoint = this.database.getDeviceEndpointByKind(device.id, 'network')
      if (endpoint?.host === host && endpoint.port === port) return endpoint
    }
    return undefined
  }

  private requireNetworkEndpoint(deviceId: string, endpointId: string) {
    const endpoint = this.database.getDeviceEndpoint(endpointId)
    if (!endpoint || endpoint.deviceId !== deviceId || endpoint.kind !== 'network') {
      throw new DeviceRegistrationError('联网 Endpoint 不存在', 'ENDPOINT_NOT_FOUND', 404)
    }
    return endpoint
  }

  private networkIdentityError(device: DeviceProfile, candidate: DeviceDiscoveryCandidate) {
    const expectedHardwareSerial = normalizeIdentity(device.serial)
    const candidateHardwareSerial = normalizeIdentity(candidate.hardwareSerial)
    if (!candidateHardwareSerial) {
      return '无法读取联网设备硬件身份，需要人工确认，系统不会自动绑定'
    }
    if (!expectedHardwareSerial || candidateHardwareSerial !== expectedHardwareSerial) {
      return '联网设备硬件身份与目标物理设备不匹配，需要人工确认，系统不会自动绑定'
    }

    const owner = candidate.hardwareSerial ? this.database.getDeviceBySerial(candidate.hardwareSerial) : undefined
    if (owner && owner.id !== device.id) {
      return '联网设备硬件身份已属于另一台物理设备，需要人工确认，系统不会自动绑定'
    }

    const normalize = (value?: string) => value?.trim().toLowerCase().replaceAll('_', ' ')
    const modelMatches = !candidate.model || !device.model || normalize(candidate.model) === normalize(device.model)
    const manufacturerMatches = !candidate.manufacturer || !device.manufacturer || normalize(candidate.manufacturer) === normalize(device.manufacturer)
    if (!modelMatches || !manufacturerMatches) {
      return '联网设备资料与目标物理设备不匹配，需要人工确认，系统不会自动绑定'
    }
    return undefined
  }

  private assertNetworkIdentityMatches(device: DeviceProfile, candidate: DeviceDiscoveryCandidate) {
    const identityError = this.networkIdentityError(device, candidate)
    if (identityError) {
      throw new DeviceRegistrationError(
        identityError,
        candidate.hardwareSerial ? 'DEVICE_IDENTITY_MISMATCH' : 'DEVICE_IDENTITY_UNVERIFIED',
        409,
        {
          adbExitCode: candidate.adbExitCode,
          adbStdout: candidate.adbStdout,
          adbStderr: candidate.adbStderr,
          adbStdoutTruncated: candidate.adbStdoutTruncated,
          adbStderrTruncated: candidate.adbStderrTruncated,
        },
      )
    }
  }

  private updateDeviceFromCandidate(deviceId: string, candidate: DeviceDiscoveryCandidate) {
    this.database.devices.updateProfile(deviceId, {
      name: candidate.name,
      manufacturer: candidate.manufacturer,
      model: candidate.model,
      osVersion: candidate.androidVersion ? `Android ${candidate.androidVersion}` : undefined,
      apiLevel: candidate.apiLevel,
      architecture: candidate.architecture,
      buildVersion: candidate.buildVersion,
      securityPatch: candidate.securityPatch,
    })
  }
}
