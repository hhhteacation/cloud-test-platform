import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { runDatabaseMigrations } from '../migrations/index.js'
import { ArtifactStore } from './artifact-store.js'
import { AuditStore } from './audit-store.js'
import { DeviceEndpointStore } from './device-endpoint-store.js'
import { DeviceRunStore } from './device-run-store.js'
import { DeviceStore } from './device-store.js'
import { TaskStore } from './task-store.js'
import { NetworkConnectionOperationStore } from './network-connection-operation-store.js'

describe('领域 Store', () => {
  it('Store 只负责各自持久化，并能通过小接口串起任务聚合', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runDatabaseMigrations(db, ':memory:')

    const artifacts = new ArtifactStore(db)
    const devices = new DeviceStore(db)
    const endpoints = new DeviceEndpointStore(db)
    const audit = new AuditStore(db)
    const runs = new DeviceRunStore(db, audit)
    const tasks = new TaskStore(db, artifacts, runs, audit)
    runs.setTaskStateChangedHandler((taskId) => tasks.recompute(taskId))

    const apk = artifacts.insert({
      kind: 'apk', originalName: 'test.apk', mimeType: 'application/vnd.android.package-archive',
      storagePath: '/tmp/test.apk', sizeBytes: 12, sha256: 'apk-sha', packageName: 'com.sdktest.platform',
    })
    const video = artifacts.insert({
      kind: 'video', originalName: 'input.mp4', mimeType: 'video/mp4',
      storagePath: '/tmp/input.mp4', sizeBytes: 24, sha256: 'video-sha',
    })
    const device = devices.upsertAdb({
      id: 'device-1', serial: 'serial-1', name: 'Android 测试机', manufacturer: 'Test',
      model: 'Model', osVersion: 'Android 14', apiLevel: 34, architecture: 'arm64-v8a',
    })
    expect(devices.getBySerial('serial-1')?.id).toBe(device.id)
    expect(endpoints.getByDeviceAndKind(device.id, 'usb')).toMatchObject({ adbSerial: 'serial-1', status: 'online' })
    const network = endpoints.upsert({
      deviceId: device.id, kind: 'network', adbSerial: '192.168.1.20:5555',
      host: '192.168.1.20', port: 5555, status: 'online',
    })
    expect(endpoints.upsert({ ...network, adbSerial: '192.168.1.21:5555', host: '192.168.1.21', status: 'offline' }).id).toBe(network.id)
    expect(endpoints.listForDevice(device.id)).toHaveLength(2)
    expect(artifacts.get(apk.id)?.packageName).toBe('com.sdktest.platform')

    const task = tasks.create({
      name: 'Store 测试任务', apkArtifactId: apk.id, videoArtifactId: video.id,
      deviceIds: [device.id], timeoutSeconds: 300, connectionMode: 'network',
    })
    const taskView = tasks.get(task.id)!
    const run = taskView.runs[device.id]
    expect(taskView.connectionMode).toBe('network')
    expect(run).toMatchObject({ endpointId: undefined, connectionKind: undefined, adbSerial: undefined })
    expect(runs.assignExecutionEndpoint(
      { taskId: task.id, runId: run.id, deviceId: device.id },
      { endpointId: network.id, connectionKind: 'network', adbSerial: '192.168.1.21:5555' },
    )).toBe(true)
    expect(tasks.get(task.id)?.runs[device.id]).toMatchObject({
      endpointId: network.id, connectionKind: 'network', adbSerial: '192.168.1.21:5555',
    })
    expect(runs.getQueueStatus(device.id)).toBe('queued')
    expect(runs.listQueuedJobs()).toEqual([{ taskId: task.id, runId: run.id, deviceId: device.id }])

    audit.upsertCheck(run.id, { key: 'upload', name: '上传', status: 'passed', message: 'ok' })
    audit.upsertCheck(run.id, { key: 'upload', name: '上传', status: 'passed', message: 'updated' })
    expect(audit.listChecks(run.id)).toEqual([{ key: 'upload', name: '上传', status: 'passed', message: 'updated' }])

    runs.setState({ taskId: task.id, runId: run.id, runStatus: 'running', executionStatus: 'running', started: true })
    expect(runs.getQueueStatus(device.id)).toBe('running')
    runs.setState({ taskId: task.id, runId: run.id, runStatus: 'passed', executionStatus: 'passed', progress: 100, finished: true })
    expect(tasks.get(task.id)?.status).toBe('passed')
    expect(tasks.report(task.id)?.conclusion).toBe('passed')

    db.prepare(`
      UPDATE device_runs
      SET status = 'failed', phase = 'processing', failure_code = 'APP_CRASHED',
        failure_message = 'legacy process exit', execution_failure_json = '{broken'
      WHERE id = ?
    `).run(run.id)
    expect(tasks.get(task.id)?.runs[device.id].failure).toMatchObject({
      code: 'APP_CRASHED', category: 'business', phase: 'processing', message: 'legacy process exit',
    })
    expect(runs.getQueueStatus(device.id)).toBe('idle')
    expect(endpoints.remove(network.id)).toBe(true)
    expect(endpoints.get(network.id)).toBeUndefined()

    db.close()
  })

  it('批量联网操作完成历史只保留最近 100 条', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runDatabaseMigrations(db, ':memory:')
    const store = new NetworkConnectionOperationStore(db)
    const timestamp = new Date().toISOString()
    const insertDevice = db.prepare(`
      INSERT INTO devices
        (id, name, manufacturer, os_version, api_level, architecture, execution_mode, eligible, registered_at)
      VALUES (?, ?, 'Example', 'Android 15', 35, 'arm64-v8a', 'adb', 1, ?)
    `)
    const insertEndpoint = db.prepare(`
      INSERT INTO device_endpoints
        (id, device_id, kind, adb_serial, host, port, status, created_at, updated_at)
      VALUES (?, ?, 'network', ?, '192.0.2.10', 5555, 'offline', ?, ?)
    `)
    for (let index = 0; index < 101; index += 1) {
      insertDevice.run(`device-${index}`, `设备-${index}`, timestamp)
      insertEndpoint.run(`endpoint-${index}`, `device-${index}`, `192.0.2.10:${5555 + index}`, timestamp, timestamp)
    }
    const ids: string[] = []
    for (let index = 0; index < 101; index += 1) {
      const operation = store.create({ id: `network-connect-history-${index}`, items: [{ deviceId: `device-${index}`, endpointId: `endpoint-${index}`, host: '192.0.2.10', port: 5555 }] })
      store.finish(operation.id, 'completed')
      ids.push(operation.id)
    }

    expect(store.purgeCompleted(100)).toBe(1)
    expect(store.get(ids[0])).toBeUndefined()
    expect(store.get(ids[1])).toBeDefined()
    expect(store.get(ids[100])).toBeDefined()
    db.close()
  })

  it('批量联网操作 Store 保留 Endpoint 快照、支持取消和重启终止', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runDatabaseMigrations(db, ':memory:')
    const store = new NetworkConnectionOperationStore(db)
    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO devices
        (id, name, manufacturer, os_version, api_level, architecture, execution_mode, eligible, registered_at)
      VALUES ('device-1', '设备-1', 'Example', 'Android 15', 35, 'arm64-v8a', 'adb', 1, ?),
             ('device-2', '设备-2', 'Example', 'Android 15', 35, 'arm64-v8a', 'adb', 1, ?),
             ('device-3', '设备-3', 'Example', 'Android 15', 35, 'arm64-v8a', 'adb', 1, ?)
    `).run(timestamp, timestamp, timestamp)
    db.prepare(`
      INSERT INTO device_endpoints
        (id, device_id, kind, adb_serial, host, port, status, created_at, updated_at)
      VALUES ('endpoint-1', 'device-1', 'network', '192.0.2.10:5555', '192.0.2.10', 5555, 'offline', ?, ?),
             ('endpoint-2', 'device-2', 'network', '192.0.2.11:5555', '192.0.2.11', 5555, 'offline', ?, ?),
             ('endpoint-3', 'device-3', 'network', '192.0.2.12:5555', '192.0.2.12', 5555, 'offline', ?, ?)
    `).run(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp)
    const operation = store.create({ items: [{ deviceId: 'device-1', endpointId: 'endpoint-1', host: '192.0.2.10', port: 5555 }] })
    expect(operation).toMatchObject({ status: 'queued', totalCount: 1, items: [{ status: 'pending', host: '192.0.2.10', port: 5555 }] })
    expect(store.requestCancel(operation.id)?.cancelRequested).toBe(true)
    store.markRunning(operation.id)
    store.updateItem(operation.items[0].id, { status: 'cancelled', cancelReason: 'USER_REQUESTED', finishedAt: new Date().toISOString() })
    expect(store.finish(operation.id, 'cancelled')?.items[0]).toMatchObject({ status: 'cancelled', cancelReason: 'USER_REQUESTED' })

    store.updateItem(operation.items[0].id, {
      status: 'failed', failureCode: 'ADB_PORT_REFUSED', failureMessage: 'connection refused',
      adbExitCode: 1, adbStdout: 'stdout evidence', adbStderr: 'stderr evidence', adbStderrTruncated: true,
    })
    expect(store.updateItem(operation.items[0].id, { status: 'cancelled' })).toMatchObject({
      status: 'cancelled', failureCode: 'ADB_PORT_REFUSED', failureMessage: 'connection refused',
      adbExitCode: 1, adbStdout: 'stdout evidence', adbStderr: 'stderr evidence', adbStderrTruncated: true,
    })
    expect(() => store.create({ items: [{ deviceId: 'device-2', endpointId: 'endpoint-2', host: '192.0.2.11', port: 5555 }] })).not.toThrow()
    db.close()

    const restarted = new DatabaseSync(':memory:')
    runDatabaseMigrations(restarted, ':memory:')
    restarted.prepare(`
      INSERT INTO devices
        (id, name, manufacturer, os_version, api_level, architecture, execution_mode, eligible, registered_at)
      VALUES ('device-3', '设备-3', 'Example', 'Android 15', 35, 'arm64-v8a', 'adb', 1, ?)
    `).run(timestamp)
    restarted.prepare(`
      INSERT INTO device_endpoints
        (id, device_id, kind, adb_serial, host, port, status, created_at, updated_at)
      VALUES ('endpoint-3', 'device-3', 'network', '192.0.2.12:5555', '192.0.2.12', 5555, 'offline', ?, ?)
    `).run(timestamp, timestamp)
    const restartedStore = new NetworkConnectionOperationStore(restarted)
    const active = restartedStore.create({ items: [{ deviceId: 'device-3', endpointId: 'endpoint-3', host: '192.0.2.12', port: 5555 }] })
    restartedStore.markRunning(active.id)
    expect(restartedStore.markInterrupted()).toBe(1)
    expect(restartedStore.get(active.id)).toMatchObject({ status: 'cancelled', cancelReason: 'SERVICE_RESTARTED', items: [{ status: 'cancelled', cancelReason: 'SERVICE_RESTARTED' }] })
    restarted.close()
  })
})
