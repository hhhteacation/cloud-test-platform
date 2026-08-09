import type { DatabaseSync } from 'node:sqlite'

import { createExecutionFailure, serializeExecutionFailure } from '../execution/execution-failures.js'
import type { DeviceRunPhase } from '../types.js'

export function seedDefaultDevices(db: DatabaseSync, serial: string) {
  const timestamp = new Date().toISOString()
  db.prepare(`
    INSERT INTO devices (
      id, name, manufacturer, os_version, api_level, architecture,
      execution_mode, eligible, serial, platform, model, registered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'android', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, manufacturer = excluded.manufacturer,
      os_version = excluded.os_version, api_level = excluded.api_level,
      architecture = excluded.architecture, execution_mode = excluded.execution_mode,
      eligible = excluded.eligible, serial = excluded.serial,
      platform = COALESCE(devices.platform, excluded.platform),
      model = COALESCE(devices.model, excluded.model),
      registered_at = COALESCE(devices.registered_at, excluded.registered_at)
  `).run(
    'honor-magic-v3', '已配置 Android 真机', 'Unknown', 'Android', 0,
    'unknown', 'adb', 1, serial, 'Unknown', timestamp,
  )
}

export function markInterruptedTasks(db: DatabaseSync) {
  const timestamp = new Date().toISOString()
  db.prepare(`UPDATE tasks SET status = 'failed', progress = 0, failure_code = 'SERVICE_RESTARTED', failure_message = '本地任务服务重启，未完成任务已终止', updated_at = ? WHERE status = 'running'`).run(timestamp)
  const rows = db.prepare(`SELECT id, phase FROM device_runs WHERE status = 'running'`).all() as Array<{ id: string; phase?: string }>
  const update = db.prepare(`
    UPDATE device_runs SET status = 'failed', execution_status = 'failed',
      execution_failure_code = ?, failure_code = ?, failure_message = ?,
      execution_failure_json = ?, finished_at = ?
    WHERE id = ? AND status = 'running'
  `)
  for (const row of rows) {
    const failure = createExecutionFailure({
      code: 'SERVICE_RESTARTED',
      phase: (row.phase || 'validating_device') as DeviceRunPhase,
      message: '本地任务服务重启，设备执行已终止',
    })
    update.run(
      failure.code, failure.code, failure.message, serializeExecutionFailure(failure),
      timestamp, row.id,
    )
  }
}
