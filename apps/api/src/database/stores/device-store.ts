import type { DatabaseSync } from 'node:sqlite'

import { mapDeviceRow } from '../mappers.js'
import type { DeviceProfile } from '../../types.js'
import { now, type Row } from './shared.js'

export interface UpsertAdbDeviceInput {
  id: string
  serial: string
  name: string
  manufacturer: string
  model?: string
  osVersion: string
  apiLevel: number
  architecture: string
  buildVersion?: string
  securityPatch?: string
}

/** Owns registered-device persistence; discovery remains outside this Store. */
export class DeviceStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): DeviceProfile[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY registered_at, id').all() as Row[]).map(mapDeviceRow)
  }

  get(id: string) {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined
    return row ? mapDeviceRow(row) : undefined
  }

  getBySerial(serial: string) {
    const row = this.db.prepare('SELECT * FROM devices WHERE serial = ?').get(serial) as Row | undefined
    return row ? mapDeviceRow(row) : undefined
  }

  markSeen(deviceId: string) {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now(), deviceId)
  }

  updateProfile(deviceId: string, input: Partial<Pick<UpsertAdbDeviceInput, 'name' | 'manufacturer' | 'model' | 'osVersion' | 'apiLevel' | 'architecture' | 'buildVersion' | 'securityPatch'>>) {
    const current = this.get(deviceId)
    if (!current) return undefined
    this.db.prepare(`
      UPDATE devices SET name = ?, manufacturer = ?, model = ?, os_version = ?, api_level = ?,
        architecture = ?, build_version = ?, security_patch = ?
      WHERE id = ?
    `).run(
      input.name ?? current.name, input.manufacturer ?? current.manufacturer, input.model ?? current.model ?? null,
      input.osVersion ?? current.osVersion, input.apiLevel ?? current.apiLevel, input.architecture ?? current.architecture,
      input.buildVersion ?? current.buildVersion ?? null, input.securityPatch ?? current.securityPatch ?? null, deviceId,
    )
    return this.get(deviceId)
  }

  upsertAdb(input: UpsertAdbDeviceInput) {
    const timestamp = now()
    this.db.prepare(`
      INSERT INTO devices (
        id, platform, name, manufacturer, model, os_version, api_level,
        architecture, execution_mode, eligible, serial, build_version,
        security_patch, registered_at, last_seen_at
      ) VALUES (?, 'android', ?, ?, ?, ?, ?, ?, 'adb', 1, ?, ?, ?, ?, ?)
      ON CONFLICT(serial) WHERE serial IS NOT NULL AND serial <> '' DO UPDATE SET
        name = excluded.name, manufacturer = excluded.manufacturer,
        model = excluded.model, os_version = excluded.os_version,
        api_level = excluded.api_level, architecture = excluded.architecture,
        execution_mode = 'adb', eligible = 1,
        build_version = excluded.build_version,
        security_patch = excluded.security_patch,
        last_seen_at = excluded.last_seen_at
    `).run(
      input.id, input.name, input.manufacturer, input.model ?? null,
      input.osVersion, input.apiLevel, input.architecture, input.serial,
      input.buildVersion ?? null, input.securityPatch ?? null, timestamp, timestamp,
    )
    const device = this.getBySerial(input.serial)!
    this.db.prepare(`
      INSERT INTO device_endpoints
        (id, device_id, kind, adb_serial, status, last_seen_at, created_at, updated_at)
      VALUES (?, ?, 'usb', ?, 'online', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        device_id = excluded.device_id,
        adb_serial = excluded.adb_serial, status = 'online',
        last_seen_at = excluded.last_seen_at, last_error = NULL, updated_at = excluded.updated_at
    `).run(`endpoint-usb-${device.id}`, device.id, input.serial, timestamp, timestamp, timestamp)
    return device
  }
}
