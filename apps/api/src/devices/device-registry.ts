import { createHash } from 'node:crypto'

import type { PlatformDatabase } from '../database.js'
import type { DeviceDiscoveryCandidate, DevicePlatform, DeviceProfile } from '../types.js'
import type { DeviceDiscoveryProvider } from './device-provider.js'

export class DeviceRegistrationError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 400) {
    super(message)
  }
}

function stableDeviceId(serial: string) {
  return `adb-${createHash('sha256').update(serial).digest('hex').slice(0, 16)}`
}

/**
 * Coordinates platform-specific discovery with persistent device profiles.
 * Routes and task scheduling never need to know how ADB/getprop works.
 */
export class DeviceRegistryService {
  private readonly providers = new Map<DevicePlatform, DeviceDiscoveryProvider>()

  constructor(
    private readonly database: PlatformDatabase,
    providers: DeviceDiscoveryProvider[],
  ) {
    for (const provider of providers) this.providers.set(provider.platform, provider)
  }

  async discover(platform: DevicePlatform = 'android') {
    const provider = this.providers.get(platform)
    if (!provider) throw new DeviceRegistrationError(`${platform} 设备发现尚未实现`, 'PLATFORM_NOT_AVAILABLE', 409)
    const candidates = await provider.discover()
    return candidates.map((candidate) => ({
      ...candidate,
      registeredDeviceId: this.database.getDeviceBySerial(candidate.serial)?.id,
    }))
  }

  async listRegistered(platform: DevicePlatform = 'android'): Promise<DeviceProfile[]> {
    const devices = this.database.listDevices().filter((device) => device.platform === platform)
    const discovered = await this.discover(platform).catch(() => [] as DeviceDiscoveryCandidate[])
    const liveBySerial = new Map(discovered.map((candidate) => [candidate.serial, candidate]))

    return devices.map((device) => {
      const live = device.serial ? liveBySerial.get(device.serial) : undefined
      if (live?.connectionStatus === 'online') this.database.markDeviceSeen(device.id)
      return {
        ...device,
        connectionStatus: live?.connectionStatus ?? 'offline',
        ...(live ? {
          name: live.name ?? device.name,
          manufacturer: live.manufacturer ?? device.manufacturer,
          model: live.model ?? device.model,
          osVersion: live.androidVersion ? `Android ${live.androidVersion}` : device.osVersion,
          apiLevel: live.apiLevel ?? device.apiLevel,
          architecture: live.architecture ?? device.architecture,
          buildVersion: live.buildVersion ?? device.buildVersion,
          securityPatch: live.securityPatch ?? device.securityPatch,
        } : {}),
      }
    })
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
}
