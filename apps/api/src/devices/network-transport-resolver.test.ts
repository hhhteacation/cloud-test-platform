import { describe, expect, it } from 'vitest'

import { canFallbackToTcp, selectNetworkTransport } from './network-transport-resolver.js'

const tls = { transportType: 'wireless_tls' as const, host: 'phone.local', port: 37123 }
const tcp = { transportType: 'tcp_legacy' as const, host: '192.168.1.20', port: 5555 }

describe('network transport resolver policy', () => {
  it('优先选择 mDNS Wireless TLS', () => {
    expect(selectNetworkTransport({ discovered: [tls], verified: [], tcpFallback: tcp }))
      .toMatchObject({ candidate: tls, source: 'mdns' })
  })

  it('没有 mDNS 时使用已验证的 TLS Endpoint', () => {
    expect(selectNetworkTransport({ discovered: [], verified: [tls], tcpFallback: tcp }))
      .toMatchObject({ candidate: tls, source: 'verified_endpoint' })
  })

  it('没有 TLS 时直接使用已验证的 tcp:5555 Endpoint，且优先于受门禁的回退', () => {
    expect(selectNetworkTransport({ discovered: [], verified: [tcp], tcpFallback: { ...tcp, host: '192.168.1.99' } }))
      .toMatchObject({ candidate: tcp, source: 'verified_endpoint' })
    expect(selectNetworkTransport({ discovered: [], verified: [tcp] }))
      .toMatchObject({ candidate: tcp, source: 'verified_endpoint' })
  })

  it('只在允许的无线失败类型下回退 TCP 5555', () => {
    expect(canFallbackToTcp('WIRELESS_TLS_CONNECT_TIMEOUT')).toBe(true)
    expect(selectNetworkTransport({ discovered: [], verified: [], tcpFallback: tcp, wirelessFailureCode: 'WIRELESS_TLS_CONNECT_TIMEOUT' }))
      .toMatchObject({ candidate: tcp, source: 'tcp_fallback' })
    expect(selectNetworkTransport({ discovered: [], verified: [], tcpFallback: tcp, wirelessFailureCode: 'DEVICE_IDENTITY_MISMATCH' }))
      .toBeUndefined()
  })

  it('不会把 pairing/身份冲突等安全失败降级为 TCP', () => {
    expect(canFallbackToTcp('WIRELESS_PAIRING_REQUIRED')).toBe(true)
    expect(canFallbackToTcp('ENDPOINT_OWNED_BY_ANOTHER_DEVICE')).toBe(false)
    expect(canFallbackToTcp('TASK_LEASE_BLOCKED')).toBe(false)
    expect(canFallbackToTcp('OPERATION_CANCELLED')).toBe(false)
  })
})
