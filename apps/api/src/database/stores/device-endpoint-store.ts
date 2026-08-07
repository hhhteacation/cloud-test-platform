import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type { DeviceConnectionKind, DeviceConnectionStatus, DeviceEndpoint } from '../../types.js'
import { asNumber, asString, now, type Row } from './shared.js'

export interface UpsertEndpointInput {
  deviceId: string
  kind: DeviceConnectionKind
  adbSerial: string
  host?: string
  port?: number
  status?: DeviceConnectionStatus
  lastError?: string
}

function mapEndpoint(row: Row): DeviceEndpoint {
  return {
    id: asString(row.id),
    deviceId: asString(row.device_id),
    kind: asString(row.kind) as DeviceConnectionKind,
    adbSerial: asString(row.adb_serial),
    host: asString(row.host) || undefined,
    port: row.port == null ? undefined : asNumber(row.port),
    status: (asString(row.status) || 'unknown') as DeviceConnectionStatus,
    lastSeenAt: asString(row.last_seen_at) || undefined,
    lastError: asString(row.last_error) || undefined,
  }
}

export class DeviceEndpointStore {
  constructor(private readonly db: DatabaseSync) {}

  listForDevice(deviceId: string): DeviceEndpoint[] {
    return (this.db.prepare('SELECT * FROM device_endpoints WHERE device_id = ? ORDER BY kind').all(deviceId) as Row[]).map(mapEndpoint)
  }

  get(id: string): DeviceEndpoint | undefined {
    const row = this.db.prepare('SELECT * FROM device_endpoints WHERE id = ?').get(id) as Row | undefined
    return row ? mapEndpoint(row) : undefined
  }

  getByDeviceAndKind(deviceId: string, kind: DeviceConnectionKind): DeviceEndpoint | undefined {
    const row = this.db.prepare('SELECT * FROM device_endpoints WHERE device_id = ? AND kind = ?').get(deviceId, kind) as Row | undefined
    return row ? mapEndpoint(row) : undefined
  }

  getBySerial(adbSerial: string): DeviceEndpoint | undefined {
    const row = this.db.prepare('SELECT * FROM device_endpoints WHERE adb_serial = ?').get(adbSerial) as Row | undefined
    return row ? mapEndpoint(row) : undefined
  }

  upsert(input: UpsertEndpointInput): DeviceEndpoint {
    const timestamp = now()
    const existing = this.getByDeviceAndKind(input.deviceId, input.kind)
    const id = existing?.id ?? `endpoint-${randomUUID()}`
    this.db.prepare(`
      INSERT INTO device_endpoints
        (id, device_id, kind, adb_serial, host, port, status, last_seen_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, kind) DO UPDATE SET
        adb_serial = excluded.adb_serial,
        host = excluded.host,
        port = excluded.port,
        status = excluded.status,
        last_seen_at = excluded.last_seen_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      id, input.deviceId, input.kind, input.adbSerial, input.host ?? null, input.port ?? null,
      input.status ?? 'unknown', input.status === 'online' ? timestamp : null,
      input.lastError ?? null, timestamp, timestamp,
    )
    return this.getByDeviceAndKind(input.deviceId, input.kind)!
  }

  updateStatus(id: string, status: DeviceConnectionStatus, lastError?: string) {
    const timestamp = now()
    this.db.prepare(`
      UPDATE device_endpoints
      SET status = ?, last_seen_at = CASE WHEN ? = 'online' THEN ? ELSE last_seen_at END,
          last_error = CASE
            WHEN ? = 'online' THEN NULL
            WHEN ? IS NULL THEN last_error
            ELSE ?
          END,
          updated_at = ?
      WHERE id = ?
    `).run(status, status, timestamp, status, lastError ?? null, lastError ?? null, timestamp, id)
    return this.get(id)
  }

  remove(id: string) {
    return this.db.prepare('DELETE FROM device_endpoints WHERE id = ?').run(id).changes === 1
  }
}
