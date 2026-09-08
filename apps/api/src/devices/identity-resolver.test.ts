import { describe, expect, it } from 'vitest'

import type { DeviceDiscoveryCandidate, DeviceProfile } from '../types.js'
import { resolveDeviceIdentity } from './identity-resolver.js'

function device(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    id: 'device-1', platform: 'android', name: 'Phone', manufacturer: 'Example',
    model: 'EX-1', executionMode: 'adb', eligible: true, serial: 'HARDWARE-1',
    ...overrides,
  }
}

function candidate(overrides: Partial<DeviceDiscoveryCandidate> = {}): DeviceDiscoveryCandidate {
  return {
    serial: '192.0.2.10:5555', hardwareSerial: 'HARDWARE-1', platform: 'android',
    manufacturer: 'Example', model: 'EX-1', connectionStatus: 'online',
    ...overrides,
  }
}

describe('Identity Resolver', () => {
  it('only returns a strong match for the exact hardware identity', () => {
    expect(resolveDeviceIdentity(device(), candidate({ hardwareSerial: ' hardware-1 ' }))).toEqual({
      decision: 'matched', confidence: 'strong', hardwareSerial: 'hardware-1',
    })
  })

  it('never promotes matching manufacturer and model without a hardware serial', () => {
    expect(resolveDeviceIdentity(device(), candidate({ hardwareSerial: undefined }))).toMatchObject({
      decision: 'unverified', confidence: 'weak', code: 'DEVICE_IDENTITY_UNVERIFIED',
    })
  })

  it('rejects the same model when the hardware serial belongs to another device', () => {
    expect(resolveDeviceIdentity(device(), candidate({ hardwareSerial: 'HARDWARE-2' }))).toMatchObject({
      decision: 'mismatch', code: 'DEVICE_IDENTITY_MISMATCH',
    })
  })

  it('rejects an exact serial already owned by another physical device', () => {
    expect(resolveDeviceIdentity(device(), candidate(), {
      findOwner: () => device({ id: 'device-2' }),
    })).toMatchObject({ decision: 'mismatch', code: 'DEVICE_IDENTITY_MISMATCH' })
  })

  it('rejects conflicting profile evidence even when the serial matches', () => {
    expect(resolveDeviceIdentity(device(), candidate({ model: 'OTHER' }))).toMatchObject({
      decision: 'mismatch', code: 'DEVICE_IDENTITY_MISMATCH',
    })
  })
})
