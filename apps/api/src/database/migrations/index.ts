import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { initialSchemaSql } from './001-initial-schema.js'
import { compatibilityColumns } from './002-compatibility-columns.js'
import { deviceEndpointsMigration } from './003-device-endpoints.js'
import { taskExecutionEndpointColumns } from './004-task-execution-endpoint-columns.js'
import { structuredExecutionFailureColumns } from './005-structured-execution-failure.js'
import { networkConnectionOperationsMigration } from './006-network-connection-operations.js'
import {
  preserveNetworkConnectionSnapshots,
  preserveNetworkConnectionSnapshotsMigration,
} from './007-preserve-network-connection-snapshots.js'

export interface DatabaseMigration {
  id: string
  definition: unknown
  up(db: DatabaseSync): void
}

function ensureColumns(
  db: DatabaseSync,
  table: string,
  columns: readonly (readonly [string, string])[],
) {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  )
  for (const [name, definition] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }
}

export const DATABASE_MIGRATIONS: DatabaseMigration[] = [
  {
    id: '001-initial-schema',
    definition: initialSchemaSql,
    up: (db) => db.exec(initialSchemaSql),
  },
  {
    id: '002-compatibility-columns',
    definition: compatibilityColumns,
    up: (db) => {
      for (const [table, columns] of Object.entries(compatibilityColumns)) ensureColumns(db, table, columns)
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS devices_serial_unique
        ON devices(serial)
        WHERE serial IS NOT NULL AND serial <> '';
      `)
    },
  },
  {
    id: '003-device-endpoints',
    definition: deviceEndpointsMigration,
    up: (db) => {
      ensureColumns(db, 'tasks', [['connection_mode', "TEXT NOT NULL DEFAULT 'auto'"]])
      ensureColumns(db, 'device_runs', [
        ['endpoint_id', 'TEXT'],
        ['connection_kind', 'TEXT'],
        ['adb_serial', 'TEXT'],
      ])
      db.exec(deviceEndpointsMigration)
      const timestamp = new Date().toISOString()
      db.prepare(`
        INSERT OR IGNORE INTO device_endpoints
          (id, device_id, kind, adb_serial, status, last_seen_at, created_at, updated_at)
        SELECT 'endpoint-usb-' || id, id, 'usb', serial,
               CASE WHEN last_seen_at IS NULL THEN 'unknown' ELSE 'online' END,
               last_seen_at, COALESCE(registered_at, ?), ?
        FROM devices
        WHERE serial IS NOT NULL AND trim(serial) <> ''
      `).run(timestamp, timestamp)
    },
  },
  {
    id: '004-task-execution-endpoint-columns',
    definition: taskExecutionEndpointColumns,
    up: (db) => {
      for (const [table, columns] of Object.entries(taskExecutionEndpointColumns)) {
        ensureColumns(db, table, columns)
      }
    },
  },
  {
    id: '005-structured-execution-failure',
    definition: structuredExecutionFailureColumns,
    up: (db) => {
      for (const [table, columns] of Object.entries(structuredExecutionFailureColumns)) {
        ensureColumns(db, table, columns)
      }
    },
  },
  {
    id: '006-network-connection-operations',
    definition: networkConnectionOperationsMigration,
    up: (db) => db.exec(networkConnectionOperationsMigration),
  },
  {
    id: '007-preserve-network-connection-snapshots',
    definition: preserveNetworkConnectionSnapshotsMigration,
    up: preserveNetworkConnectionSnapshots,
  },
]

export function migrationChecksum(migration: DatabaseMigration) {
  return createHash('sha256')
    .update(JSON.stringify({ id: migration.id, definition: migration.definition }))
    .digest('hex')
}

function quoteSqliteString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function backupBeforeMigration(db: DatabaseSync, databasePath: string) {
  if (!existsSync(databasePath) || statSync(databasePath).size === 0) return undefined
  const directory = path.join(path.dirname(databasePath), 'backups', 'schema')
  mkdirSync(directory, { recursive: true })
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const backupPath = path.join(directory, `before-migration-${timestamp}.sqlite`)
  db.exec(`VACUUM INTO ${quoteSqliteString(backupPath)}`)
  return backupPath
}

export function runDatabaseMigrations(
  db: DatabaseSync,
  databasePath: string,
  migrations: DatabaseMigration[] = DATABASE_MIGRATIONS,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)
  const applied = new Map(
    (db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all() as Array<{ id: string; checksum: string }>)
      .map((row) => [row.id, row.checksum]),
  )

  for (const migration of migrations) {
    const expected = migrationChecksum(migration)
    const existing = applied.get(migration.id)
    if (existing && existing !== expected) {
      throw new Error(`数据库迁移 ${migration.id} 的 checksum 已变化，禁止继续启动`)
    }
  }

  const pending = migrations.filter((migration) => !applied.has(migration.id))
  const backupPath = pending.length > 0 ? backupBeforeMigration(db, databasePath) : undefined
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)')
        .run(migration.id, migrationChecksum(migration), new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`数据库迁移 ${migration.id} 失败${backupPath ? `，迁移前备份：${backupPath}` : ''}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { appliedMigrationIds: pending.map((migration) => migration.id), backupPath }
}
