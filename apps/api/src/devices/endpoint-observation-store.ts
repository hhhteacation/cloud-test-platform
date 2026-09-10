import { randomUUID } from 'node:crypto'

export type EndpointObservationSource = 'mdns' | 'adb_track'
export type EndpointObservationTransport = 'tcp_legacy' | 'wireless_tls'

export interface EndpointObservationInput {
  source: EndpointObservationSource
  serviceInstance: string
  transportType: EndpointObservationTransport
  host: string
  port: number
}

export interface EndpointObservation extends EndpointObservationInput {
  id: string
  observedAt: string
  expiresAt: string
  verificationStatus: 'unverified'
}

export interface EndpointObservationResult {
  observation: EndpointObservation
  created: boolean
}

interface EndpointObservationStoreOptions {
  now?: () => number
  mdnsTtlMs?: number
  adbTrackTtlMs?: number
}

function normalizeInput(input: EndpointObservationInput): EndpointObservationInput {
  return {
    ...input,
    serviceInstance: input.serviceInstance.trim().toLowerCase(),
    host: input.host.trim().replace(/^\[|\]$/g, '').toLowerCase(),
  }
}

function observationKey(input: EndpointObservationInput) {
  return [
    input.source,
    input.serviceInstance,
    input.host,
    input.port,
    input.transportType,
  ].join('\u0000')
}

/**
 * Ephemeral safety buffer between discovery sources and formal Endpoints.
 * It intentionally has no database or ADB dependency: discovery cannot bind a
 * Physical Device or initiate a connection through this store.
 */
export class EndpointObservationStore {
  private readonly byId = new Map<string, EndpointObservation>()
  private readonly idByKey = new Map<string, string>()
  private readonly now: () => number
  private readonly ttlBySource: Record<EndpointObservationSource, number>

  constructor(options: EndpointObservationStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlBySource = {
      mdns: options.mdnsTtlMs ?? 60_000,
      adb_track: options.adbTrackTtlMs ?? 30_000,
    }
  }

  observe(rawInput: EndpointObservationInput): EndpointObservationResult {
    const input = normalizeInput(rawInput)
    if (
      !input.serviceInstance
      || !input.host
      || !Number.isInteger(input.port)
      || input.port < 1
      || input.port > 65_535
    ) {
      throw new Error('无效的 Endpoint Observation')
    }

    const nowMs = this.now()
    const key = observationKey(input)
    const currentId = this.idByKey.get(key)
    const current = currentId ? this.byId.get(currentId) : undefined
    if (current && Date.parse(current.expiresAt) > nowMs) {
      const refreshed = {
        ...current,
        observedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + this.ttlBySource[input.source]).toISOString(),
      }
      this.byId.set(current.id, refreshed)
      return { observation: refreshed, created: false }
    }
    if (current) this.remove(current, key)

    const observation: EndpointObservation = {
      id: `endpoint-observation-${randomUUID()}`,
      ...input,
      observedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.ttlBySource[input.source]).toISOString(),
      verificationStatus: 'unverified',
    }
    this.byId.set(observation.id, observation)
    this.idByKey.set(key, observation.id)
    return { observation, created: true }
  }

  isActive(id: string): boolean {
    const observation = this.byId.get(id)
    return Boolean(observation && Date.parse(observation.expiresAt) > this.now())
  }

  listActive(): EndpointObservation[] {
    const nowMs = this.now()
    return [...this.byId.values()].filter((observation) => (
      Date.parse(observation.expiresAt) > nowMs
    ))
  }

  expire(): EndpointObservation[] {
    const nowMs = this.now()
    const expired = [...this.byId.values()].filter((observation) => (
      Date.parse(observation.expiresAt) <= nowMs
    ))
    for (const observation of expired) {
      this.remove(observation, observationKey(observation))
    }
    return expired
  }

  private remove(observation: EndpointObservation, key: string) {
    this.byId.delete(observation.id)
    if (this.idByKey.get(key) === observation.id) this.idByKey.delete(key)
  }
}
