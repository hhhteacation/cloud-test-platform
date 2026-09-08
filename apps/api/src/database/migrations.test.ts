import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { deviceEndpointsMigration } from "./migrations/003-device-endpoints.js";
import { networkConnectionOperationsMigration } from "./migrations/006-network-connection-operations.js";
import {
  DATABASE_MIGRATIONS,
  migrationChecksum,
  runDatabaseMigrations,
  type DatabaseMigration,
} from "./migrations/index.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

async function databaseFixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cloud-test-migrations-"),
  );
  directories.push(directory);
  const databasePath = path.join(directory, "cloud-test.sqlite");
  return { databasePath, db: new DatabaseSync(databasePath) };
}

describe("数据库迁移", () => {
  it("014 保持已部署定义的 checksum，不修改已应用迁移", () => {
    const migration = DATABASE_MIGRATIONS.find(
      ({ id }) => id === "014-endpoint-logical-identity",
    );
    expect(migration).toBeDefined();
    expect(migrationChecksum(migration!)).toBe(
      "4619dd49c640185100a01eebbf4525bd8c36559ea3bfd0e322e4749489c4cf4a",
    );
  });

  it("可以重复运行且只应用一次", async () => {
    const { db, databasePath } = await databaseFixture();
    const first = runDatabaseMigrations(db, databasePath);
    const second = runDatabaseMigrations(db, databasePath);
    expect(first.appliedMigrationIds).toEqual([
      "001-initial-schema",
      "002-compatibility-columns",
      "003-device-endpoints",
      "004-task-execution-endpoint-columns",
      "005-structured-execution-failure",
      "006-network-connection-operations",
      "007-preserve-network-connection-snapshots",
      "008-task-videos",
      "009-video-run-results",
      "010-device-connection-control",
      "011-attempt-connection-snapshot",
      "012-network-transport-metadata",
      "013-multiple-network-endpoints",
      "014-endpoint-logical-identity",
      "015-endpoint-health",
      "016-endpoint-observation-freshness",
      "017-network-connection-operation-transport-snapshot",
    ]);
    expect(second.appliedMigrationIds).toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get(),
    ).toMatchObject({ count: 17 });
    db.close();
  });

  it("010 为现有物理设备建立连接控制状态和追加式事件表", async () => {
    const { db, databasePath } = await databaseFixture();
    runDatabaseMigrations(db, databasePath, DATABASE_MIGRATIONS.slice(0, 9));
    db.prepare(
      `
      INSERT INTO devices (
        id, name, manufacturer, os_version, api_level, architecture, execution_mode, eligible
      ) VALUES ('controlled-device', '受控设备', 'Example', 'Android 15', 35, 'arm64-v8a', 'adb', 1)
    `,
    ).run();

    runDatabaseMigrations(db, databasePath, DATABASE_MIGRATIONS.slice(0, 10));

    expect(
      db
        .prepare("SELECT * FROM device_connection_state WHERE device_id = ?")
        .get("controlled-device"),
    ).toMatchObject({
      device_id: "controlled-device",
      management_mode: "manual",
      desired_network_state: "disconnected",
      observed_network_state: "offline",
      connection_generation: 0,
      retry_count: 0,
      consecutive_failures: 0,
    });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connection_events'",
        )
        .get(),
    ).toEqual({
      name: "connection_events",
    });
    db.close();
  });

  it("新增联网批量表前生成备份，并保留批量操作快照结构", async () => {
    const { db, databasePath } = await databaseFixture();
    runDatabaseMigrations(db, databasePath, DATABASE_MIGRATIONS.slice(0, 5));
    db.prepare(
      `
      INSERT INTO devices (
        id, name, manufacturer, model, os_version, api_level, architecture, execution_mode, eligible
      ) VALUES ('legacy-device', '旧设备', 'Example', 'Model', 'Android 15', 35, 'arm64-v8a', 'adb', 1)
    `,
    ).run();

    const result = runDatabaseMigrations(db, databasePath);
    expect(result.backupPath).toBeTruthy();
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('network_connection_operations', 'network_connection_operation_items') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "network_connection_operation_items" },
      { name: "network_connection_operations" },
    ]);
    expect(
      db
        .prepare("SELECT id, name FROM devices WHERE id = ?")
        .get("legacy-device"),
    ).toEqual({ id: "legacy-device", name: "旧设备" });
    expect(
      (
        db
          .prepare("PRAGMA table_info(network_connection_operation_items)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    ).toEqual(
      expect.arrayContaining([
        "device_id",
        "endpoint_id",
        "host",
        "port",
        "failure_code",
        "adb_stdout",
        "adb_stderr",
        "cancel_reason",
      ]),
    );
    db.close();
  });

  it("007 将 006 的设备与 Endpoint 外键改为不可变快照，并保留历史明细", async () => {
    const { db, databasePath } = await databaseFixture();
    runDatabaseMigrations(db, databasePath, DATABASE_MIGRATIONS.slice(0, 5));
    db.prepare(
      `
      INSERT INTO devices (
        id, name, manufacturer, os_version, api_level, architecture, execution_mode, eligible
      ) VALUES ('snapshot-device', '快照设备', 'Example', 'Android 15', 35, 'arm64-v8a', 'adb', 1)
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO device_endpoints (
        id, device_id, kind, adb_serial, host, port, status, created_at, updated_at
      ) VALUES ('snapshot-endpoint', 'snapshot-device', 'network', '192.0.2.40:5555', '192.0.2.40', 5555, 'offline', ?, ?)
    `,
    ).run("2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    runDatabaseMigrations(db, databasePath, [DATABASE_MIGRATIONS[5]]);
    db.prepare(
      `
      INSERT INTO network_connection_operations
        (id, status, total_count, created_at)
      VALUES ('snapshot-operation', 'completed', 1, '2026-08-13T00:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO network_connection_operation_items
        (id, operation_id, device_id, endpoint_id, host, port, status)
      VALUES ('snapshot-item', 'snapshot-operation', 'snapshot-device', 'snapshot-endpoint', '192.0.2.40', 5555, 'succeeded')
    `,
    ).run();

    runDatabaseMigrations(db, databasePath);
    expect(
      db
        .prepare("PRAGMA foreign_key_list(network_connection_operation_items)")
        .all(),
    ).toEqual([
      expect.objectContaining({
        table: "network_connection_operations",
        from: "operation_id",
        on_delete: "CASCADE",
      }),
    ]);
    db.prepare("DELETE FROM device_endpoints WHERE id = ?").run(
      "snapshot-endpoint",
    );
    db.prepare("DELETE FROM devices WHERE id = ?").run("snapshot-device");
    expect(
      db
        .prepare(
          "SELECT device_id, endpoint_id, status FROM network_connection_operation_items WHERE id = ?",
        )
        .get("snapshot-item"),
    ).toEqual({
      device_id: "snapshot-device",
      endpoint_id: "snapshot-endpoint",
      status: "succeeded",
    });
    expect(
      db
        .prepare("SELECT id, checksum FROM schema_migrations WHERE id = ?")
        .get("006-network-connection-operations"),
    ).toMatchObject({
      id: "006-network-connection-operations",
      checksum:
        "5087e4369b28b14cb4fdc12babc58a325eba75da197eb92748995daea6089ab2",
    });
    expect(networkConnectionOperationsMigration).toContain(
      "REFERENCES devices(id)",
    );
    db.close();
  });

  it("checksum 变化时拒绝继续", async () => {
    const { db, databasePath } = await databaseFixture();
    const migration: DatabaseMigration = {
      id: "test",
      definition: "v1",
      up: () => undefined,
    };
    runDatabaseMigrations(db, databasePath, [migration]);
    const changed = { ...migration, definition: "v2" };
    expect(migrationChecksum(changed)).not.toBe(migrationChecksum(migration));
    expect(() => runDatabaseMigrations(db, databasePath, [changed])).toThrow(
      /checksum/,
    );
    db.close();
  });

  it("旧 devices 数据迁移后自动补建 USB Endpoint，并保留任务与 Run 数据", async () => {
    const { db, databasePath } = await databaseFixture();
    runDatabaseMigrations(db, databasePath, DATABASE_MIGRATIONS.slice(0, 2));
    const timestamp = "2026-08-03T00:00:00.000Z";
    db.prepare(
      `
      INSERT INTO devices (
        id, platform, name, manufacturer, os_version, api_level, architecture,
        execution_mode, eligible, serial, registered_at, last_seen_at
      ) VALUES (?, 'android', '旧设备', 'Example', 'Android 14', 34, 'arm64-v8a', 'adb', 1, ?, ?, ?)
    `,
    ).run("legacy-device", "LEGACY-SERIAL", timestamp, timestamp);

    const result = runDatabaseMigrations(db, databasePath);
    expect(result.appliedMigrationIds).toEqual([
      "003-device-endpoints",
      "004-task-execution-endpoint-columns",
      "005-structured-execution-failure",
      "006-network-connection-operations",
      "007-preserve-network-connection-snapshots",
      "008-task-videos",
      "009-video-run-results",
      "010-device-connection-control",
      "011-attempt-connection-snapshot",
      "012-network-transport-metadata",
      "013-multiple-network-endpoints",
      "014-endpoint-logical-identity",
      "015-endpoint-health",
      "016-endpoint-observation-freshness",
      "017-network-connection-operation-transport-snapshot",
    ]);
    expect(
      db
        .prepare(
          "SELECT device_id, kind, adb_serial, status FROM device_endpoints",
        )
        .get(),
    ).toMatchObject({
      device_id: "legacy-device",
      kind: "usb",
      adb_serial: "LEGACY-SERIAL",
      status: "online",
    });
    expect(
      (
        db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>
      ).map((column) => column.name),
    ).toContain("connection_mode");
    expect(
      (
        db.prepare("PRAGMA table_info(device_runs)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    ).toEqual(
      expect.arrayContaining([
        "endpoint_id",
        "connection_kind",
        "adb_serial",
        "execution_failure_json",
      ]),
    );
    expect(
      db
        .prepare("SELECT id, serial FROM devices WHERE id = ?")
        .get("legacy-device"),
    ).toMatchObject({ id: "legacy-device", serial: "LEGACY-SERIAL" });
    db.close();
  });

  it("旧版 003 已登记但缺少任务连接字段时由 004 修复，并保留历史数据", async () => {
    const { db, databasePath } = await databaseFixture();
    const legacyDeviceEndpointsMigration: DatabaseMigration = {
      id: "003-device-endpoints",
      definition: deviceEndpointsMigration,
      up: (database) => database.exec(deviceEndpointsMigration),
    };
    runDatabaseMigrations(db, databasePath, [
      ...DATABASE_MIGRATIONS.slice(0, 2),
      legacyDeviceEndpointsMigration,
    ]);

    const timestamp = "2026-08-03T00:00:00.000Z";
    db.prepare(
      `
      INSERT INTO artifacts
        (id, kind, original_name, mime_type, storage_path, size_bytes, sha256, created_at)
      VALUES
        ('legacy-apk', 'apk', 'legacy.apk', 'application/vnd.android.package-archive', '/tmp/legacy.apk', 10, 'apk-sha', ?),
        ('legacy-video', 'video', 'legacy.mp4', 'video/mp4', '/tmp/legacy.mp4', 20, 'video-sha', ?)
    `,
    ).run(timestamp, timestamp);
    db.prepare(
      `
      INSERT INTO devices
        (id, name, manufacturer, os_version, api_level, architecture, execution_mode, eligible, serial, registered_at, last_seen_at)
      VALUES ('legacy-device', '旧设备', 'Example', 'Android 14', 34, 'arm64-v8a', 'adb', 1, 'LEGACY-SERIAL', ?, ?)
    `,
    ).run(timestamp, timestamp);
    db.prepare(
      `
      INSERT INTO tasks
        (id, name, apk_artifact_id, video_artifact_id, status, progress, timeout_seconds, created_at, updated_at)
      VALUES ('legacy-task', '旧任务', 'legacy-apk', 'legacy-video', 'queued', 0, 300, ?, ?)
    `,
    ).run(timestamp, timestamp);
    db.prepare(
      `
      INSERT INTO device_runs (id, task_id, device_id, status, progress)
      VALUES ('legacy-run', 'legacy-task', 'legacy-device', 'queued', 0)
    `,
    ).run();

    const taskColumnsBefore = (
      db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    const runColumnsBefore = (
      db.prepare("PRAGMA table_info(device_runs)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(taskColumnsBefore).not.toContain("connection_mode");
    expect(runColumnsBefore).not.toEqual(
      expect.arrayContaining(["endpoint_id", "connection_kind", "adb_serial"]),
    );

    const result = runDatabaseMigrations(db, databasePath);
    expect(result.appliedMigrationIds).toEqual([
      "004-task-execution-endpoint-columns",
      "005-structured-execution-failure",
      "006-network-connection-operations",
      "007-preserve-network-connection-snapshots",
      "008-task-videos",
      "009-video-run-results",
      "010-device-connection-control",
      "011-attempt-connection-snapshot",
      "012-network-transport-metadata",
      "013-multiple-network-endpoints",
      "014-endpoint-logical-identity",
      "015-endpoint-health",
      "016-endpoint-observation-freshness",
      "017-network-connection-operation-transport-snapshot",
    ]);
    expect(result.backupPath).toBeTruthy();
    expect(existsSync(result.backupPath!)).toBe(true);

    const taskColumnsAfter = (
      db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    const runColumnsAfter = (
      db.prepare("PRAGMA table_info(device_runs)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(taskColumnsAfter).toContain("connection_mode");
    expect(runColumnsAfter).toEqual(
      expect.arrayContaining(["endpoint_id", "connection_kind", "adb_serial"]),
    );
    expect(
      db
        .prepare("SELECT id, name, connection_mode FROM tasks WHERE id = ?")
        .get("legacy-task"),
    ).toMatchObject({
      id: "legacy-task",
      name: "旧任务",
      connection_mode: "auto",
    });
    expect(
      db
        .prepare(
          `
      SELECT id, task_id, device_id, status, endpoint_id, connection_kind, adb_serial
      FROM device_runs WHERE id = ?
    `,
        )
        .get("legacy-run"),
    ).toMatchObject({
      id: "legacy-run",
      task_id: "legacy-task",
      device_id: "legacy-device",
      status: "queued",
      endpoint_id: null,
      connection_kind: null,
      adb_serial: null,
    });

    db.prepare(
      `
      INSERT INTO tasks
        (id, name, apk_artifact_id, video_artifact_id, status, progress, timeout_seconds, connection_mode, created_at, updated_at)
      VALUES ('network-task', '联网任务', 'legacy-apk', 'legacy-video', 'queued', 0, 300, 'network', ?, ?)
    `,
    ).run(timestamp, timestamp);
    expect(
      db
        .prepare("SELECT connection_mode FROM tasks WHERE id = ?")
        .get("network-task"),
    ).toMatchObject({ connection_mode: "network" });

    db.prepare(
      `
      UPDATE device_runs SET endpoint_id = ?, connection_kind = ?, adb_serial = ? WHERE id = ?
    `,
    ).run("network-endpoint", "network", "192.168.101.112:5555", "legacy-run");
    expect(
      db
        .prepare(
          "SELECT endpoint_id, connection_kind, adb_serial FROM device_runs WHERE id = ?",
        )
        .get("legacy-run"),
    ).toMatchObject({
      endpoint_id: "network-endpoint",
      connection_kind: "network",
      adb_serial: "192.168.101.112:5555",
    });

    expect(runDatabaseMigrations(db, databasePath).appliedMigrationIds).toEqual(
      [],
    );
    db.close();
  });

  it("014 收敛同设备同传输 Endpoint 时保留 active 和操作快照引用", async () => {
    const { db, databasePath } = await databaseFixture();
    db.exec("PRAGMA foreign_keys = ON");
    runDatabaseMigrations(db, databasePath, DATABASE_MIGRATIONS.slice(0, 13));
    const oldAt = "2026-08-30T00:00:00.000Z";
    const newAt = "2026-08-31T00:00:00.000Z";
    db.prepare(
      `
      INSERT INTO devices (
        id, platform, name, manufacturer, os_version, api_level, architecture,
        execution_mode, eligible, serial, registered_at, last_seen_at
      ) VALUES ('device-014', 'android', '迁移设备', 'Example', 'Android 15', 35,
        'arm64-v8a', 'adb', 1, 'SERIAL-014', ?, ?)
    `,
    ).run(oldAt, newAt);
    db.prepare(
      `
      INSERT INTO device_endpoints (
        id, device_id, kind, transport_type, adb_serial, host, port,
        service_instance, pairing_state, priority, last_verified_at,
        status, last_seen_at, created_at, updated_at
      ) VALUES
        ('tcp-014', 'device-014', 'network', 'tcp_legacy', '192.0.2.14:5555',
         '192.0.2.14', 5555, NULL, NULL, 50, ?, 'online', ?, ?, ?),
        ('tls-old-014', 'device-014', 'network', 'wireless_tls', '192.0.2.14:33427',
         '192.0.2.14', 33427, 'adb-SERIAL-014-tls', 'observed_working', 100, ?, 'offline', ?, ?, ?),
        ('tls-new-014', 'device-014', 'network', 'wireless_tls', '192.0.2.14:42747',
         '192.0.2.14', 42747, 'adb-SERIAL-014-tls', 'observed_working', 100, ?, 'online', ?, ?, ?)
    `,
    ).run(
      oldAt,
      oldAt,
      oldAt,
      oldAt,
      oldAt,
      oldAt,
      oldAt,
      oldAt,
      newAt,
      newAt,
      newAt,
      newAt,
    );
    db.prepare(
      `
      INSERT INTO devices (
        id, platform, name, manufacturer, os_version, api_level, architecture,
        execution_mode, eligible, serial, registered_at, last_seen_at
      ) VALUES ('device-014-rank', 'android', '迁移排序设备', 'Example', 'Android 15', 35,
        'arm64-v8a', 'adb', 1, 'SERIAL-014-RANK', ?, ?)
    `,
    ).run(oldAt, newAt);
    db.prepare(
      `
      INSERT INTO device_endpoints (
        id, device_id, kind, transport_type, adb_serial, host, port,
        service_instance, pairing_state, priority, last_verified_at,
        status, last_seen_at, created_at, updated_at
      ) VALUES
        ('tls-online-old-rank', 'device-014-rank', 'network', 'wireless_tls',
         '192.0.2.15:33427', '192.0.2.15', 33427, 'adb-SERIAL-014-RANK-tls',
         'observed_working', 100, ?, 'online', ?, ?, ?),
        ('tls-verified-new-rank', 'device-014-rank', 'network', 'wireless_tls',
         '192.0.2.15:42747', '192.0.2.15', 42747, 'adb-SERIAL-014-RANK-tls',
         'observed_working', 100, ?, 'offline', ?, ?, ?)
    `,
    ).run(oldAt, oldAt, oldAt, oldAt, newAt, newAt, newAt, newAt);
    db.prepare(
      `
      INSERT INTO device_connection_state (
        device_id, management_mode, desired_network_state, observed_network_state,
        active_endpoint_id, connection_generation, retry_count, consecutive_failures, updated_at
      ) VALUES ('device-014', 'managed', 'connected', 'online', 'tls-old-014', 7, 0, 0, ?)
    `,
    ).run(newAt);
    db.prepare(
      `
      INSERT INTO network_connection_operations (id, status, total_count, created_at)
      VALUES ('operation-014', 'completed', 1, ?)
    `,
    ).run(newAt);
    db.prepare(
      `
      INSERT INTO network_connection_operation_items (
        id, operation_id, device_id, endpoint_id, host, port, status
      ) VALUES ('item-014', 'operation-014', 'device-014', 'tls-new-014',
        '192.0.2.14', 42747, 'succeeded')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO device_endpoints (
        id, device_id, kind, transport_type, adb_serial, host, port,
        service_instance, pairing_state, priority, last_verified_at,
        status, last_seen_at, created_at, updated_at
      ) VALUES ('tls-attempt-014', 'device-014', 'network', 'wireless_tls',
        '192.0.2.14:43888', '192.0.2.14', 43888, 'adb-SERIAL-014-tls',
        'observed_working', 100, ?, 'offline', ?, ?, ?)
    `,
    ).run(oldAt, oldAt, oldAt, oldAt);
    db.prepare(
      `
      INSERT INTO artifacts
        (id, kind, original_name, mime_type, storage_path, size_bytes, sha256, created_at)
      VALUES
        ('apk-014', 'apk', 'test-014.apk', 'application/vnd.android.package-archive',
         '/tmp/test-014.apk', 10, 'apk-sha-014', ?),
        ('video-014', 'video', 'video-014.mp4', 'video/mp4',
         '/tmp/video-014.mp4', 20, 'video-sha-014', ?)
    `,
    ).run(oldAt, oldAt);
    db.prepare(
      `
      INSERT INTO tasks (
        id, name, apk_artifact_id, video_artifact_id, status, progress,
        timeout_seconds, connection_mode, created_at, updated_at
      ) VALUES ('task-014', '迁移引用任务', 'apk-014', 'video-014',
        'running', 50, 300, 'network', ?, ?)
    `,
    ).run(oldAt, newAt);
    db.prepare(
      `
      INSERT INTO task_videos (
        id, task_id, artifact_id, sequence, display_name, created_at
      ) VALUES ('task-video-014', 'task-014', 'video-014', 0, 'video-014.mp4', ?)
    `,
    ).run(oldAt);
    db.prepare(
      `
      INSERT INTO device_runs (
        id, task_id, device_id, status, progress, endpoint_id,
        connection_kind, adb_serial
      ) VALUES ('device-run-014', 'task-014', 'device-014', 'running', 50,
        'tls-new-014', 'network', '192.0.2.14:42747')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO video_run_results (
        id, task_id, task_video_id, device_run_id, status, progress
      ) VALUES ('video-run-014', 'task-014', 'task-video-014',
        'device-run-014', 'running', 50)
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO video_run_attempts (
        id, video_run_result_id, attempt_number, status, created_at,
        endpoint_id, connection_kind, network_transport, adb_serial,
        endpoint_generation
      ) VALUES ('video-attempt-014', 'video-run-014', 1, 'running', ?,
        'tls-attempt-014', 'network', 'wireless_tls', '192.0.2.14:43888', 6)
    `,
    ).run(newAt);

    const result = runDatabaseMigrations(db, databasePath, [
      DATABASE_MIGRATIONS[13],
    ]);

    expect(result.appliedMigrationIds).toEqual([
      "014-endpoint-logical-identity",
    ]);
    expect(
      db
        .prepare(
          `
      SELECT id, is_canonical, superseded_by
      FROM device_endpoints
      WHERE device_id = 'device-014' AND transport_type = 'wireless_tls'
      ORDER BY id
    `,
        )
        .all(),
    ).toEqual([
      {
        id: "tls-attempt-014",
        is_canonical: 0,
        superseded_by: "tls-old-014",
      },
      { id: "tls-new-014", is_canonical: 0, superseded_by: "tls-old-014" },
      { id: "tls-old-014", is_canonical: 1, superseded_by: null },
    ]);
    expect(
      db
        .prepare(
          `
      SELECT id FROM device_endpoints
      WHERE device_id = 'device-014-rank' AND transport_type = 'wireless_tls'
        AND is_canonical = 1
    `,
        )
        .get(),
    ).toEqual({ id: "tls-verified-new-rank" });
    expect(
      db
        .prepare(
          `
      SELECT active_endpoint_id FROM device_connection_state WHERE device_id = 'device-014'
    `,
        )
        .get(),
    ).toEqual({ active_endpoint_id: "tls-old-014" });
    expect(
      db
        .prepare(
          `
      SELECT endpoint_id, host, port FROM network_connection_operation_items WHERE id = 'item-014'
    `,
        )
        .get(),
    ).toEqual({ endpoint_id: "tls-new-014", host: "192.0.2.14", port: 42747 });
    expect(
      db
        .prepare(
          "SELECT endpoint_id, connection_kind, adb_serial FROM device_runs WHERE id = 'device-run-014'",
        )
        .get(),
    ).toEqual({
      endpoint_id: "tls-new-014",
      connection_kind: "network",
      adb_serial: "192.0.2.14:42747",
    });
    expect(
      db
        .prepare(
          `
      SELECT endpoint_id, connection_kind, network_transport, adb_serial, endpoint_generation
      FROM video_run_attempts WHERE id = 'video-attempt-014'
    `,
        )
        .get(),
    ).toEqual({
      endpoint_id: "tls-attempt-014",
      connection_kind: "network",
      network_transport: "wireless_tls",
      adb_serial: "192.0.2.14:43888",
      endpoint_generation: 6,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      (
        db.prepare("PRAGMA table_info(device_endpoints)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    ).toEqual(expect.arrayContaining(["superseded_by", "is_canonical"]));
    db.close();
  });

  it("015 为每个 Endpoint 增加独立健康计数、退避和最近健康时间", async () => {
    const { db, databasePath } = await databaseFixture();
    runDatabaseMigrations(db, databasePath);
    const columns = new Map(
      (
        db.prepare("PRAGMA table_info(device_endpoints)").all() as Array<{
          name: string;
          dflt_value: string | null;
        }>
      ).map((column) => [column.name, column]),
    );

    expect(columns.get("consecutive_failures")).toMatchObject({
      dflt_value: "0",
    });
    expect(columns.has("next_retry_at")).toBe(true);
    expect(columns.has("last_health_at")).toBe(true);
    db.close();
  });

  it("016 在已部署 014 后补齐 Observation freshness 列并保留 Endpoint", async () => {
    const { db, databasePath } = await databaseFixture();
    runDatabaseMigrations(db, databasePath, DATABASE_MIGRATIONS.slice(0, 14));
    const timestamp = "2026-09-01T00:00:00.000Z";
    db.prepare(
      `
      INSERT INTO devices (
        id, name, manufacturer, os_version, api_level, architecture,
        execution_mode, eligible
      ) VALUES ('device-016', '观察迁移设备', 'Example', 'Android 15', 35,
        'arm64-v8a', 'adb', 1)
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO device_endpoints (
        id, device_id, kind, transport_type, adb_serial, host, port, status,
        created_at, updated_at
      ) VALUES ('endpoint-016', 'device-016', 'network', 'wireless_tls',
        '192.0.2.16:33427', '192.0.2.16', 33427, 'online', ?, ?)
    `,
    ).run(timestamp, timestamp);

    const columnsBefore = (
      db.prepare("PRAGMA table_info(device_endpoints)").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name);
    expect(columnsBefore).not.toContain("last_observation_at");

    const result = runDatabaseMigrations(db, databasePath);
    expect(result.appliedMigrationIds).toEqual([
      "015-endpoint-health",
      "016-endpoint-observation-freshness",
      "017-network-connection-operation-transport-snapshot",
    ]);
    const columnsAfter = (
      db.prepare("PRAGMA table_info(device_endpoints)").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name);
    expect(columnsAfter).toEqual(
      expect.arrayContaining([
        "last_observation_at",
        "observation_expires_at",
        "observation_source",
      ]),
    );

    db.prepare(
      `
      UPDATE device_endpoints
      SET last_observation_at = ?, observation_expires_at = ?, observation_source = 'mdns'
      WHERE id = 'endpoint-016'
    `,
    ).run(timestamp, "2026-09-01T00:01:00.000Z");
    expect(
      db
        .prepare(
          `
      SELECT id, last_observation_at, observation_expires_at, observation_source
      FROM device_endpoints WHERE id = 'endpoint-016'
    `,
        )
        .get(),
    ).toEqual({
      id: "endpoint-016",
      last_observation_at: timestamp,
      observation_expires_at: "2026-09-01T00:01:00.000Z",
      observation_source: "mdns",
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("017 为联网连接操作项增加可空的传输快照字段，并保留旧项兼容性", async () => {
    const { db, databasePath } = await databaseFixture();
    runDatabaseMigrations(db, databasePath, DATABASE_MIGRATIONS.slice(0, 16));

    const before = (
      db
        .prepare("PRAGMA table_info(network_connection_operation_items)")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(before).not.toEqual(
      expect.arrayContaining(["transport_type", "service_instance"]),
    );

    const result = runDatabaseMigrations(db, databasePath, [
      DATABASE_MIGRATIONS[16],
    ]);
    expect(result.appliedMigrationIds).toEqual([
      "017-network-connection-operation-transport-snapshot",
    ]);
    expect(
      (
        db
          .prepare("PRAGMA table_info(network_connection_operation_items)")
          .all() as Array<{ name: string; notnull: number }>
      ).filter(({ name }) => ["transport_type", "service_instance"].includes(name)),
    ).toEqual([
      expect.objectContaining({ name: "transport_type", notnull: 0 }),
      expect.objectContaining({ name: "service_instance", notnull: 0 }),
    ]);

    db.prepare(
      `
      INSERT INTO network_connection_operations
        (id, status, total_count, created_at)
      VALUES ('operation-017', 'completed', 2, '2026-09-03T00:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO network_connection_operation_items
        (id, operation_id, device_id, endpoint_id, host, port, status,
         transport_type, service_instance)
      VALUES
        ('item-017-tls', 'operation-017', 'device-017', 'endpoint-017',
         '192.0.2.17', 42747, 'succeeded', 'wireless_tls',
         'adb-SERIAL-017._adb-tls-connect._tcp.local'),
        ('item-017-legacy', 'operation-017', 'device-017', 'endpoint-018',
         '192.0.2.18', 5555, 'skipped', NULL, NULL)
    `,
    ).run();
    expect(
      db
        .prepare(
          `
      SELECT transport_type, service_instance
      FROM network_connection_operation_items
      WHERE id = 'item-017-tls'
    `,
        )
        .get(),
    ).toEqual({
      transport_type: "wireless_tls",
      service_instance: "adb-SERIAL-017._adb-tls-connect._tcp.local",
    });
    expect(
      db
        .prepare(
          `
      SELECT transport_type, service_instance
      FROM network_connection_operation_items
      WHERE id = 'item-017-legacy'
    `,
        )
        .get(),
    ).toEqual({ transport_type: null, service_instance: null });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("表重建迁移失败时回滚源库并恢复外键检查，且保留一致性备份", async () => {
    const { db, databasePath } = await databaseFixture();
    db.exec("PRAGMA foreign_keys = ON");
    runDatabaseMigrations(db, databasePath, DATABASE_MIGRATIONS.slice(0, 1));
    db.prepare(
      `
      INSERT INTO devices (
        id, name, manufacturer, os_version, api_level, architecture,
        execution_mode, eligible
      ) VALUES ('rollback-device', '迁移前名称', 'Example', 'Android 15', 35,
        'arm64-v8a', 'adb', 1)
    `,
    ).run();

    const failingMigration: DatabaseMigration = {
      id: "test-failing-table-rebuild",
      definition: { purpose: "verify transactional rollback and backup" },
      foreignKeysOffDuringMigration: true,
      up(migrationDb) {
        migrationDb.exec(`
          UPDATE devices SET name = '不应提交的名称' WHERE id = 'rollback-device';
          CREATE TABLE migration_should_rollback (id TEXT PRIMARY KEY);
          INSERT INTO migration_should_rollback (id) VALUES ('temporary-row');
        `);
        throw new Error("injected migration failure");
      },
    };

    let thrown: Error | undefined;
    try {
      runDatabaseMigrations(db, databasePath, [failingMigration]);
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    expect(thrown?.message).toContain(
      "数据库迁移 test-failing-table-rebuild 失败",
    );
    expect(thrown?.message).toContain("迁移前备份：");
    expect(thrown?.message).toContain("injected migration failure");
    const backupPath = thrown?.message.match(/迁移前备份：(.+?)：/)?.[1];
    expect(backupPath).toBeTruthy();
    expect(existsSync(backupPath!)).toBe(true);
    expect(
      db.prepare("SELECT name FROM devices WHERE id = 'rollback-device'").get(),
    ).toEqual({ name: "迁移前名称" });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_should_rollback'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT id FROM schema_migrations WHERE id = 'test-failing-table-rebuild'",
        )
        .get(),
    ).toBeUndefined();
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("把历史单视频任务回填为 TaskVideo、VideoRunResult，并把输出与检查项关联到视频结果", async () => {
    const { db, databasePath } = await databaseFixture();
    runDatabaseMigrations(db, databasePath, DATABASE_MIGRATIONS.slice(0, 5));
    const timestamp = "2026-08-14T00:00:00.000Z";
    db.prepare(
      `
      INSERT INTO artifacts
        (id, kind, original_name, mime_type, storage_path, size_bytes, sha256, created_at)
      VALUES
        ('apk-1', 'apk', 'test.apk', 'application/vnd.android.package-archive', '/tmp/test.apk', 10, 'apk-sha', ?),
        ('video-1', 'video', 'legacy.mp4', 'video/mp4', '/tmp/legacy.mp4', 20, 'video-sha', ?)
    `,
    ).run(timestamp, timestamp);
    db.prepare(
      `
      INSERT INTO devices
        (id, name, manufacturer, os_version, api_level, architecture, execution_mode, eligible)
      VALUES ('device-1', '测试设备', 'Example', 'Android 14', 34, 'arm64-v8a', 'adb', 1)
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO tasks
        (id, name, apk_artifact_id, video_artifact_id, status, progress, timeout_seconds, connection_mode, created_at, updated_at)
      VALUES ('task-1', '历史任务', 'apk-1', 'video-1', 'passed', 100, 300, 'auto', ?, ?)
    `,
    ).run(timestamp, timestamp);
    db.prepare(
      `
      INSERT INTO device_runs
        (id, task_id, device_id, status, phase, progress, execution_status, media_integrity_status, started_at, finished_at)
      VALUES ('run-1', 'task-1', 'device-1', 'passed', 'completed', 100, 'passed', 'passed', ?, ?)
    `,
    ).run(timestamp, timestamp);
    db.prepare(
      `
      INSERT INTO check_results
        (id, device_run_id, check_key, name, status, message, updated_at)
      VALUES ('check-1', 'run-1', 'output_generated', '生成输出', 'passed', 'ok', ?)
    `,
    ).run(timestamp);
    db.prepare(
      `
      INSERT INTO task_outputs
        (id, task_id, device_run_id, kind, name, mime_type, storage_path, size_bytes, sha256, created_at)
      VALUES ('output-1', 'task-1', 'run-1', 'processed_video', 'output.mp4', 'video/mp4', '/tmp/output.mp4', 30, 'output-sha', ?)
    `,
    ).run(timestamp);

    const result = runDatabaseMigrations(db, databasePath);
    expect(result.appliedMigrationIds).toEqual([
      "006-network-connection-operations",
      "007-preserve-network-connection-snapshots",
      "008-task-videos",
      "009-video-run-results",
      "010-device-connection-control",
      "011-attempt-connection-snapshot",
      "012-network-transport-metadata",
      "013-multiple-network-endpoints",
      "014-endpoint-logical-identity",
      "015-endpoint-health",
      "016-endpoint-observation-freshness",
      "017-network-connection-operation-transport-snapshot",
    ]);

    const taskVideo = db
      .prepare("SELECT * FROM task_videos WHERE task_id = ?")
      .get("task-1") as Record<string, unknown>;
    expect(taskVideo).toMatchObject({
      task_id: "task-1",
      artifact_id: "video-1",
      sequence: 0,
      display_name: "legacy.mp4",
    });
    const videoRun = db
      .prepare("SELECT * FROM video_run_results WHERE device_run_id = ?")
      .get("run-1") as Record<string, unknown>;
    expect(videoRun).toMatchObject({
      task_id: "task-1",
      task_video_id: taskVideo.id,
      device_run_id: "run-1",
      status: "passed",
      phase: "completed",
      progress: 100,
      media_integrity_status: "passed",
    });
    expect(
      db
        .prepare("SELECT video_run_result_id FROM check_results WHERE id = ?")
        .get("check-1"),
    ).toMatchObject({ video_run_result_id: videoRun.id });
    expect(
      db
        .prepare("SELECT video_run_result_id FROM task_outputs WHERE id = ?")
        .get("output-1"),
    ).toMatchObject({ video_run_result_id: videoRun.id });
    expect(
      db
        .prepare(
          "SELECT video_run_result_id, attempt_number, status FROM video_run_attempts",
        )
        .get(),
    ).toMatchObject({
      video_run_result_id: videoRun.id,
      attempt_number: 1,
      status: "passed",
    });
    db.close();
  });
});
