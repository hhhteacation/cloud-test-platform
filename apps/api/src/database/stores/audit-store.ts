import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type { CheckResult } from '../../types.js'
import { asNumber, asString, now, type Row } from './shared.js'

/** Owns append-only execution logs and check-result persistence. */
export class AuditStore {
  constructor(private readonly db: DatabaseSync) {}

  addLog(taskId: string, runId: string, message: string, level = 'info') {
    this.db.prepare('INSERT INTO task_logs (task_id, device_run_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, runId, level, message, now())
  }

  upsertCheck(runId: string, check: CheckResult) {
    this.db.prepare(`
      INSERT INTO check_results (id, device_run_id, check_key, name, status, duration_ms, message, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_run_id, check_key) DO UPDATE SET
        name = excluded.name, status = excluded.status, duration_ms = excluded.duration_ms,
        message = excluded.message, updated_at = excluded.updated_at
    `).run(
      `check-${randomUUID()}`, runId, check.key, check.name, check.status,
      check.durationMs ?? null, check.message ?? null, now(),
    )
  }

  listChecks(runId: string): CheckResult[] {
    return (this.db.prepare('SELECT * FROM check_results WHERE device_run_id = ? ORDER BY rowid').all(runId) as Row[])
      .map((check) => ({
        key: asString(check.check_key), name: asString(check.name),
        status: asString(check.status) as CheckResult['status'],
        durationMs: check.duration_ms == null ? undefined : asNumber(check.duration_ms),
        message: asString(check.message) || undefined,
      }))
  }

  listMessages(runId: string) {
    return (this.db.prepare('SELECT message FROM task_logs WHERE device_run_id = ? ORDER BY id').all(runId) as Row[])
      .map((log) => asString(log.message))
  }
}
