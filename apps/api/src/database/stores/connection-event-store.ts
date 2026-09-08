import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { asNumber, asString, now, type Row } from './shared.js'

export interface ConnectionEndpointSummary {
  host?: string
  port?: number
  transportType?: 'usb' | 'tcp_legacy' | 'wireless_tls'
  serviceInstance?: string
}

export interface ConnectionEvent {
  id: string
  deviceId: string
  operationId?: string
  generation: number
  eventType: string
  source: string
  transportType?: string
  endpointSummary?: ConnectionEndpointSummary
  result: string
  failureCode?: string
  durationMs?: number
  createdAt: string
}

export interface AppendConnectionEventInput {
  deviceId: string
  operationId?: string
  generation: number
  eventType: string
  source: string
  transportType?: 'usb' | 'tcp_legacy' | 'wireless_tls'
  endpointSummary?: ConnectionEndpointSummary
  result: string
  failureCode?: string
  durationMs?: number
}

function optionalString(value: unknown) { return asString(value) || undefined }

function parseSummary(value: unknown): ConnectionEndpointSummary | undefined {
  const serialized = optionalString(value)
  if (!serialized) return undefined
  try { return JSON.parse(serialized) as ConnectionEndpointSummary }
  catch { return undefined }
}

function mapEvent(row: Row): ConnectionEvent {
  return {
    id: asString(row.id),
    deviceId: asString(row.device_id),
    operationId: optionalString(row.operation_id),
    generation: asNumber(row.generation),
    eventType: asString(row.event_type),
    source: asString(row.source),
    transportType: optionalString(row.transport_type),
    endpointSummary: parseSummary(row.endpoint_summary),
    result: asString(row.result),
    failureCode: optionalString(row.failure_code),
    durationMs: row.duration_ms == null ? undefined : asNumber(row.duration_ms),
    createdAt: asString(row.created_at),
  }
}

export class ConnectionEventStore {
  constructor(private readonly db: DatabaseSync) {}

  append(input: AppendConnectionEventInput): ConnectionEvent {
    const id = `connection-event-${randomUUID()}`
    this.db.prepare(`
      INSERT INTO connection_events (
        id, device_id, operation_id, generation, event_type, source,
        transport_type, endpoint_summary, result, failure_code, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.deviceId, input.operationId ?? null, input.generation,
      input.eventType, input.source, input.transportType ?? null,
      input.endpointSummary ? JSON.stringify(input.endpointSummary) : null,
      input.result, input.failureCode ?? null, input.durationMs ?? null, now(),
    )
    return this.get(id)!
  }

  get(id: string): ConnectionEvent | undefined {
    const row = this.db.prepare('SELECT * FROM connection_events WHERE id = ?').get(id) as Row | undefined
    return row ? mapEvent(row) : undefined
  }

  listForDevice(deviceId: string): ConnectionEvent[] {
    return (this.db.prepare(`
      SELECT * FROM connection_events
      WHERE device_id = ? ORDER BY rowid
    `).all(deviceId) as Row[]).map(mapEvent)
  }
}
