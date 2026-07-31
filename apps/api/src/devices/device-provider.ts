import type { DeviceDiscoveryCandidate, DevicePlatform } from '../types.js'

/**
 * Platform-specific discovery seam. Android uses ADB today; iOS and HarmonyOS
 * can later implement the same contract with their own tooling.
 */
export interface DeviceDiscoveryProvider {
  readonly platform: DevicePlatform
  discover(): Promise<DeviceDiscoveryCandidate[]>
}
