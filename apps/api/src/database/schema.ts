import type { DatabaseSync } from 'node:sqlite'

const DEVICE_COLUMNS: Array<[string, string]> = [
  ['platform', "TEXT NOT NULL DEFAULT 'android'"],
  ['model', 'TEXT'],
  ['build_version', 'TEXT'],
  ['security_patch', 'TEXT'],
  ['registered_at', 'TEXT'],
  ['last_seen_at', 'TEXT'],
]

function ensureColumns(db: DatabaseSync, table: string, columns: Array<[string, string]>) {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  )
  for (const [name, definition] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }
}

function ensureCompatibleColumns(db: DatabaseSync) {
  ensureColumns(db, 'devices', DEVICE_COLUMNS)
  ensureColumns(db, 'tasks', [['platform', "TEXT NOT NULL DEFAULT 'android'"]])
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS devices_serial_unique
    ON devices(serial)
    WHERE serial IS NOT NULL AND serial <> '';
  `)
}

export function createDatabaseSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, manufacturer TEXT NOT NULL,
      os_version TEXT NOT NULL, api_level INTEGER NOT NULL, architecture TEXT NOT NULL,
      execution_mode TEXT NOT NULL, eligible INTEGER NOT NULL DEFAULT 0, serial TEXT,
      platform TEXT NOT NULL DEFAULT 'android', model TEXT, build_version TEXT,
      security_patch TEXT, registered_at TEXT, last_seen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL, storage_path TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL, package_name TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      apk_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      video_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, pass_rate REAL,
      timeout_seconds INTEGER NOT NULL DEFAULT 300, failure_code TEXT, failure_message TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'android'
    );
    CREATE TABLE IF NOT EXISTS device_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id), status TEXT NOT NULL,
      phase TEXT, progress INTEGER NOT NULL DEFAULT 0, failure_code TEXT,
      failure_message TEXT, started_at TEXT, finished_at TEXT, UNIQUE(task_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS check_results (
      id TEXT PRIMARY KEY, device_run_id TEXT NOT NULL REFERENCES device_runs(id) ON DELETE CASCADE,
      check_key TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
      duration_ms INTEGER, message TEXT, updated_at TEXT NOT NULL,
      UNIQUE(device_run_id, check_key)
    );
    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      device_run_id TEXT REFERENCES device_runs(id) ON DELETE CASCADE,
      level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_outputs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      device_run_id TEXT NOT NULL REFERENCES device_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL,
      storage_path TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_deletion_audits (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_name TEXT NOT NULL,
      status_before_delete TEXT NOT NULL, deleted_by TEXT NOT NULL,
      deleted_record_counts TEXT NOT NULL, deleted_artifact_ids TEXT NOT NULL,
      retained_artifact_ids TEXT NOT NULL, file_cleanup_warnings TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
  `)
  ensureCompatibleColumns(db)
}

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
    'honor-magic-v3', '荣耀 Magic V3', 'HONOR', 'Android 16', 36,
    'arm64-v8a', 'adb', 1, serial, 'FCP_AN10', timestamp,
  )
}

export function markInterruptedTasks(db: DatabaseSync) {
  const timestamp = new Date().toISOString()
  db.prepare(`UPDATE tasks SET status = 'failed', progress = 0, failure_code = 'SERVICE_RESTARTED', failure_message = '本地任务服务重启，未完成任务已终止', updated_at = ? WHERE status = 'running'`).run(timestamp)
  db.prepare(`UPDATE device_runs SET status = 'failed', failure_code = 'SERVICE_RESTARTED', failure_message = '本地任务服务重启，设备执行已终止', finished_at = ? WHERE status = 'running'`).run(timestamp)
}
