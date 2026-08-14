import type { DatabaseSync } from 'node:sqlite'

/**
 * Migration 006 was already applied to some databases with live foreign keys
 * from operation items to devices/endpoints. Operation items are immutable
 * execution snapshots, so their history must survive later endpoint cleanup.
 * Migration 007 rebuilds that table only when those legacy foreign keys exist.
 */
export const preserveNetworkConnectionSnapshotsMigration = `
  -- Rebuild is performed by the migration up() function when legacy foreign keys exist.
`

function hasSnapshotForeignKeys(db: DatabaseSync) {
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(network_connection_operation_items)').all() as Array<{ table?: string; from?: string }>
  return foreignKeys.some((foreignKey) => (
    (foreignKey.table === 'devices' && foreignKey.from === 'device_id')
    || (foreignKey.table === 'device_endpoints' && foreignKey.from === 'endpoint_id')
  ))
}

export function preserveNetworkConnectionSnapshots(db: DatabaseSync) {
  if (!hasSnapshotForeignKeys(db)) return

  db.exec(`
    CREATE TABLE network_connection_operation_items_snapshot_v7 (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES network_connection_operations(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
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
    INSERT INTO network_connection_operation_items_snapshot_v7 (
      id, operation_id, device_id, endpoint_id, host, port, status,
      skip_reason, failure_code, failure_message, adb_exit_code,
      adb_stdout, adb_stderr, adb_stdout_truncated, adb_stderr_truncated,
      cancel_reason, started_at, finished_at
    )
    SELECT
      id, operation_id, device_id, endpoint_id, host, port, status,
      skip_reason, failure_code, failure_message, adb_exit_code,
      adb_stdout, adb_stderr, adb_stdout_truncated, adb_stderr_truncated,
      cancel_reason, started_at, finished_at
    FROM network_connection_operation_items;
    DROP TABLE network_connection_operation_items;
    ALTER TABLE network_connection_operation_items_snapshot_v7 RENAME TO network_connection_operation_items;
    CREATE INDEX IF NOT EXISTS network_connection_operation_items_operation_idx
      ON network_connection_operation_items(operation_id);
  `)
}
