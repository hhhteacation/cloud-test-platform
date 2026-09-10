import type { DeviceEndpoint, NetworkTransportType } from '../types.js'

export type NetworkResolverFailureCode =
  | 'MDNS_SERVICE_NOT_FOUND'
  | 'WIRELESS_PAIRING_REQUIRED'
  | 'WIRELESS_TLS_UNREACHABLE'
  | 'WIRELESS_TLS_CONNECT_TIMEOUT'
  | 'DEVICE_IDENTITY_MISMATCH'
  | 'ENDPOINT_OWNED_BY_ANOTHER_DEVICE'
  | 'DEVICE_BUSY'
  | 'TASK_LEASE_BLOCKED'
  | 'STALE_CONNECTION_RESULT'
  | 'OPERATION_CANCELLED'

export interface NetworkTransportCandidate {
  transportType: NetworkTransportType
  host: string
  port: number
  serviceInstance?: string
  endpoint?: DeviceEndpoint
}

export interface NetworkTransportResolution {
  candidate: NetworkTransportCandidate
  source: 'mdns' | 'verified_endpoint' | 'tcp_fallback'
}

const TCP_FALLBACK_FAILURES = new Set<NetworkResolverFailureCode>([
  'MDNS_SERVICE_NOT_FOUND',
  'WIRELESS_PAIRING_REQUIRED',
  'WIRELESS_TLS_UNREACHABLE',
  'WIRELESS_TLS_CONNECT_TIMEOUT',
])

export function canFallbackToTcp(code: string | undefined): boolean {
  return code != null && TCP_FALLBACK_FAILURES.has(code as NetworkResolverFailureCode)
}

/**
 * Selects a transport without performing I/O. I/O and identity verification
 * stay in DeviceRegistry/ADB Gateway; this policy only makes the ordering and
 * fallback boundary explicit and therefore easy to test.
 */
export function selectNetworkTransport(input: {
  discovered: NetworkTransportCandidate[]
  verified: NetworkTransportCandidate[]
  tcpFallback?: NetworkTransportCandidate
  wirelessFailureCode?: string
}): NetworkTransportResolution | undefined {
  const tls = [...input.discovered, ...input.verified].find((candidate) => (
    candidate.transportType === 'wireless_tls' && candidate.host && candidate.port > 0
  ))
  if (tls) {
    return {
      candidate: tls,
      source: input.discovered.includes(tls) ? 'mdns' : 'verified_endpoint',
    }
  }
  // An already-verified tcp:5555 Endpoint is a first-class candidate; the
  // failure-code-gated tcpFallback below is only the recovery path.
  const verifiedTcp = input.verified.find((candidate) => (
    candidate.transportType === 'tcp_legacy' && candidate.host && candidate.port > 0
  ))
  if (verifiedTcp) {
    return { candidate: verifiedTcp, source: 'verified_endpoint' }
  }
  if (input.tcpFallback && canFallbackToTcp(input.wirelessFailureCode)) {
    return { candidate: input.tcpFallback, source: 'tcp_fallback' }
  }
  return undefined
}
