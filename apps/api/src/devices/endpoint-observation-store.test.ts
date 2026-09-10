import { describe, expect, it } from 'vitest'

import { EndpointObservationStore } from './endpoint-observation-store.js'

describe('EndpointObservationStore', () => {
  it('uses source-specific TTLs and keeps discoveries separate from formal Endpoints', () => {
    let nowMs = 1_800_000_000_000
    const store = new EndpointObservationStore({ now: () => nowMs })

    const mdns = store.observe({
      source: 'mdns', serviceInstance: 'adb-serial-1', transportType: 'wireless_tls',
      host: 'PHONE.local', port: 37123,
    })
    const tracked = store.observe({
      source: 'adb_track', serviceInstance: '192.0.2.10:5555', transportType: 'tcp_legacy',
      host: '192.0.2.10', port: 5555,
    })

    expect(mdns.created).toBe(true)
    expect(mdns.observation).toMatchObject({
      source: 'mdns', host: 'phone.local', verificationStatus: 'unverified',
      observedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 60_000).toISOString(),
    })
    expect(tracked.observation.expiresAt).toBe(new Date(nowMs + 30_000).toISOString())
    expect(store.listActive()).toHaveLength(2)
  })

  it('deduplicates repeated publications by normalized key and only refreshes the TTL', () => {
    let nowMs = 1_800_000_000_000
    const store = new EndpointObservationStore({ now: () => nowMs })
    const first = store.observe({
      source: 'mdns', serviceInstance: ' Phone-1 ', transportType: 'wireless_tls',
      host: 'PHONE.local', port: 37123,
    })
    nowMs += 20_000
    const repeated = store.observe({
      source: 'mdns', serviceInstance: 'phone-1', transportType: 'wireless_tls',
      host: 'phone.LOCAL', port: 37123,
    })

    expect(repeated.created).toBe(false)
    expect(repeated.observation.id).toBe(first.observation.id)
    expect(repeated.observation.observedAt).toBe(new Date(nowMs).toISOString())
    expect(repeated.observation.expiresAt).toBe(new Date(nowMs + 60_000).toISOString())
    expect(store.listActive()).toHaveLength(1)
  })

  it('rejects expired lifecycle IDs and creates a new lifecycle when the address reappears', () => {
    let nowMs = 1_800_000_000_000
    const store = new EndpointObservationStore({ now: () => nowMs })
    const first = store.observe({
      source: 'adb_track', serviceInstance: '192.0.2.10:5555', transportType: 'tcp_legacy',
      host: '192.0.2.10', port: 5555,
    })

    nowMs += 30_001
    expect(store.isActive(first.observation.id)).toBe(false)
    expect(store.expire()).toEqual([first.observation])
    expect(store.listActive()).toEqual([])

    const reappeared = store.observe({
      source: 'adb_track', serviceInstance: '192.0.2.10:5555', transportType: 'tcp_legacy',
      host: '192.0.2.10', port: 5555,
    })
    expect(reappeared.created).toBe(true)
    expect(reappeared.observation.id).not.toBe(first.observation.id)
  })

  it('rejects malformed discoveries before they can enter the candidate buffer', () => {
    const store = new EndpointObservationStore()

    expect(() => store.observe({
      source: 'mdns', serviceInstance: '', transportType: 'wireless_tls', host: '', port: 0,
    })).toThrow('无效的 Endpoint Observation')
    expect(store.listActive()).toEqual([])
  })
})
