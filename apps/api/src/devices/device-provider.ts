import type { DeviceDiscoveryCandidate, DevicePlatform, DeviceConnectionKind } from '../types.js'

/**
 * Platform-specific discovery seam. Android uses ADB today; iOS and HarmonyOS
 * can later implement the same contract with their own tooling.
 */
export interface DeviceDiscoveryProvider {
  readonly platform: DevicePlatform
  discover(): Promise<DeviceDiscoveryCandidate[]>
  discoverNetwork?(): Promise<DeviceDiscoveryCandidate[]>
  connectNetwork?(host: string, port: number): Promise<DeviceDiscoveryCandidate>
  disconnect?(serial: string): Promise<void>
}
