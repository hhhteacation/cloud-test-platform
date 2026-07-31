import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PlatformDatabase } from '../database.js'
import type { DeviceDiscoveryCandidate } from '../types.js'
import type { DeviceDiscoveryProvider } from './device-provider.js'
import { DeviceRegistrationError, DeviceRegistryService } from './device-registry.js'

class FakeAndroidProvider implements DeviceDiscoveryProvider {
  readonly platform = 'android' as const
  candidates: DeviceDiscoveryCandidate[] = []
  async discover() { return this.candidates }
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

  const onlineDevice = (serial: string): DeviceDiscoveryCandidate => ({
    serial,
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

  it('重复录入同一 Serial 保持幂等，并更新设备属性', async () => {
    provider.candidates = [onlineDevice('SERIAL-1')]
    const first = await registry.register('SERIAL-1')
    provider.candidates = [{ ...onlineDevice('SERIAL-1'), name: 'Renamed Phone', model: 'EX-2' }]
    const second = await registry.register('SERIAL-1')

    expect(second.id).toBe(first.id)
    expect(second.name).toBe('Renamed Phone')
    expect(second.model).toBe('EX-2')
    expect(database.listDevices()).toHaveLength(1)
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

  it('发现结果会标记已经录入的设备 ID', async () => {
    provider.candidates = [onlineDevice('SERIAL-1')]
    const registered = await registry.register('SERIAL-1')
    await expect(registry.discover()).resolves.toEqual([
      expect.objectContaining({ serial: 'SERIAL-1', registeredDeviceId: registered.id }),
    ])
  })
})
