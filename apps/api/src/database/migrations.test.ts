import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { deviceEndpointsMigration } from './migrations/003-device-endpoints.js'
import { DATABASE_MIGRATIONS, migrationChecksum, runDatabaseMigrations, type DatabaseMigration } from './migrations/index.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

async function databaseFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloud-test-migrations-'))
  directories.push(directory)
  const databasePath = path.join(directory, 'cloud-test.sqlite')
  return { databasePath, db: new DatabaseSync(databasePath) }
}

describe('数据库迁移', () => {
  it('可以重复运行且只应用一次', async () => {
    const { db, databasePath } = await databaseFixture()
    const first = runDatabaseMigrations(db, databasePath)
    const second = runDatabaseMigrations(db, databasePath)
    expect(first.appliedMigrationIds).toEqual(['001-initial-schema', '002-compatibility-columns', '003-device-endpoints', '004-task-execution-endpoint-columns'])
    expect(second.appliedMigrationIds).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toMatchObject({ count: 4 })
    db.close()
  })

  it('checksum 变化时拒绝继续', async () => {
    const { db, databasePath } = await databaseFixture()
    const migration: DatabaseMigration = { id: 'test', definition: 'v1', up: () => undefined }
    runDatabaseMigrations(db, databasePath, [migration])
    const changed = { ...migration, definition: 'v2' }
    expect(migrationChecksum(changed)).not.toBe(migrationChecksum(migration))
    expect(() => runDatabaseMigrations(db, databasePath, [changed])).toThrow(/checksum/)
    db.close()
  })

  it('旧 devices 数据迁移后自动补建 USB Endpoint，并保留任务与 Run 数据', async () => {
    const { db, databasePath } = await databaseFixture()
    runDatabaseMigrations(db, databasePath, DATABASE_MIGRATIONS.slice(0, 2))
    const timestamp = '2026-08-03T00:00:00.000Z'
    db.prepare(`
      INSERT INTO devices (
        id, platform, name, manufacturer, os_version, api_level, architecture,
        execution_mode, eligible, serial, registered_at, last_seen_at
      ) VALUES (?, 'android', '旧设备', 'Example', 'Android 14', 34, 'arm64-v8a', 'adb', 1, ?, ?, ?)
    `).run('legacy-device', 'LEGACY-SERIAL', timestamp, timestamp)

    const result = runDatabaseMigrations(db, databasePath)
    expect(result.appliedMigrationIds).toEqual(['003-device-endpoints', '004-task-execution-endpoint-columns'])
    expect(db.prepare('SELECT device_id, kind, adb_serial, status FROM device_endpoints').get()).toMatchObject({
      device_id: 'legacy-device', kind: 'usb', adb_serial: 'LEGACY-SERIAL', status: 'online',
    })
    expect((db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((column) => column.name)).toContain('connection_mode')
    expect((db.prepare('PRAGMA table_info(device_runs)').all() as Array<{ name: string }>).map((column) => column.name)).toEqual(expect.arrayContaining(['endpoint_id', 'connection_kind', 'adb_serial']))
    expect(db.prepare('SELECT id, serial FROM devices WHERE id = ?').get('legacy-device')).toMatchObject({ id: 'legacy-device', serial: 'LEGACY-SERIAL' })
    db.close()
  })


  it('旧版 003 已登记但缺少任务连接字段时由 004 修复，并保留历史数据', async () => {
    const { db, databasePath } = await databaseFixture()
    const legacyDeviceEndpointsMigration: DatabaseMigration = {
      id: '003-device-endpoints',
      definition: deviceEndpointsMigration,
      up: (database) => database.exec(deviceEndpointsMigration),
    }
    runDatabaseMigrations(db, databasePath, [
      ...DATABASE_MIGRATIONS.slice(0, 2),
      legacyDeviceEndpointsMigration,
    ])

    const timestamp = '2026-08-03T00:00:00.000Z'
    db.prepare(`
      INSERT INTO artifacts
        (id, kind, original_name, mime_type, storage_path, size_bytes, sha256, created_at)
      VALUES
        ('legacy-apk', 'apk', 'legacy.apk', 'application/vnd.android.package-archive', '/tmp/legacy.apk', 10, 'apk-sha', ?),
        ('legacy-video', 'video', 'legacy.mp4', 'video/mp4', '/tmp/legacy.mp4', 20, 'video-sha', ?)
    `).run(timestamp, timestamp)
    db.prepare(`
      INSERT INTO devices
        (id, name, manufacturer, os_version, api_level, architecture, execution_mode, eligible, serial, registered_at, last_seen_at)
      VALUES ('legacy-device', '旧设备', 'Example', 'Android 14', 34, 'arm64-v8a', 'adb', 1, 'LEGACY-SERIAL', ?, ?)
    `).run(timestamp, timestamp)
    db.prepare(`
      INSERT INTO tasks
        (id, name, apk_artifact_id, video_artifact_id, status, progress, timeout_seconds, created_at, updated_at)
      VALUES ('legacy-task', '旧任务', 'legacy-apk', 'legacy-video', 'queued', 0, 300, ?, ?)
    `).run(timestamp, timestamp)
    db.prepare(`
      INSERT INTO device_runs (id, task_id, device_id, status, progress)
      VALUES ('legacy-run', 'legacy-task', 'legacy-device', 'queued', 0)
    `).run()

    const taskColumnsBefore = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((column) => column.name)
    const runColumnsBefore = (db.prepare('PRAGMA table_info(device_runs)').all() as Array<{ name: string }>).map((column) => column.name)
    expect(taskColumnsBefore).not.toContain('connection_mode')
    expect(runColumnsBefore).not.toEqual(expect.arrayContaining(['endpoint_id', 'connection_kind', 'adb_serial']))

    const result = runDatabaseMigrations(db, databasePath)
    expect(result.appliedMigrationIds).toEqual(['004-task-execution-endpoint-columns'])
    expect(result.backupPath).toBeTruthy()
    expect(existsSync(result.backupPath!)).toBe(true)

    const taskColumnsAfter = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((column) => column.name)
    const runColumnsAfter = (db.prepare('PRAGMA table_info(device_runs)').all() as Array<{ name: string }>).map((column) => column.name)
    expect(taskColumnsAfter).toContain('connection_mode')
    expect(runColumnsAfter).toEqual(expect.arrayContaining(['endpoint_id', 'connection_kind', 'adb_serial']))
    expect(db.prepare('SELECT id, name, connection_mode FROM tasks WHERE id = ?').get('legacy-task')).toMatchObject({
      id: 'legacy-task', name: '旧任务', connection_mode: 'auto',
    })
    expect(db.prepare(`
      SELECT id, task_id, device_id, status, endpoint_id, connection_kind, adb_serial
      FROM device_runs WHERE id = ?
    `).get('legacy-run')).toMatchObject({
      id: 'legacy-run', task_id: 'legacy-task', device_id: 'legacy-device', status: 'queued',
      endpoint_id: null, connection_kind: null, adb_serial: null,
    })

    db.prepare(`
      INSERT INTO tasks
        (id, name, apk_artifact_id, video_artifact_id, status, progress, timeout_seconds, connection_mode, created_at, updated_at)
      VALUES ('network-task', '联网任务', 'legacy-apk', 'legacy-video', 'queued', 0, 300, 'network', ?, ?)
    `).run(timestamp, timestamp)
    expect(db.prepare('SELECT connection_mode FROM tasks WHERE id = ?').get('network-task')).toMatchObject({ connection_mode: 'network' })

    db.prepare(`
      UPDATE device_runs SET endpoint_id = ?, connection_kind = ?, adb_serial = ? WHERE id = ?
    `).run('network-endpoint', 'network', '192.168.101.112:5555', 'legacy-run')
    expect(db.prepare('SELECT endpoint_id, connection_kind, adb_serial FROM device_runs WHERE id = ?').get('legacy-run')).toMatchObject({
      endpoint_id: 'network-endpoint', connection_kind: 'network', adb_serial: '192.168.101.112:5555',
    })

    expect(runDatabaseMigrations(db, databasePath).appliedMigrationIds).toEqual([])
    db.close()
  })

})
