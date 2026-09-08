import { describe, expect, it, vi } from 'vitest'

import type { DeviceDiscoveryCandidate, DeviceProfile } from '../types.js'
import type { EndpointObservation } from './endpoint-observation-store.js'
import {
  RestrictedNetworkVerificationError,
  verifyRestrictedNetworkCandidate,
} from './restricted-network-verifier.js'

const device: DeviceProfile = {
  id: 'device-1', platform: 'android', name: 'Phone', manufacturer: 'Example',
  model: 'EX-1', executionMode: 'adb', eligible: true, serial: 'HARDWARE-1',
}

const observation: EndpointObservation = {
  id: 'observation-1', source: 'mdns', serviceInstance: 'adb-demo',
  transportType: 'wireless_tls', host: '192.0.2.10', port: 37123,
  observedAt: '2026-08-25T00:00:00.000Z', expiresAt: '2026-08-25T00:01:00.000Z',
  verificationStatus: 'unverified',
}

function onlineCandidate(overrides: Partial<DeviceDiscoveryCandidate> = {}): DeviceDiscoveryCandidate {
  return {
    serial: '192.0.2.10:37123', hardwareSerial: 'HARDWARE-1', platform: 'android',
    manufacturer: 'Example', model: 'EX-1', connectionStatus: 'online',
    ...overrides,
  }
}

describe('restricted network candidate verifier', () => {
  it('rejects an expired Observation before any network or ADB operation', async () => {
    const probeNetwork = vi.fn()
    const connectNetwork = vi.fn()

    await expect(verifyRestrictedNetworkCandidate({
      device, observation, isObservationActive: () => false,
      provider: { probeNetwork, connectNetwork },
    })).rejects.toMatchObject<RestrictedNetworkVerificationError>({ code: 'NETWORK_ENDPOINT_EXPIRED' })
    expect(probeNetwork).not.toHaveBeenCalled()
    expect(connectNetwork).not.toHaveBeenCalled()
  })

  it('stops after the TCP quick probe when the candidate port is closed', async () => {
    const connectNetwork = vi.fn()
    await expect(verifyRestrictedNetworkCandidate({
      device, observation, isObservationActive: () => true,
      provider: { probeNetwork: async () => false, connectNetwork },
    })).rejects.toMatchObject<RestrictedNetworkVerificationError>({ code: 'TCP_PORT_CLOSED' })
    expect(connectNetwork).not.toHaveBeenCalled()
  })

  it('does not bind weak model evidence when hardware identity is unavailable', async () => {
    await expect(verifyRestrictedNetworkCandidate({
      device, observation, isObservationActive: () => true,
      provider: {
        probeNetwork: async () => true,
        connectNetwork: async () => onlineCandidate({ hardwareSerial: undefined }),
      },
    })).rejects.toMatchObject<RestrictedNetworkVerificationError>({ code: 'DEVICE_IDENTITY_UNVERIFIED' })
  })

  it('preserves provider cancellation and failure evidence', async () => {
    await expect(verifyRestrictedNetworkCandidate({
      device, observation, isObservationActive: () => true,
      provider: {
        probeNetwork: async () => true,
        connectNetwork: async () => onlineCandidate({
          connectionStatus: 'offline', failureCode: 'NETWORK_CONNECTION_CANCELLED',
          failureMessage: 'cancelled', adbStderr: 'partial evidence',
        }),
      },
    })).rejects.toMatchObject<RestrictedNetworkVerificationError>({
      code: 'NETWORK_CONNECTION_CANCELLED', evidence: { adbStderr: 'partial evidence' },
    })
  })

  it('rechecks Observation activity after async identity verification', async () => {
    let active = true
    await expect(verifyRestrictedNetworkCandidate({
      device, observation, isObservationActive: () => active,
      provider: {
        probeNetwork: async () => true,
        connectNetwork: async () => {
          active = false
          return onlineCandidate()
        },
      },
    })).rejects.toMatchObject<RestrictedNetworkVerificationError>({ code: 'NETWORK_ENDPOINT_EXPIRED' })
  })

  it('returns verified evidence without writing or activating an Endpoint', async () => {
    const calls: string[] = []
    await expect(verifyRestrictedNetworkCandidate({
      device, observation, isObservationActive: () => true,
      provider: {
        probeNetwork: async (host, port) => { calls.push(`probe:${host}:${port}`); return true },
        connectNetwork: async (host, port) => { calls.push(`connect:${host}:${port}`); return onlineCandidate() },
      },
    })).resolves.toMatchObject({
      observationId: 'observation-1', transportType: 'wireless_tls',
      candidate: { hardwareSerial: 'HARDWARE-1', connectionStatus: 'online' },
      identity: { decision: 'matched', confidence: 'strong' },
    })
    expect(calls).toEqual(['probe:192.0.2.10:37123', 'connect:192.0.2.10:37123'])
  })
})
