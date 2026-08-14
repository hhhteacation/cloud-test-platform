import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type { CheckResult } from '../../types.js'
import { asNumber, asString, now, type Row } from './shared.js'

/** Owns append-only execution logs and device/video-scoped check-result persistence. */
export class AuditStore {
  constructor(private readonly db: DatabaseSync) {}

  addLog(taskId: string, runId: string, message: string, level = 'info') {
    this.db.prepare('INSERT INTO task_logs (task_id, device_run_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, runId, level, message, now())
  }

  addVideoLog(taskId: string, runId: string, videoRunResultId: string, message: string, level = 'info') {
    const result = this.db.prepare(`
      INSERT INTO task_logs (task_id, device_run_id, video_run_result_id, level, message, created_at)
      SELECT ?, ?, id, ?, ?, ?
      FROM video_run_results
      WHERE id = ? AND task_id = ? AND device_run_id = ?
    `).run(taskId, runId, level, message, now(), videoRunResultId, taskId, runId)
    if (result.changes !== 1) throw new Error(`视频执行结果 ${videoRunResultId} 不属于任务 ${taskId} 的设备运行 ${runId}`)
  }

  /** Compatibility alias: writes a device-scoped check. */
  upsertCheck(runId: string, check: CheckResult) {
    this.upsertDeviceCheck(runId, check)
  }

  upsertDeviceCheck(runId: string, check: CheckResult) {
    const timestamp = now()
    const updated = this.db.prepare(`
      UPDATE check_results
      SET name = ?, status = ?, duration_ms = ?, message = ?, updated_at = ?
      WHERE device_run_id = ? AND video_run_result_id IS NULL AND check_key = ?
    `).run(
      check.name, check.status, check.durationMs ?? null, check.message ?? null,
      timestamp, runId, check.key,
    )
    if (updated.changes > 0) return

    this.db.prepare(`
      INSERT INTO check_results (
        id, device_run_id, video_run_result_id, check_key,
        name, status, duration_ms, message, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `).run(
      `check-${randomUUID()}`, runId, check.key, check.name, check.status,
      check.durationMs ?? null, check.message ?? null, timestamp,
    )
  }

  upsertVideoCheck(runId: string, videoRunResultId: string, check: CheckResult) {
    const timestamp = now()
    const updated = this.db.prepare(`
      UPDATE check_results
      SET name = ?, status = ?, duration_ms = ?, message = ?, updated_at = ?
      WHERE device_run_id = ? AND video_run_result_id = ? AND check_key = ?
    `).run(
      check.name, check.status, check.durationMs ?? null, check.message ?? null,
      timestamp, runId, videoRunResultId, check.key,
    )
    if (updated.changes > 0) return

    const inserted = this.db.prepare(`
      INSERT INTO check_results (
        id, device_run_id, video_run_result_id, check_key,
        name, status, duration_ms, message, updated_at
      )
      SELECT ?, ?, id, ?, ?, ?, ?, ?, ?
      FROM video_run_results
      WHERE id = ? AND device_run_id = ?
    `).run(
      `check-${randomUUID()}`, runId, check.key, check.name, check.status,
      check.durationMs ?? null, check.message ?? null, timestamp,
      videoRunResultId, runId,
    )
    if (inserted.changes !== 1) throw new Error(`视频执行结果 ${videoRunResultId} 不属于设备运行 ${runId}`)
  }

  /** Compatibility view: returns every check currently attached to a DeviceRun. */
  listChecks(runId: string): CheckResult[] {
    return this.mapChecks(this.db.prepare(`
      SELECT * FROM check_results
      WHERE device_run_id = ?
      ORDER BY rowid
    `).all(runId) as Row[])
  }

  listDeviceChecks(runId: string): CheckResult[] {
    return this.mapChecks(this.db.prepare(`
      SELECT * FROM check_results
      WHERE device_run_id = ? AND video_run_result_id IS NULL
      ORDER BY rowid
    `).all(runId) as Row[])
  }

  listChecksForVideoResult(videoRunResultId: string): CheckResult[] {
    return this.mapChecks(this.db.prepare(`
      SELECT * FROM check_results
      WHERE video_run_result_id = ?
      ORDER BY rowid
    `).all(videoRunResultId) as Row[])
  }

  listMessages(runId: string) {
    return (this.db.prepare('SELECT message FROM task_logs WHERE device_run_id = ? ORDER BY id').all(runId) as Row[])
      .map((log) => asString(log.message))
  }

  listDeviceMessages(runId: string) {
    return (this.db.prepare(`
      SELECT message FROM task_logs
      WHERE device_run_id = ? AND video_run_result_id IS NULL
      ORDER BY id
    `).all(runId) as Row[]).map((log) => asString(log.message))
  }

  listMessagesForVideoResult(videoRunResultId: string) {
    return (this.db.prepare(`
      SELECT message FROM task_logs
      WHERE video_run_result_id = ?
      ORDER BY id
    `).all(videoRunResultId) as Row[]).map((log) => asString(log.message))
  }

  private mapChecks(rows: Row[]): CheckResult[] {
    return rows.map((check) => ({
      key: asString(check.check_key), name: asString(check.name),
      status: asString(check.status) as CheckResult['status'],
      durationMs: check.duration_ms == null ? undefined : asNumber(check.duration_ms),
      message: asString(check.message) || undefined,
    }))
  }
}
