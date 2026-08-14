export const networkConnectionOperationsMigration = `
  CREATE TABLE IF NOT EXISTS network_connection_operations (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
    total_count INTEGER NOT NULL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    cancel_reason TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS network_connection_operation_items (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES network_connection_operations(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    endpoint_id TEXT NOT NULL REFERENCES device_endpoints(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
    skip_reason TEXT,
    failure_code TEXT,
    failure_message TEXT,
    adb_exit_code INTEGER,
    adb_stdout TEXT,
    adb_stderr TEXT,
    adb_stdout_truncated INTEGER NOT NULL DEFAULT 0,
    adb_stderr_truncated INTEGER NOT NULL DEFAULT 0,
    cancel_reason TEXT,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS network_connection_operations_status_idx
    ON network_connection_operations(status);
  CREATE INDEX IF NOT EXISTS network_connection_operation_items_operation_idx
    ON network_connection_operation_items(operation_id);
`
