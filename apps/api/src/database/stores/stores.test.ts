import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { runDatabaseMigrations } from '../migrations/index.js'
import { ArtifactStore } from './artifact-store.js'
import { AuditStore } from './audit-store.js'
import { DeviceEndpointStore } from './device-endpoint-store.js'
import { DeviceRunStore } from './device-run-store.js'
import { DeviceStore } from './device-store.js'
import { TaskStore } from './task-store.js'

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
})
