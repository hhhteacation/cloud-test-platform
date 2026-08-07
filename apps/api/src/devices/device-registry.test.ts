import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlatformDatabase } from '../database.js'
import type { DeviceDiscoveryCandidate } from '../types.js'
import type { DeviceDiscoveryProvider } from './device-provider.js'
import { DeviceRegistrationError, DeviceRegistryService } from './device-registry.js'

class FakeAndroidProvider implements DeviceDiscoveryProvider {
  readonly platform = 'android' as const
  candidates: DeviceDiscoveryCandidate[] = []
  networkCandidates: DeviceDiscoveryCandidate[] = []
  connectResult?: DeviceDiscoveryCandidate
  disconnected: string[] = []

  async discover() { return this.candidates }
  async discoverNetwork() { return this.networkCandidates }
  async connectNetwork(host: string, port: number) {
    return this.connectResult ?? { serial: `${host}:${port}`, host, port, platform: 'android' as const, connectionStatus: 'offline' as const }
  }
  async disconnect(serial: string) { this.disconnected.push(serial) }
}

describe('DeviceRegistryService', () => {
  let rootDir: string
  let database: PlatformDatabase
  let provider: FakeAndroidProvider
  let registry: DeviceRegistryService

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'sdk-device-registry-'))
    database = new PlatformDatabase({
      databasePath: path.join(rootDir, 'cloud-test.sqlite'),
      seedDevice: false,
      markInterruptedTasks: false,
    })
    provider = new FakeAndroidProvider()
    registry = new DeviceRegistryService(database, [provider])
  })

  afterEach(async () => {
    database.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  const onlineDevice = (serial: string, hardwareSerial = serial): DeviceDiscoveryCandidate => ({
    serial,
    hardwareSerial,
    platform: 'android',
    manufacturer: 'Example',
    name: 'Example Phone',
    model: 'EX-1',
    androidVersion: '15',
    apiLevel: 35,
    architecture: 'arm64-v8a',
    buildVersion: 'EXAMPLE.1',
    securityPatch: '2026-06-01',
    connectionStatus: 'online',
  })

  async function register(serial = 'SERIAL-1') {
    provider.candidates = [onlineDevice(serial)]
    return registry.register(serial)
  }

  it('重复录入同一 Serial 保持幂等，更新属性并只维护一个 USB Endpoint', async () => {
    const first = await register()
    provider.candidates = [{ ...onlineDevice('SERIAL-1'), name: 'Renamed Phone', model: 'EX-2' }]
    const second = await registry.register('SERIAL-1')

    expect(second.id).toBe(first.id)
    expect(second.name).toBe('Renamed Phone')
    expect(second.model).toBe('EX-2')
    expect(database.listDevices()).toHaveLength(1)
    expect(database.listDeviceEndpoints(first.id)).toEqual([
      expect.objectContaining({ deviceId: first.id, kind: 'usb', adbSerial: 'SERIAL-1', status: 'online' }),
    ])
  })

  it('已存在的 Magic V3 Serial 保留历史设备 ID', async () => {
    database.upsertAdbDevice({
      id: 'honor-magic-v3', serial: 'HONOR-SERIAL', name: '荣耀 Magic V3',
      manufacturer: 'HONOR', model: 'FCP-AN10', osVersion: 'Android 16',
      apiLevel: 36, architecture: 'arm64-v8a',
    })
    provider.candidates = [{ ...onlineDevice('HONOR-SERIAL'), name: 'HONOR Magic V3' }]

    await expect(registry.register('HONOR-SERIAL')).resolves.toMatchObject({ id: 'honor-magic-v3' })
  })

  it.each([
    ['unauthorized', 'DEVICE_UNAUTHORIZED'],
    ['offline', 'DEVICE_OFFLINE'],
  ] as const)('拒绝录入 %s 设备', async (connectionStatus, code) => {
    provider.candidates = [{ ...onlineDevice('SERIAL-X'), connectionStatus }]
    await expect(registry.register('SERIAL-X')).rejects.toMatchObject<DeviceRegistrationError>({ code, statusCode: 409 })
    expect(database.listDevices()).toHaveLength(0)
  })

  it('USB 发现会标记已录入设备，并排除 adb devices 中的联网 serial', async () => {
    const registered = await register()
    database.upsertDeviceEndpoint({
      deviceId: registered.id, kind: 'network', adbSerial: '192.168.1.20:5555',
      host: '192.168.1.20', port: 5555, status: 'online',
    })
    provider.candidates.push({ ...onlineDevice('192.168.1.20:5555', 'SERIAL-1'), host: '192.168.1.20', port: 5555 })

    await expect(registry.discover()).resolves.toEqual([
      expect.objectContaining({ serial: 'SERIAL-1', registeredDeviceId: registered.id, kind: 'usb' }),
    ])
  })

  it('设备快照只读取已登记状态，不调用 Provider 或修改数据库', async () => {
    const device = await register()
    const beforeDevice = database.getDevice(device.id)
    const beforeEndpoints = database.listDeviceEndpoints(device.id)
    const discover = vi.spyOn(provider, 'discover')
    discover.mockClear()

    const [snapshot] = await registry.listRegisteredSnapshot('android')

    expect(discover).not.toHaveBeenCalled()
    expect(snapshot).toMatchObject({
      id: device.id,
      overallConnectionStatus: 'online',
      endpoints: { usb: expect.objectContaining({ adbSerial: 'SERIAL-1', status: 'online' }) },
    })
    expect(database.getDevice(device.id)).toEqual(beforeDevice)
    expect(database.listDeviceEndpoints(device.id)).toEqual(beforeEndpoints)
  })

  it('真实刷新调用 Provider、更新 Endpoint 状态并返回最新快照', async () => {
    const device = await register()
    provider.candidates = []
    const discover = vi.spyOn(provider, 'discover')
    discover.mockClear()

    const [refreshed] = await registry.refreshRegistered('android')

    expect(discover).toHaveBeenCalledTimes(1)
    expect(refreshed).toMatchObject({
      id: device.id,
      overallConnectionStatus: 'offline',
      selectable: false,
      endpoints: { usb: expect.objectContaining({ status: 'offline' }) },
    })
    expect(database.getDeviceEndpointByKind(device.id, 'usb')).toMatchObject({ status: 'offline' })
  })

  it('并发全量刷新共享一次扫描，失败后允许重新尝试', async () => {
    await register()
    let release: ((candidates: DeviceDiscoveryCandidate[]) => void) | undefined
    const pending = new Promise<DeviceDiscoveryCandidate[]>((resolve) => { release = resolve })
    const discover = vi.spyOn(provider, 'discover')
      .mockImplementationOnce(() => pending)

    const first = registry.refreshRegistered('android')
    const second = registry.refreshRegistered('android')
    expect(discover).toHaveBeenCalledTimes(1)
    release?.([onlineDevice('SERIAL-1')])
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(discover).toHaveBeenCalledTimes(1)

    discover.mockRejectedValueOnce(new Error('adb daemon unavailable'))
    await expect(registry.refreshRegistered('android')).rejects.toThrow('adb daemon unavailable')
    discover.mockResolvedValueOnce([onlineDevice('SERIAL-1')])
    await expect(registry.refreshRegistered('android')).resolves.toHaveLength(1)
    expect(discover).toHaveBeenCalledTimes(3)
  })

  it('并发任务解析共享全量扫描，但分别选择各自设备的 Endpoint', async () => {
    const firstDevice = await register('SERIAL-1')
    provider.candidates = [onlineDevice('SERIAL-2')]
    const secondDevice = await registry.register('SERIAL-2')
    provider.candidates = [onlineDevice('SERIAL-1'), onlineDevice('SERIAL-2')]
    const discover = vi.spyOn(provider, 'discover')
    discover.mockClear()

    const [firstEndpoint, secondEndpoint] = await Promise.all([
      registry.resolveExecutionEndpoint(firstDevice.id, 'auto'),
      registry.resolveExecutionEndpoint(secondDevice.id, 'auto'),
    ])

    expect(discover).toHaveBeenCalledTimes(1)
    expect(firstEndpoint).toMatchObject({ deviceId: firstDevice.id, adbSerial: 'SERIAL-1' })
    expect(secondEndpoint).toMatchObject({ deviceId: secondDevice.id, adbSerial: 'SERIAL-2' })
  })

  it('任务解析 Endpoint 前执行真实刷新，扫描失败时不使用数据库中的过期在线状态', async () => {
    const device = await register()
    const discover = vi.spyOn(provider, 'discover').mockRejectedValueOnce(new Error('adb scan failed'))

    await expect(registry.resolveExecutionEndpoint(device.id, 'auto')).rejects.toThrow('adb scan failed')
    expect(discover).toHaveBeenCalledTimes(1)
    expect(database.getDeviceEndpointByKind(device.id, 'usb')).toMatchObject({ status: 'online' })
  })

  it('同一物理设备聚合 USB 与联网 Endpoint，且 auto 优先 USB', async () => {
    const device = await register()
    database.upsertDeviceEndpoint({
      deviceId: device.id, kind: 'network', adbSerial: '192.168.1.20:5555',
      host: '192.168.1.20', port: 5555, status: 'online',
    })
    provider.candidates = [onlineDevice('SERIAL-1'), { ...onlineDevice('192.168.1.20:5555', 'SERIAL-1'), host: '192.168.1.20', port: 5555 }]

    const overview = await registry.refreshRegistered()
    expect(overview).toHaveLength(1)
    expect(overview[0]).toMatchObject({
      id: device.id, selectable: true, overallConnectionStatus: 'online', queueStatus: 'idle',
      endpoints: {
        usb: { kind: 'usb', adbSerial: 'SERIAL-1', status: 'online' },
        network: { kind: 'network', adbSerial: '192.168.1.20:5555', status: 'online' },
      },
    })
    await expect(registry.resolveExecutionEndpoint(device.id, 'auto')).resolves.toMatchObject({ kind: 'usb' })
    await expect(registry.resolveExecutionEndpoint(device.id, 'network')).resolves.toMatchObject({ kind: 'network' })
  })

  it('auto 在 USB 不可用时回退联网，显式 usb 模式不会回退', async () => {
    const device = await register()
    database.upsertDeviceEndpoint({
      deviceId: device.id, kind: 'network', adbSerial: '192.168.1.20:5555',
      host: '192.168.1.20', port: 5555, status: 'online',
    })
    provider.candidates = [{ ...onlineDevice('192.168.1.20:5555', 'SERIAL-1'), host: '192.168.1.20', port: 5555 }]

    await expect(registry.resolveExecutionEndpoint(device.id, 'auto')).resolves.toMatchObject({ kind: 'network' })
    await expect(registry.resolveExecutionEndpoint(device.id, 'usb')).rejects.toMatchObject<DeviceRegistrationError>({ code: 'DEVICE_NOT_ONLINE' })
  })

  it('联网连接成功后校验身份并绑定到已有物理设备', async () => {
    const device = await register()
    provider.connectResult = { ...onlineDevice('192.168.1.20:5555', 'SERIAL-1'), host: '192.168.1.20', port: 5555 }

    await expect(registry.connectNetwork(device.id, '192.168.1.20', 5555)).resolves.toMatchObject({
      deviceId: device.id, kind: 'network', host: '192.168.1.20', port: 5555, status: 'online',
    })
    expect(database.listDevices()).toHaveLength(1)
  })

  it('联网连接失败时保留离线 Endpoint 和错误，便于后续刷新', async () => {
    const device = await register()
    await expect(registry.connectNetwork(device.id, '192.168.1.30', 5555)).rejects.toMatchObject<DeviceRegistrationError>({ code: 'NETWORK_DEVICE_OFFLINE' })
    expect(database.getDeviceEndpointByKind(device.id, 'network')).toMatchObject({
      adbSerial: '192.168.1.30:5555', status: 'offline', lastError: 'adb connect 未能建立可用连接',
    })
  })

  it('身份不匹配或地址已绑定其他设备时不自动合并', async () => {
    const first = await register('SERIAL-1')
    provider.candidates = [onlineDevice('SERIAL-2')]
    const second = await registry.register('SERIAL-2')

    provider.connectResult = { ...onlineDevice('192.168.1.40:5555', 'SERIAL-1'), host: '192.168.1.40', port: 5555, model: 'OTHER' }
    await expect(registry.connectNetwork(first.id, '192.168.1.40', 5555)).rejects.toMatchObject<DeviceRegistrationError>({ code: 'DEVICE_IDENTITY_MISMATCH' })
    expect(database.getDeviceEndpointByKind(first.id, 'network')).toBeUndefined()

    provider.connectResult = { ...onlineDevice('192.168.1.40:5555', 'SERIAL-1'), host: '192.168.1.40', port: 5555 }
    await registry.connectNetwork(first.id, '192.168.1.40', 5555)
    await expect(registry.connectNetwork(second.id, '192.168.1.40', 5555)).rejects.toMatchObject<DeviceRegistrationError>({ code: 'NETWORK_ENDPOINT_ALREADY_BOUND' })
  })

  it('联网设备型号相同但硬件 Serial 属于另一台物理设备时拒绝绑定且不覆盖档案', async () => {
    const magicV3 = await register('MAGIC-V3-SERIAL')
    provider.candidates = [{ ...onlineDevice('X50-SERIAL'), name: '荣耀X50', manufacturer: 'HONOR', model: 'ALI-AN00' }]
    const x50 = await registry.register('X50-SERIAL')
    const before = database.getDevice(magicV3.id)

    provider.connectResult = {
      ...onlineDevice('192.168.1.128:5555', 'X50-SERIAL'),
      host: '192.168.1.128', port: 5555,
      name: before?.name, manufacturer: before?.manufacturer, model: before?.model,
    }

    await expect(registry.connectNetwork(magicV3.id, '192.168.1.128', 5555)).rejects.toMatchObject<DeviceRegistrationError>({
      code: 'DEVICE_IDENTITY_MISMATCH',
    })
    expect(database.getDevice(magicV3.id)).toEqual(before)
    expect(database.getDeviceEndpointByKind(magicV3.id, 'network')).toBeUndefined()
    expect(database.getDevice(x50.id)?.serial).toBe('X50-SERIAL')
  })

  it('无法读取联网设备硬件 Serial 时不使用型号猜测绑定', async () => {
    const device = await register('SERIAL-1')
    provider.connectResult = {
      ...onlineDevice('192.168.1.129:5555'),
      hardwareSerial: undefined,
      host: '192.168.1.129', port: 5555,
    }

    await expect(registry.connectNetwork(device.id, '192.168.1.129', 5555)).rejects.toMatchObject<DeviceRegistrationError>({
      code: 'DEVICE_IDENTITY_UNVERIFIED',
    })
    expect(database.getDeviceEndpointByKind(device.id, 'network')).toBeUndefined()
  })

  it('总览刷新不会用硬件 Serial 不匹配的联网 Endpoint 覆盖物理设备档案', async () => {
    const magicV3 = await register('MAGIC-V3-SERIAL')
    database.upsertDeviceEndpoint({
      deviceId: magicV3.id, kind: 'network', adbSerial: '192.168.1.128:5555',
      host: '192.168.1.128', port: 5555, status: 'online',
    })
    const before = database.getDevice(magicV3.id)
    provider.candidates = [{
      ...onlineDevice('192.168.1.128:5555', 'X50-SERIAL'),
      name: '荣耀X50', manufacturer: 'HONOR', model: 'ALI-AN00',
      host: '192.168.1.128', port: 5555,
    }]

    const [overview] = await registry.refreshRegistered()

    expect(overview).toMatchObject({
      id: magicV3.id,
      name: before?.name,
      model: before?.model,
      endpoints: {
        network: {
          status: 'unknown',
          lastError: expect.stringContaining('硬件身份'),
        },
      },
    })
    expect(database.getDevice(magicV3.id)).toEqual(before)
  })

  it('断开和移除联网 Endpoint 不影响 USB Endpoint 或物理设备', async () => {
    const device = await register()
    provider.connectResult = { ...onlineDevice('192.168.1.50:5555', 'SERIAL-1'), host: '192.168.1.50', port: 5555 }
    const endpoint = await registry.connectNetwork(device.id, '192.168.1.50', 5555)

    await expect(registry.disconnectNetwork(device.id, endpoint.id)).resolves.toMatchObject({ status: 'offline' })
    expect(provider.disconnected).toEqual(['192.168.1.50:5555'])
    await expect(registry.removeNetworkEndpoint(device.id, endpoint.id)).resolves.toBe(true)
    expect(provider.disconnected).toEqual(['192.168.1.50:5555', '192.168.1.50:5555'])
    expect(database.getDevice(device.id)).toBeDefined()
    expect(database.getDeviceEndpointByKind(device.id, 'usb')).toBeDefined()
  })
})
