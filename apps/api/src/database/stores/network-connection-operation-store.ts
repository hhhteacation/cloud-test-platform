import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type {
  NetworkConnectionOperation,
  NetworkConnectionOperationItem,
  NetworkConnectionOperationItemStatus,
  NetworkConnectionOperationStatus,
} from '../../types.js'
import { asNumber, asString, now, type Row } from './shared.js'

export interface CreateNetworkConnectionOperationInput {
  id?: string
  items: Array<Pick<NetworkConnectionOperationItem, 'deviceId' | 'endpointId' | 'host' | 'port'>>
}

export class ActiveNetworkConnectionOperationError extends Error {
  constructor() {
    super('已有联网批量连接操作正在执行')
    this.name = 'ActiveNetworkConnectionOperationError'
  }
}

function bool(value: unknown) { return Number(value ?? 0) === 1 }
function optionalString(value: unknown) { return asString(value) || undefined }

function mapItem(row: Row): NetworkConnectionOperationItem {
  return {
    id: asString(row.id),
    operationId: asString(row.operation_id),
    deviceId: asString(row.device_id),
    endpointId: asString(row.endpoint_id),
    host: asString(row.host),
    port: asNumber(row.port),
    status: asString(row.status) as NetworkConnectionOperationItemStatus,
    skipReason: optionalString(row.skip_reason),
    failureCode: optionalString(row.failure_code),
    failureMessage: optionalString(row.failure_message),
    adbExitCode: row.adb_exit_code == null ? undefined : asNumber(row.adb_exit_code),
    adbStdout: optionalString(row.adb_stdout),
    adbStderr: optionalString(row.adb_stderr),
    adbStdoutTruncated: bool(row.adb_stdout_truncated),
    adbStderrTruncated: bool(row.adb_stderr_truncated),
    cancelReason: optionalString(row.cancel_reason),
    startedAt: optionalString(row.started_at),
    finishedAt: optionalString(row.finished_at),
  }
}

function mapOperation(row: Row, items: NetworkConnectionOperationItem[]): NetworkConnectionOperation {
  const counts = {
    succeeded: items.filter((item) => item.status === 'succeeded').length,
    failed: items.filter((item) => item.status === 'failed').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    cancelled: items.filter((item) => item.status === 'cancelled').length,
  }
  return {
    id: asString(row.id),
    status: asString(row.status) as NetworkConnectionOperationStatus,
    totalCount: asNumber(row.total_count),
    ...counts,
    cancelRequested: bool(row.cancel_requested),
    cancelReason: optionalString(row.cancel_reason),
    createdAt: asString(row.created_at),
    startedAt: optionalString(row.started_at),
    finishedAt: optionalString(row.finished_at),
    items,
  }
}

export class NetworkConnectionOperationStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateNetworkConnectionOperationInput) {
    const id = input.id ?? `network-connect-${randomUUID()}`
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.hasActive()) throw new ActiveNetworkConnectionOperationError()
      this.db.prepare(`
        INSERT INTO network_connection_operations
          (id, status, total_count, cancel_requested, created_at)
        VALUES (?, 'queued', ?, 0, ?)
      `).run(id, input.items.length, timestamp)
      const insert = this.db.prepare(`
        INSERT INTO network_connection_operation_items
          (id, operation_id, device_id, endpoint_id, host, port, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `)
      for (const item of input.items) {
        insert.run(`network-connect-item-${randomUUID()}`, id, item.deviceId, item.endpointId, item.host, item.port)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.get(id)!
  }

  get(id: string) {
    const operation = this.db.prepare('SELECT * FROM network_connection_operations WHERE id = ?').get(id) as Row | undefined
    if (!operation) return undefined
    const items = (this.db.prepare(`
      SELECT * FROM network_connection_operation_items
      WHERE operation_id = ? ORDER BY rowid
    `).all(id) as Row[]).map(mapItem)
    return mapOperation(operation, items)
  }

  hasActive() {
    const row = this.db.prepare(`
      SELECT 1 AS present FROM network_connection_operations
      WHERE status IN ('queued', 'running') LIMIT 1
    `).get() as Row | undefined
    return Boolean(row)
  }

  markRunning(id: string) {
    const timestamp = now()
    this.db.prepare(`
      UPDATE network_connection_operations
      SET status = 'running', started_at = COALESCE(started_at, ?)
      WHERE id = ? AND status = 'queued'
    `).run(timestamp, id)
    return this.get(id)
  }

  requestCancel(id: string) {
    const operation = this.get(id)
    if (!operation) return undefined
    if (operation.status === 'queued' || operation.status === 'running') {
      this.db.prepare(`
        UPDATE network_connection_operations
        SET cancel_requested = 1, cancel_reason = COALESCE(cancel_reason, 'USER_REQUESTED')
        WHERE id = ?
      `).run(id)
    }
    return this.get(id)
  }

  isCancelRequested(id: string) {
    const row = this.db.prepare('SELECT cancel_requested FROM network_connection_operations WHERE id = ?').get(id) as Row | undefined
    return Boolean(row && bool(row.cancel_requested))
  }

  updateItem(id: string, update: {
    status: NetworkConnectionOperationItemStatus
    skipReason?: string
    failureCode?: string
    failureMessage?: string
    adbExitCode?: number
    adbStdout?: string
    adbStderr?: string
    adbStdoutTruncated?: boolean
    adbStderrTruncated?: boolean
    cancelReason?: string
    startedAt?: string
    finishedAt?: string
  }) {
    const existing = this.db.prepare('SELECT * FROM network_connection_operation_items WHERE id = ?').get(id) as Row | undefined
    if (!existing) return undefined
    this.db.prepare(`
      UPDATE network_connection_operation_items SET
        status = ?, skip_reason = ?, failure_code = ?, failure_message = ?,
        adb_exit_code = ?, adb_stdout = ?, adb_stderr = ?,
        adb_stdout_truncated = ?, adb_stderr_truncated = ?, cancel_reason = ?,
        started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      update.status,
      update.skipReason ?? (asString(existing.skip_reason) || null),
      update.failureCode ?? (asString(existing.failure_code) || null),
      update.failureMessage ?? (asString(existing.failure_message) || null),
      update.adbExitCode ?? (existing.adb_exit_code == null ? null : Number(existing.adb_exit_code)),
      update.adbStdout ?? (asString(existing.adb_stdout) || null),
      update.adbStderr ?? (asString(existing.adb_stderr) || null),
      update.adbStdoutTruncated === undefined ? Number(existing.adb_stdout_truncated ?? 0) : update.adbStdoutTruncated ? 1 : 0,
      update.adbStderrTruncated === undefined ? Number(existing.adb_stderr_truncated ?? 0) : update.adbStderrTruncated ? 1 : 0,
      update.cancelReason ?? (asString(existing.cancel_reason) || null),
      update.startedAt ?? (asString(existing.started_at) || null),
      update.finishedAt ?? (asString(existing.finished_at) || null),
      id,
    )
    return this.get(asString(existing.operation_id))?.items.find((item) => item.id === id)
  }

  finish(id: string, status: NetworkConnectionOperationStatus, cancelReason?: string) {
    this.db.prepare(`
      UPDATE network_connection_operations
      SET status = ?, finished_at = ?, cancel_reason = COALESCE(?, cancel_reason)
      WHERE id = ?
    `).run(status, now(), cancelReason ?? null, id)
    return this.get(id)
  }

  markInterrupted(reason = 'SERVICE_RESTARTED') {
    const active = this.db.prepare(`
      SELECT id FROM network_connection_operations WHERE status IN ('queued', 'running')
    `).all() as Row[]
    if (!active.length) return 0
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of active) {
        const operationId = asString(row.id)
        this.db.prepare(`
          UPDATE network_connection_operation_items
          SET status = CASE WHEN status IN ('pending', 'running') THEN 'cancelled' ELSE status END,
              cancel_reason = CASE WHEN status IN ('pending', 'running') THEN ? ELSE cancel_reason END,
              finished_at = CASE WHEN status IN ('pending', 'running') THEN ? ELSE finished_at END
          WHERE operation_id = ?
        `).run(reason, timestamp, operationId)
        this.db.prepare(`
          UPDATE network_connection_operations
          SET status = 'cancelled', cancel_requested = 1, cancel_reason = ?, finished_at = ?
          WHERE id = ?
        `).run(reason, timestamp, operationId)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return active.length
  }

  purgeCompleted(keep = 100) {
    const rows = this.db.prepare(`
      SELECT id FROM network_connection_operations
      WHERE status IN ('completed', 'cancelled', 'failed')
      ORDER BY COALESCE(finished_at, created_at) DESC, rowid DESC
      LIMIT -1 OFFSET ?
    `).all(keep) as Row[]
    const remove = this.db.prepare('DELETE FROM network_connection_operations WHERE id = ?')
    for (const row of rows) remove.run(asString(row.id))
    return rows.length
  }
}
