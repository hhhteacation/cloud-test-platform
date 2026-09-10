import type { DeviceDiscoveryCandidate, DevicePlatform, DeviceConnectionKind } from '../types.js'

/**
 * Platform-specific discovery seam. Android uses ADB today; iOS and HarmonyOS
 * can later implement the same contract with their own tooling.
 */
export interface DeviceDiscoveryProvider {
  readonly platform: DevicePlatform
  discover(options?: { signal?: AbortSignal }): Promise<DeviceDiscoveryCandidate[]>
  discoverNetwork?(options?: { signal?: AbortSignal }): Promise<DeviceDiscoveryCandidate[]>
  probeNetwork?(host: string, port: number, options?: { signal?: AbortSignal }): Promise<boolean>
  connectNetwork?(host: string, port: number, options?: { signal?: AbortSignal }): Promise<DeviceDiscoveryCandidate>
  disconnect?(serial: string): Promise<void>
}
