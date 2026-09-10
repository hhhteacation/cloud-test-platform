import type { DeviceDiscoveryCandidate, DeviceProfile } from '../types.js'
import type { EndpointObservation } from './endpoint-observation-store.js'
import { resolveDeviceIdentity, type DeviceIdentityResolution } from './identity-resolver.js'

interface RestrictedNetworkProvider {
  probeNetwork(host: string, port: number, options?: { signal?: AbortSignal }): Promise<boolean>
  connectNetwork(host: string, port: number, options?: { signal?: AbortSignal }): Promise<DeviceDiscoveryCandidate>
}

interface RestrictedNetworkVerificationInput {
  device: DeviceProfile
  observation: EndpointObservation
  provider: RestrictedNetworkProvider
  isObservationActive(): boolean
  findOwner?: (hardwareSerial: string) => DeviceProfile | undefined
  signal?: AbortSignal
}

interface AdbFailureEvidence {
  adbExitCode?: number
  adbStdout?: string
  adbStderr?: string
  adbStdoutTruncated?: boolean
  adbStderrTruncated?: boolean
}

export class RestrictedNetworkVerificationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly evidence?: AdbFailureEvidence,
  ) {
    super(message)
    this.name = 'RestrictedNetworkVerificationError'
  }
}

function evidence(candidate: DeviceDiscoveryCandidate): AdbFailureEvidence {
  return {
    adbExitCode: candidate.adbExitCode,
    adbStdout: candidate.adbStdout,
    adbStderr: candidate.adbStderr,
    adbStdoutTruncated: candidate.adbStdoutTruncated,
    adbStderrTruncated: candidate.adbStderrTruncated,
  }
}

function assertActive(input: RestrictedNetworkVerificationInput) {
  if (input.signal?.aborted) {
    throw new RestrictedNetworkVerificationError(
      '候选 Endpoint 验证已取消',
      'NETWORK_CONNECTION_CANCELLED',
    )
  }
  if (!input.isObservationActive()) {
    throw new RestrictedNetworkVerificationError(
      '候选 Endpoint Observation 已过期',
      'NETWORK_ENDPOINT_EXPIRED',
    )
  }
}

/**
 * Phase 4 verification boundary. It can only probe/connect through the narrow
 * provider interface and returns evidence; it has no database or activation API.
 */
export async function verifyRestrictedNetworkCandidate(input: RestrictedNetworkVerificationInput): Promise<{
  observationId: string
  transportType: EndpointObservation['transportType']
  candidate: DeviceDiscoveryCandidate
  identity: Extract<DeviceIdentityResolution, { decision: 'matched' }>
}> {
  assertActive(input)
  let reachable: boolean
  try {
    reachable = await input.provider.probeNetwork(
      input.observation.host,
      input.observation.port,
      { signal: input.signal },
    )
  } catch (error) {
    if (input.signal?.aborted) assertActive(input)
    throw new RestrictedNetworkVerificationError(
      `候选 Endpoint TCP 探测失败：${error instanceof Error ? error.message : String(error)}`,
      'TCP_PROBE_FAILED',
    )
  }
  assertActive(input)
  if (!reachable) {
    throw new RestrictedNetworkVerificationError(
      '候选 Endpoint TCP 端口未开放',
      'TCP_PORT_CLOSED',
    )
  }

  let candidate: DeviceDiscoveryCandidate
  try {
    candidate = await input.provider.connectNetwork(
      input.observation.host,
      input.observation.port,
      { signal: input.signal },
    )
  } catch (error) {
    if (input.signal?.aborted) assertActive(input)
    throw new RestrictedNetworkVerificationError(
      `候选 Endpoint ADB 连接失败：${error instanceof Error ? error.message : String(error)}`,
      'ADB_CONNECT_FAILED',
    )
  }
  if (candidate.connectionStatus !== 'online') {
    throw new RestrictedNetworkVerificationError(
      candidate.failureMessage ?? `候选 Endpoint ADB 状态：${candidate.connectionStatus}`,
      candidate.failureCode ?? 'ADB_DEVICE_OFFLINE',
      evidence(candidate),
    )
  }

  const identity = resolveDeviceIdentity(input.device, candidate, { findOwner: input.findOwner })
  if (identity.decision !== 'matched') {
    throw new RestrictedNetworkVerificationError(identity.message, identity.code, evidence(candidate))
  }
  assertActive(input)

  return {
    observationId: input.observation.id,
    transportType: input.observation.transportType,
    candidate: { ...candidate, networkTransport: input.observation.transportType },
    identity,
  }
}
