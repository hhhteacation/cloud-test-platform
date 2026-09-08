import type { DeviceDiscoveryCandidate, DeviceProfile } from '../types.js'

export type DeviceIdentityResolution =
  | { decision: 'matched'; confidence: 'strong'; hardwareSerial: string }
  | { decision: 'unverified'; confidence: 'weak'; code: 'DEVICE_IDENTITY_UNVERIFIED'; message: string }
  | { decision: 'mismatch'; confidence: 'strong'; code: 'DEVICE_IDENTITY_MISMATCH'; message: string }

interface IdentityResolverOptions {
  findOwner?: (hardwareSerial: string) => DeviceProfile | undefined
}

function normalizeIdentity(value?: string) {
  return value?.trim().toLowerCase()
}

function normalizeProfile(value?: string) {
  return value?.trim().toLowerCase().replaceAll('_', ' ')
}

/**
 * Resolves identity evidence only. It never connects, binds, or writes state.
 * Manufacturer/model evidence may reject a candidate but can never establish
 * identity without an exact stable hardware serial.
 */
export function resolveDeviceIdentity(
  device: DeviceProfile,
  candidate: DeviceDiscoveryCandidate,
  options: IdentityResolverOptions = {},
): DeviceIdentityResolution {
  const expectedHardwareSerial = normalizeIdentity(device.serial)
  const candidateHardwareSerial = normalizeIdentity(candidate.hardwareSerial)
  if (!candidateHardwareSerial) {
    return {
      decision: 'unverified', confidence: 'weak', code: 'DEVICE_IDENTITY_UNVERIFIED',
      message: '无法读取联网设备硬件身份，需要人工确认，系统不会自动绑定',
    }
  }
  if (!expectedHardwareSerial || candidateHardwareSerial !== expectedHardwareSerial) {
    return {
      decision: 'mismatch', confidence: 'strong', code: 'DEVICE_IDENTITY_MISMATCH',
      message: '联网设备硬件身份与目标物理设备不匹配，需要人工确认，系统不会自动绑定',
    }
  }

  const owner = options.findOwner?.(candidate.hardwareSerial!.trim())
  if (owner && owner.id !== device.id) {
    return {
      decision: 'mismatch', confidence: 'strong', code: 'DEVICE_IDENTITY_MISMATCH',
      message: '联网设备硬件身份已属于另一台物理设备，需要人工确认，系统不会自动绑定',
    }
  }

  const modelMatches = !candidate.model || !device.model
    || normalizeProfile(candidate.model) === normalizeProfile(device.model)
  const manufacturerMatches = !candidate.manufacturer || !device.manufacturer
    || normalizeProfile(candidate.manufacturer) === normalizeProfile(device.manufacturer)
  if (!modelMatches || !manufacturerMatches) {
    return {
      decision: 'mismatch', confidence: 'strong', code: 'DEVICE_IDENTITY_MISMATCH',
      message: '联网设备资料与目标物理设备不匹配，需要人工确认，系统不会自动绑定',
    }
  }

  return { decision: 'matched', confidence: 'strong', hardwareSerial: candidateHardwareSerial }
}
