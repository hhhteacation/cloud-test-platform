import type { DatabaseSync } from 'node:sqlite'

import { asNumber, asString, now, type Row } from './shared.js'

export type DeviceConnectionManagementMode = 'manual' | 'shadow' | 'managed'
export type DesiredNetworkState = 'disconnected' | 'connected'
export type ObservedNetworkState =
  | 'offline'
  | 'discovered'
  | 'connecting'
  | 'verifying'
  | 'online'
  | 'degraded'
  | 'recovering'
  | 'manual_action'

export interface DeviceConnectionState {
  deviceId: string
  managementMode: DeviceConnectionManagementMode
  desiredNetworkState: DesiredNetworkState
  observedNetworkState: ObservedNetworkState
  activeEndpointId?: string
  connectionGeneration: number
  operationId?: string
  retryCount: number
  consecutiveFailures: number
  nextRetryAt?: string
  deadlineAt?: string
  reasonCode?: string
  actionRequired?: string
  lastHealthAt?: string
  updatedAt: string
}

export interface BeginDeviceConnectionOperationInput {
  deviceId: string
  operationId: string
  deadlineAt: string
  observedState?: Extract<ObservedNetworkState, 'connecting' | 'recovering'>
}

export interface CommitDeviceConnectionOperationInput {
  deviceId: string
  operationId: string
  generation: number
  observedState: ObservedNetworkState
  desiredState?: DesiredNetworkState
  activeEndpointId?: string
  clearActiveEndpoint?: boolean
  reasonCode?: string
  actionRequired?: string
  evaluatedAt?: string
}

export interface CurrentDeviceConnectionOperationInput {
  deviceId: string
  operationId: string
  generation: number
  evaluatedAt?: string
}

export interface ExpireDeviceConnectionOperationInput {
  deviceId: string
  operationId: string
  generation: number
  reasonCode: string
  evaluatedAt?: string
}

export interface RecordDeviceConnectionHealthFailureInput {
  deviceId: string
  operationId: string
  generation: number
  reasonCode: string
  nextRetryAt?: string
  terminal: boolean
  manualAction?: boolean
  evaluatedAt?: string
}

export interface RecordPassiveDeviceConnectionHealthInput {
  deviceId: string
  endpointId: string
  generation: number
  kind: 'healthy' | 'transport_failed'
  failureCode?: string
  evaluatedAt?: string
}

export interface InterruptedDeviceConnectionOperation {
  deviceId: string
  operationId: string
  generation: number
}

function optionalString(value: unknown) {
  return asString(value) || undefined
}

function mapState(row: Row): DeviceConnectionState {
  return {
    deviceId: asString(row.device_id),
    managementMode: asString(row.management_mode) as DeviceConnectionManagementMode,
    desiredNetworkState: asString(row.desired_network_state) as DesiredNetworkState,
    observedNetworkState: asString(row.observed_network_state) as ObservedNetworkState,
    activeEndpointId: optionalString(row.active_endpoint_id),
    connectionGeneration: asNumber(row.connection_generation),
    operationId: optionalString(row.operation_id),
    retryCount: asNumber(row.retry_count),
    consecutiveFailures: asNumber(row.consecutive_failures),
    nextRetryAt: optionalString(row.next_retry_at),
    deadlineAt: optionalString(row.deadline_at),
    reasonCode: optionalString(row.reason_code),
    actionRequired: optionalString(row.action_required),
    lastHealthAt: optionalString(row.last_health_at),
    updatedAt: asString(row.updated_at),
  }
}

export class DeviceConnectionStateStore {
  constructor(private readonly db: DatabaseSync) {}

  get(deviceId: string): DeviceConnectionState | undefined {
    const row = this.db.prepare(
      'SELECT * FROM device_connection_state WHERE device_id = ?',
    ).get(deviceId) as Row | undefined
    return row ? mapState(row) : undefined
  }

  list(): DeviceConnectionState[] {
    return (this.db.prepare('SELECT * FROM device_connection_state ORDER BY device_id').all() as Row[]).map(mapState)
  }

  setManagementMode(deviceId: string, mode: DeviceConnectionManagementMode) {
    this.db.prepare(`
      UPDATE device_connection_state SET management_mode = ?, updated_at = ? WHERE device_id = ?
    `).run(mode, now(), deviceId)
    return this.get(deviceId)
  }

  begin(input: BeginDeviceConnectionOperationInput): DeviceConnectionState {
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO device_connection_state (
          device_id, management_mode, desired_network_state, observed_network_state,
          connection_generation, retry_count, consecutive_failures, updated_at
        ) VALUES (?, 'manual', 'disconnected', 'offline', 0, 0, 0, ?)
      `).run(input.deviceId, timestamp)
      this.db.prepare(`
        UPDATE device_connection_state
        SET connection_generation = connection_generation + 1,
            operation_id = ?, observed_network_state = ?, deadline_at = ?,
            reason_code = NULL, action_required = NULL, updated_at = ?
        WHERE device_id = ?
      `).run(
        input.operationId,
        input.observedState ?? 'connecting',
        input.deadlineAt,
        timestamp,
        input.deviceId,
      )
      const state = this.get(input.deviceId)
      if (!state) throw new Error(`设备连接状态不存在：${input.deviceId}`)
      this.db.exec('COMMIT')
      return state
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  isCurrent(input: CurrentDeviceConnectionOperationInput): boolean {
    const evaluatedAt = input.evaluatedAt ?? now()
    const row = this.db.prepare(`
      SELECT 1 AS current
      FROM device_connection_state
      WHERE device_id = ?
        AND operation_id = ?
        AND connection_generation = ?
        AND observed_network_state IN ('discovered', 'connecting', 'verifying', 'recovering')
        AND (deadline_at IS NULL OR deadline_at > ?)
    `).get(input.deviceId, input.operationId, input.generation, evaluatedAt) as Row | undefined
    return Boolean(row)
  }

  commit(input: CommitDeviceConnectionOperationInput): boolean {
    const evaluatedAt = input.evaluatedAt ?? now()
    const result = this.db.prepare(`
      UPDATE device_connection_state
      SET observed_network_state = ?,
          desired_network_state = COALESCE(?, desired_network_state),
          active_endpoint_id = CASE
            WHEN ? = 1 THEN NULL
            ELSE COALESCE(?, active_endpoint_id)
          END,
          reason_code = ?,
          action_required = CASE WHEN ? = 'online' THEN NULL ELSE action_required END,
          deadline_at = NULL,
          retry_count = CASE WHEN ? = 'online' THEN 0 ELSE retry_count END,
          consecutive_failures = CASE WHEN ? = 'online' THEN 0 ELSE consecutive_failures END,
          next_retry_at = CASE WHEN ? = 'online' THEN NULL ELSE next_retry_at END,
          last_health_at = CASE WHEN ? = 'online' THEN ? ELSE last_health_at END,
          updated_at = ?
      WHERE device_id = ?
        AND operation_id = ?
        AND connection_generation = ?
        AND observed_network_state IN ('discovered', 'connecting', 'verifying', 'recovering')
        AND (deadline_at IS NULL OR deadline_at > ?)
    `).run(
      input.observedState,
      input.desiredState ?? null,
      input.clearActiveEndpoint ? 1 : 0,
      input.activeEndpointId ?? null,
      input.reasonCode ?? null,
      input.observedState,
      input.observedState,
      input.observedState,
      input.observedState,
      input.observedState,
      evaluatedAt,
      evaluatedAt,
      input.deviceId,
      input.operationId,
      input.generation,
      evaluatedAt,
    )
    return result.changes === 1
  }

  /**
   * Restores a caller-supplied pre-operation snapshot after abort/deadline.
   * Generation and in-progress state remain mandatory; only the elapsed
   * deadline check is intentionally omitted because this is the terminator.
   */
  restoreAfterAbort(input: CommitDeviceConnectionOperationInput): boolean {
    const evaluatedAt = input.evaluatedAt ?? now()
    const result = this.db.prepare(`
      UPDATE device_connection_state
      SET observed_network_state = ?,
          desired_network_state = COALESCE(?, desired_network_state),
          active_endpoint_id = CASE
            WHEN ? = 1 THEN NULL
            ELSE COALESCE(?, active_endpoint_id)
          END,
          reason_code = ?, action_required = ?, deadline_at = NULL, updated_at = ?
      WHERE device_id = ?
        AND operation_id = ?
        AND connection_generation = ?
        AND observed_network_state IN ('discovered', 'connecting', 'verifying', 'recovering')
    `).run(
      input.observedState,
      input.desiredState ?? null,
      input.clearActiveEndpoint ? 1 : 0,
      input.activeEndpointId ?? null,
      input.reasonCode ?? null,
      input.actionRequired ?? null,
      evaluatedAt,
      input.deviceId,
      input.operationId,
      input.generation,
    )
    return result.changes === 1
  }

  recordHealthFailure(input: RecordDeviceConnectionHealthFailureInput): boolean {
    const evaluatedAt = input.evaluatedAt ?? now()
    const result = this.db.prepare(`
      UPDATE device_connection_state
      SET observed_network_state = ?, reason_code = ?, deadline_at = NULL,
          retry_count = retry_count + 1,
          consecutive_failures = consecutive_failures + 1,
          next_retry_at = ?,
          action_required = CASE WHEN ? = 1 THEN 'CHECK_NETWORK_ADB_ENDPOINT' ELSE NULL END,
          last_health_at = ?, updated_at = ?
      WHERE device_id = ?
        AND operation_id = ?
        AND connection_generation = ?
        AND observed_network_state IN ('discovered', 'connecting', 'verifying', 'recovering')
        AND (deadline_at IS NULL OR deadline_at > ?)
    `).run(
      input.manualAction ? 'manual_action' : input.terminal ? 'offline' : 'degraded',
      input.reasonCode,
      input.nextRetryAt ?? null,
      input.manualAction ? 1 : 0,
      evaluatedAt,
      evaluatedAt,
      input.deviceId,
      input.operationId,
      input.generation,
      evaluatedAt,
    )
    return result.changes === 1
  }

  recordPassiveHealth(input: RecordPassiveDeviceConnectionHealthInput): boolean {
    const evaluatedAt = input.evaluatedAt ?? now()
    const healthyWriteThreshold = new Date(Date.parse(evaluatedAt) - 10_000).toISOString()
    const result = input.kind === 'healthy'
      ? this.db.prepare(`
          UPDATE device_connection_state
          SET observed_network_state = 'online', reason_code = NULL,
              retry_count = 0, consecutive_failures = 0, next_retry_at = NULL,
              action_required = NULL, last_health_at = ?, updated_at = ?
          WHERE device_id = ?
            AND active_endpoint_id = ?
            AND connection_generation = ?
            AND observed_network_state IN ('online', 'degraded')
            AND (
              observed_network_state = 'degraded'
              OR last_health_at IS NULL
              OR last_health_at <= ?
            )
        `).run(
          evaluatedAt, evaluatedAt, input.deviceId, input.endpointId,
          input.generation, healthyWriteThreshold,
        )
      : this.db.prepare(`
          UPDATE device_connection_state
          SET observed_network_state = 'degraded', reason_code = ?,
              retry_count = retry_count + 1,
              consecutive_failures = consecutive_failures + 1,
              last_health_at = ?, updated_at = ?
          WHERE device_id = ?
            AND active_endpoint_id = ?
            AND connection_generation = ?
            AND observed_network_state = 'online'
        `).run(
          input.failureCode ?? 'ADB_TRANSPORT_LOST', evaluatedAt, evaluatedAt,
          input.deviceId, input.endpointId, input.generation,
        )
    return result.changes === 1
  }

  expire(input: ExpireDeviceConnectionOperationInput): boolean {
    const evaluatedAt = input.evaluatedAt ?? now()
    const result = this.db.prepare(`
      UPDATE device_connection_state
      SET observed_network_state = 'offline', reason_code = ?,
          deadline_at = NULL, updated_at = ?
      WHERE device_id = ?
        AND operation_id = ?
        AND connection_generation = ?
        AND observed_network_state IN ('discovered', 'connecting', 'verifying', 'recovering')
    `).run(
      input.reasonCode,
      evaluatedAt,
      input.deviceId,
      input.operationId,
      input.generation,
    )
    return result.changes === 1
  }

  markInterrupted(): InterruptedDeviceConnectionOperation[] {
    const rows = this.db.prepare(`
      SELECT device_id, operation_id, connection_generation
      FROM device_connection_state
      WHERE operation_id IS NOT NULL
        AND observed_network_state IN ('discovered', 'connecting', 'verifying', 'recovering')
    `).all() as Row[]
    if (rows.length === 0) return []
    const evaluatedAt = now()
    this.db.prepare(`
      UPDATE device_connection_state
      SET observed_network_state = 'offline', active_endpoint_id = NULL,
          deadline_at = NULL, reason_code = 'SERVICE_RESTARTED', updated_at = ?
      WHERE operation_id IS NOT NULL
        AND observed_network_state IN ('discovered', 'connecting', 'verifying', 'recovering')
    `).run(evaluatedAt)
    return rows.map((row) => ({
      deviceId: asString(row.device_id),
      operationId: asString(row.operation_id),
      generation: asNumber(row.connection_generation),
    }))
  }
}
