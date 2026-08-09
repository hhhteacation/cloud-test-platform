import type { DatabaseSync } from 'node:sqlite'

import type { DeviceRunExecution, DeviceRunJob } from '../contracts.js'
import { createExecutionFailure, serializeExecutionFailure, type ExecutionFailure } from '../../execution/execution-failures.js'
import type {
  DeviceConnectionKind, DevicePlatform, DeviceRunPhase, ExecutionStatus, MediaIntegrityResult, RunStatus, TaskStatus,
} from '../../types.js'
import type { AuditStore } from './audit-store.js'
import { asNumber, asString, now, type Row } from './shared.js'

/** Owns per-device execution state and its guarded state transitions. */
export class DeviceRunStore {
  private onTaskStateChanged: (taskId: string) => void = () => undefined

  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditStore,
  ) {}

  setTaskStateChangedHandler(handler: (taskId: string) => void) {
    this.onTaskStateChanged = handler
  }

  listQueuedJobs(taskId?: string): DeviceRunJob[] {
    return (this.db.prepare(`
      SELECT r.task_id, r.id AS run_id, r.device_id
      FROM device_runs r
      JOIN tasks t ON t.id = r.task_id
      WHERE r.status = 'queued' AND t.status IN ('queued', 'running')
        AND (? IS NULL OR r.task_id = ?)
      ORDER BY t.created_at, r.rowid
    `).all(taskId ?? null, taskId ?? null) as Row[]).map((row) => ({
      taskId: asString(row.task_id), runId: asString(row.run_id), deviceId: asString(row.device_id),
    }))
  }

  getQueueStatus(deviceId: string): 'idle' | 'queued' | 'running' {
    const row = this.db.prepare(`
      SELECT r.status
      FROM device_runs r
      JOIN tasks t ON t.id = r.task_id
      WHERE r.device_id = ?
        AND r.status IN ('queued', 'running')
        AND t.status IN ('queued', 'running')
      ORDER BY CASE r.status WHEN 'running' THEN 0 ELSE 1 END, t.created_at, r.rowid
      LIMIT 1
    `).get(deviceId) as Row | undefined
    const status = asString(row?.status)
    return status === 'running' ? 'running' : status === 'queued' ? 'queued' : 'idle'
  }

  getFirstForTask(taskId: string) {
    const row = this.db.prepare('SELECT * FROM device_runs WHERE task_id = ? ORDER BY rowid LIMIT 1').get(taskId) as Row | undefined
    if (!row) return undefined
    return { id: asString(row.id), deviceId: asString(row.device_id), status: asString(row.status) as RunStatus }
  }

  getExecution(taskId: string, runId: string): DeviceRunExecution | undefined {
    const row = this.db.prepare(`
      SELECT t.status AS task_status, t.timeout_seconds, t.platform,
             a.storage_path AS apk_path, a.package_name AS apk_package_name,
             v.storage_path AS video_path, v.original_name AS video_original_name,
             r.id AS run_id, r.device_id, r.status AS run_status,
             r.endpoint_id, r.connection_kind, COALESCE(r.adb_serial, d.serial) AS device_serial,
             d.name AS device_name
      FROM device_runs r
      JOIN tasks t ON t.id = r.task_id
      JOIN artifacts a ON a.id = t.apk_artifact_id
      JOIN artifacts v ON v.id = t.video_artifact_id
      JOIN devices d ON d.id = r.device_id
      WHERE t.id = ? AND r.id = ?
    `).get(taskId, runId) as Row | undefined
    if (!row) return undefined
    return {
      taskId, runId: asString(row.run_id), deviceId: asString(row.device_id),
      deviceSerial: asString(row.device_serial), deviceName: asString(row.device_name),
      endpointId: asString(row.endpoint_id) || undefined,
      connectionKind: (asString(row.connection_kind) || undefined) as DeviceRunExecution['connectionKind'],
      platform: (asString(row.platform) || 'android') as DevicePlatform,
      apkPath: asString(row.apk_path), apkPackageName: asString(row.apk_package_name) || undefined,
      videoPath: asString(row.video_path), videoOriginalName: asString(row.video_original_name) || 'input.mp4',
      timeoutSeconds: asNumber(row.timeout_seconds),
      taskStatus: asString(row.task_status) as TaskStatus,
      runStatus: asString(row.run_status) as RunStatus,
    }
  }

  listRows(taskId: string) {
    return this.db.prepare('SELECT * FROM device_runs WHERE task_id = ? ORDER BY rowid').all(taskId) as Row[]
  }

  has(taskId: string, runId: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM device_runs WHERE id = ? AND task_id = ?').get(runId, taskId))
  }

  assignExecutionEndpoint(
    job: DeviceRunJob,
    endpoint: { endpointId: string; connectionKind: DeviceConnectionKind; adbSerial: string },
  ) {
    const result = this.db.prepare(`
      UPDATE device_runs
      SET endpoint_id = ?, connection_kind = ?, adb_serial = ?
      WHERE id = ? AND task_id = ? AND device_id = ? AND status = 'queued'
        AND EXISTS (
          SELECT 1 FROM tasks
          WHERE id = ? AND status IN ('queued', 'running')
        )
    `).run(
      endpoint.endpointId, endpoint.connectionKind, endpoint.adbSerial,
      job.runId, job.taskId, job.deviceId, job.taskId,
    )
    return result.changes === 1
  }

  setState(input: {
    taskId: string
    runId: string
    taskStatus?: TaskStatus
    runStatus?: RunStatus
    phase?: DeviceRunPhase
    progress?: number
    failureCode?: string | null
    failureMessage?: string | null
    failure?: ExecutionFailure | null
    executionStatus?: ExecutionStatus
    executionFailureCode?: string | null
    started?: boolean
    finished?: boolean
  }) {
    const task = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(input.taskId) as Row | undefined
    if (!task || asString(task.status) === 'cancelled') return
    const currentRun = this.db.prepare('SELECT * FROM device_runs WHERE id = ? AND task_id = ?').get(input.runId, input.taskId) as Row | undefined
    if (!currentRun) return
    const timestamp = now()
    const phase = input.phase ?? (asString(currentRun.phase) || 'validating_device') as DeviceRunPhase
    const legacyFailureChanged = input.failureCode !== undefined || input.failureMessage !== undefined
    const legacyCode = input.failureCode === undefined ? asString(currentRun.failure_code) || null : input.failureCode
    const legacyMessage = input.failureMessage === undefined ? asString(currentRun.failure_message) || null : input.failureMessage
    const failure = input.failure !== undefined
      ? input.failure
      : legacyFailureChanged && legacyCode
        ? createExecutionFailure({ code: legacyCode, phase, message: legacyMessage || legacyCode })
        : legacyFailureChanged ? null : undefined
    const failureCode = failure === undefined ? legacyCode : failure?.code ?? null
    const failureMessage = failure === undefined ? legacyMessage : failure?.message ?? null
    const failureJson = failure === undefined
      ? asString(currentRun.execution_failure_json) || null
      : serializeExecutionFailure(failure)

    this.db.prepare(`
      UPDATE device_runs SET status = ?, phase = ?, progress = ?,
        failure_code = ?, failure_message = ?, execution_status = ?, execution_failure_code = ?,
        execution_failure_json = ?, started_at = ?, finished_at = ?
      WHERE id = ? AND task_id = ?
    `).run(
      input.runStatus ?? asString(currentRun.status),
      phase,
      input.progress ?? asNumber(currentRun.progress),
      failureCode,
      failureMessage,
      input.executionStatus ?? (asString(currentRun.execution_status) || 'pending'),
      input.executionFailureCode === undefined ? asString(currentRun.execution_failure_code) || null : input.executionFailureCode,
      failureJson,
      input.started ? timestamp : asString(currentRun.started_at) || null,
      input.finished ? timestamp : asString(currentRun.finished_at) || null,
      input.runId, input.taskId,
    )
    this.onTaskStateChanged(input.taskId)
  }

  fail(job: DeviceRunJob, failureCode: string, failureMessage: string) {
    const timestamp = now()
    const row = this.db.prepare('SELECT phase FROM device_runs WHERE id = ? AND task_id = ?')
      .get(job.runId, job.taskId) as Row | undefined
    const failure = createExecutionFailure({
      code: failureCode,
      phase: (asString(row?.phase) || 'validating_device') as DeviceRunPhase,
      message: failureMessage,
    })
    const result = this.db.prepare(`
      UPDATE device_runs
      SET status = 'failed', progress = 100,
          failure_code = ?, failure_message = ?, execution_status = 'failed',
          execution_failure_code = ?, execution_failure_json = ?, finished_at = ?
      WHERE id = ? AND task_id = ?
        AND status IN ('queued', 'running')
        AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status <> 'cancelled')
    `).run(
      failure.code, failure.message, failure.code, serializeExecutionFailure(failure), timestamp,
      job.runId, job.taskId, job.taskId,
    )
    if (result.changes === 1) {
      this.audit.addLog(job.taskId, job.runId, failure.message, 'error')
      this.onTaskStateChanged(job.taskId)
    }
    return result.changes === 1
  }

  recordMediaIntegrity(runId: string, result: MediaIntegrityResult) {
    this.db.prepare(`
      UPDATE device_runs SET media_integrity_status = ?, media_integrity_failure_code = ?, media_metadata = ?
      WHERE id = ?
    `).run(result.status, result.failureCode ?? null, result.metadata ? JSON.stringify(result.metadata) : null, runId)
  }

  cancelForTask(taskId: string, timestamp: string) {
    const rows = this.db.prepare(`
      SELECT id, phase FROM device_runs
      WHERE task_id = ? AND status IN ('queued', 'running')
    `).all(taskId) as Row[]
    const update = this.db.prepare(`
      UPDATE device_runs SET status = 'blocked', progress = 100,
        failure_code = ?, failure_message = ?, execution_status = 'cancelled',
        execution_failure_code = ?, execution_failure_json = ?, finished_at = ?
      WHERE id = ? AND task_id = ? AND status IN ('queued', 'running')
    `)
    for (const row of rows) {
      const failure = createExecutionFailure({
        code: 'TASK_CANCELLED',
        phase: (asString(row.phase) || 'validating_device') as DeviceRunPhase,
        message: '用户取消任务',
      })
      update.run(
        failure.code, failure.message, failure.code, serializeExecutionFailure(failure),
        timestamp, asString(row.id), taskId,
      )
    }
  }
}
