import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { runDatabaseMigrations } from '../migrations/index.js'
import { ArtifactStore } from './artifact-store.js'
import { AuditStore } from './audit-store.js'
import { DeviceEndpointStore } from './device-endpoint-store.js'
import { DeviceRunStore } from './device-run-store.js'
import { DeviceStore } from './device-store.js'
import { TaskStore, TaskStoreError } from './task-store.js'
import { VideoExecutionStore } from './video-execution-store.js'

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


describe('多视频任务领域模型', () => {
  function fixture() {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runDatabaseMigrations(db, ':memory:')
    const artifacts = new ArtifactStore(db)
    const devices = new DeviceStore(db)
    const audit = new AuditStore(db)
    const runs = new DeviceRunStore(db, audit)
    const videoExecutions = new VideoExecutionStore(db)
    const tasks = new TaskStore(db, artifacts, runs, audit, videoExecutions)
    const apk = artifacts.insert({
      kind: 'apk', originalName: 'test.apk', mimeType: 'application/vnd.android.package-archive',
      storagePath: '/tmp/test.apk', sizeBytes: 12, sha256: 'apk-sha', packageName: 'com.sdktest.platform',
    })
    const addVideo = (name: string, sha256 = `sha-${name}`, sizeBytes = 24) => artifacts.insert({
      kind: 'video' as const, originalName: name, mimeType: 'video/mp4',
      storagePath: `/tmp/${name}`, sizeBytes, sha256,
    })
    const addDevice = (id: string) => devices.upsertAdb({
      id, serial: `serial-${id}`, name: id, manufacturer: 'Test', model: 'Model',
      osVersion: 'Android 14', apiLevel: 34, architecture: 'arm64-v8a',
    })
    return { db, artifacts, audit, runs, videoExecutions, tasks, apk, addVideo, addDevice }
  }

  it('按用户顺序创建 TaskVideo，并生成 视频数 × 设备数 的 queued 结果矩阵', () => {
    const context = fixture()
    const first = context.addVideo('first.mp4')
    const second = context.addVideo('second.mp4')
    const deviceA = context.addDevice('device-a')
    const deviceB = context.addDevice('device-b')

    const task = context.tasks.create({
      name: '2×2 矩阵', apkArtifactId: context.apk.id,
      videoArtifactIds: [second.id, first.id],
      deviceIds: [deviceA.id, deviceB.id], timeoutSeconds: 300,
    })

    expect(task.asset.id).toBe(second.id)
    expect(task.videos.map((video) => ({ artifactId: video.artifactId, sequence: video.sequence }))).toEqual([
      { artifactId: second.id, sequence: 0 },
      { artifactId: first.id, sequence: 1 },
    ])
    expect(Object.values(task.videoRuns).flatMap((byDevice) => Object.values(byDevice))).toHaveLength(4)
    for (const video of task.videos) {
      expect(Object.keys(task.videoRuns[video.id])).toEqual([deviceA.id, deviceB.id])
      expect(Object.values(task.videoRuns[video.id])).toEqual([
        expect.objectContaining({ status: 'queued', progress: 0, attempts: [] }),
        expect.objectContaining({ status: 'queued', progress: 0, attempts: [] }),
      ])
    }
    expect(context.db.prepare('SELECT video_artifact_id FROM tasks WHERE id = ?').get(task.id))
      .toMatchObject({ video_artifact_id: second.id })
    expect(context.db.prepare('SELECT COUNT(*) AS count FROM video_run_results WHERE task_id = ?').get(task.id))
      .toMatchObject({ count: 4 })
    context.db.close()
  })

  it('兼容旧 videoArtifactId，并将其映射成唯一的 TaskVideo', () => {
    const context = fixture()
    const video = context.addVideo('legacy-input.mp4')
    const device = context.addDevice('device-legacy')

    const task = context.tasks.create({
      name: '兼容任务', apkArtifactId: context.apk.id, videoArtifactId: video.id,
      deviceIds: [device.id], timeoutSeconds: 300,
    })

    expect(task.videos).toHaveLength(1)
    expect(task.videos[0]).toMatchObject({ artifactId: video.id, sequence: 0, displayName: 'legacy-input.mp4' })
    expect(task.videoRuns[task.videos[0].id][device.id]).toMatchObject({ status: 'queued', attempts: [] })
    context.db.close()
  })

  it('拒绝重复 Artifact、重复内容、超过数量和容量基线的视频集合', () => {
    const context = fixture()
    const device = context.addDevice('device-validation')
    const video = context.addVideo('original.mp4', 'same-content')
    const sameContent = context.addVideo('renamed.mp4', 'same-content')
    const base = {
      name: '非法任务', apkArtifactId: context.apk.id, deviceIds: [device.id], timeoutSeconds: 300,
    }

    expect(() => context.tasks.create({ ...base, videoArtifactIds: [video.id, video.id] }))
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_VIDEO_ID' }) as TaskStoreError)
    expect(() => context.tasks.create({ ...base, videoArtifactIds: [video.id, sameContent.id] }))
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_VIDEO_CONTENT' }) as TaskStoreError)

    const eleven = Array.from({ length: 11 }, (_, index) => context.addVideo(`video-${index}.mp4`))
    expect(context.tasks.create({ ...base, name: '十视频边界', videoArtifactIds: eleven.slice(0, 10).map((item) => item.id) }).videos)
      .toHaveLength(10)
    expect(() => context.tasks.create({ ...base, videoArtifactIds: eleven.map((item) => item.id) }))
      .toThrow(expect.objectContaining({ code: 'VIDEO_LIMIT_EXCEEDED' }) as TaskStoreError)

    const oversized = context.addVideo('oversized.mp4', 'oversized', 4 * 1024 * 1024 * 1024 + 1)
    expect(() => context.tasks.create({ ...base, videoArtifactIds: [oversized.id] }))
      .toThrow(expect.objectContaining({ code: 'VIDEO_TOO_LARGE' }) as TaskStoreError)

    const fourGbA = context.addVideo('four-a.mp4', 'four-a', 4 * 1024 * 1024 * 1024)
    const fourGbB = context.addVideo('four-b.mp4', 'four-b', 4 * 1024 * 1024 * 1024)
    const threeGb = context.addVideo('three.mp4', 'three', 3 * 1024 * 1024 * 1024)
    expect(() => context.tasks.create({ ...base, videoArtifactIds: [fourGbA.id, fourGbB.id, threeGb.id] }))
      .toThrow(expect.objectContaining({ code: 'TASK_VIDEO_BYTES_EXCEEDED' }) as TaskStoreError)
    context.db.close()
  })

  it('隔离设备级与视频级检查、日志和主输出，并保留多次 Attempt', () => {
    const context = fixture()
    const first = context.addVideo('first.mp4')
    const second = context.addVideo('second.mp4')
    const device = context.addDevice('device-scope')
    const task = context.tasks.create({
      name: '作用域测试', apkArtifactId: context.apk.id,
      videoArtifactIds: [first.id, second.id], deviceIds: [device.id], timeoutSeconds: 300,
    })
    const run = task.runs[device.id]
    const firstResult = task.videoRuns[task.videos[0].id][device.id]
    const secondResult = task.videoRuns[task.videos[1].id][device.id]

    context.audit.upsertDeviceCheck(run.id, { key: 'launch', name: '设备准备', status: 'passed' })
    context.audit.upsertVideoCheck(run.id, firstResult.id, { key: 'output', name: '输出', status: 'passed', message: 'first' })
    context.audit.upsertVideoCheck(run.id, secondResult.id, { key: 'output', name: '输出', status: 'failed', message: 'second' })
    context.audit.upsertVideoCheck(run.id, firstResult.id, { key: 'output', name: '输出', status: 'passed', message: 'updated' })
    context.audit.addVideoLog(task.id, run.id, firstResult.id, 'first-log')
    context.audit.addVideoLog(task.id, run.id, secondResult.id, 'second-log')

    expect(context.audit.listDeviceChecks(run.id)).toEqual([
      { key: 'launch', name: '设备准备', status: 'passed', durationMs: undefined, message: undefined },
    ])
    expect(context.audit.listChecksForVideoResult(firstResult.id)).toEqual([
      { key: 'output', name: '输出', status: 'passed', durationMs: undefined, message: 'updated' },
    ])
    expect(context.audit.listChecksForVideoResult(secondResult.id)).toEqual([
      { key: 'output', name: '输出', status: 'failed', durationMs: undefined, message: 'second' },
    ])
    expect(context.audit.listMessagesForVideoResult(firstResult.id)).toEqual(['first-log'])
    expect(context.audit.listMessagesForVideoResult(secondResult.id)).toEqual(['second-log'])

    const firstOutput = context.artifacts.addVideoOutput({
      videoRunResultId: firstResult.id, storagePath: '/tmp/first-output.mp4', sizeBytes: 30, sha256: 'first-output',
    })
    context.artifacts.addVideoOutput({
      videoRunResultId: secondResult.id, storagePath: '/tmp/second-output.mp4', sizeBytes: 31, sha256: 'second-output',
    })
    expect(firstOutput.videoRunResultId).toBe(firstResult.id)
    expect(() => context.artifacts.addVideoOutput({
      videoRunResultId: firstResult.id, storagePath: '/tmp/duplicate-output.mp4', sizeBytes: 32, sha256: 'duplicate-output',
    })).toThrow(/UNIQUE constraint failed/)

    expect(context.videoExecutions.createAttempt(firstResult.id).attemptNumber).toBe(1)
    expect(context.videoExecutions.createAttempt(firstResult.id, {
      status: 'passed', startedAt: '2026-08-14T00:01:00.000Z', finishedAt: '2026-08-14T00:02:00.000Z',
    }).attemptNumber).toBe(2)

    const refreshed = context.tasks.get(task.id)!
    expect(refreshed.videoRuns[task.videos[0].id][device.id]).toMatchObject({
      logs: ['first-log'],
      primaryOutput: { id: firstOutput.id, videoRunResultId: firstResult.id },
      attempts: [{ attemptNumber: 1 }, { attemptNumber: 2 }],
    })
    context.db.close()
  })
})
