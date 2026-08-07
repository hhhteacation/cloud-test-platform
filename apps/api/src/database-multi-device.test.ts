import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PlatformDatabase } from './database.js'
import type { ArtifactRecord } from './types.js'

describe('PlatformDatabase 多设备任务聚合', () => {
  let rootDir: string
  let database: PlatformDatabase

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'sdk-multi-device-db-'))
    database = new PlatformDatabase({
      databasePath: path.join(rootDir, 'cloud-test.sqlite'),
      seedDevice: false,
      markInterruptedTasks: false,
    })
    for (const [id, serial] of [['device-a', 'SERIAL-A'], ['device-b', 'SERIAL-B']] as const) {
      database.upsertAdbDevice({
        id,
        serial,
        name: id,
        manufacturer: 'Example',
        model: id.toUpperCase(),
        osVersion: 'Android 15',
        apiLevel: 35,
        architecture: 'arm64-v8a',
      })
    }
  })

  afterEach(async () => {
    database.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  function artifact(kind: 'apk' | 'video'): ArtifactRecord {
    return database.insertArtifact({
      kind,
      originalName: kind === 'apk' ? 'test.apk' : 'input.mp4',
      mimeType: kind === 'apk' ? 'application/vnd.android.package-archive' : 'video/mp4',
      storagePath: path.join(rootDir, kind === 'apk' ? 'test.apk' : 'input.mp4'),
      sizeBytes: 10,
      sha256: `${kind}-sha`,
      packageName: kind === 'apk' ? 'com.morphoinc.videopostprocessor' : undefined,
    })
  }

  function createTwoDeviceTask() {
    const apk = artifact('apk')
    const video = artifact('video')
    return database.createTask({
      platform: 'android',
      name: 'multi-device',
      apkArtifactId: apk.id,
      videoArtifactId: video.id,
      deviceIds: ['device-a', 'device-b'],
      timeoutSeconds: 300,
    })
  }

  it('为每台设备创建独立运行，并返回各自 Serial', () => {
    const task = createTwoDeviceTask()
    const jobs = database.listQueuedDeviceRunJobs(task.id)

    expect(jobs).toHaveLength(2)
    expect(new Set(jobs.map((job) => job.deviceId))).toEqual(new Set(['device-a', 'device-b']))
    expect(jobs.map((job) => database.getDeviceRunExecution(job.taskId, job.runId)?.deviceSerial)).toEqual([
      'SERIAL-A',
      'SERIAL-B',
    ])
  })

  it('按设备运行平均进度和通过设备数聚合任务状态', () => {
    const task = createTwoDeviceTask()
    const [runA, runB] = database.listQueuedDeviceRunJobs(task.id)

    database.setExecutionState({ taskId: task.id, runId: runA.runId, runStatus: 'running', progress: 40, started: true })
    expect(database.getTask(task.id)).toMatchObject({ status: 'running', progress: 20, passRate: 0 })

    database.setExecutionState({ taskId: task.id, runId: runA.runId, runStatus: 'passed', phase: 'completed', progress: 100, finished: true })
    expect(database.getTask(task.id)).toMatchObject({ status: 'running', progress: 50, passRate: 50 })

    database.setExecutionState({
      taskId: task.id,
      runId: runB.runId,
      runStatus: 'failed',
      progress: 100,
      failureCode: 'OUTPUT_MISSING',
      failureMessage: '设备 B 没有生成输出',
      finished: true,
    })
    expect(database.getTask(task.id)).toMatchObject({
      status: 'failed',
      progress: 100,
      passRate: 50,
    })
    expect(database.getReport(task.id)).toMatchObject({ conclusion: 'failed' })
  })

  it('任务取消后忽略 Worker 的迟到状态更新和兜底失败', () => {
    const task = createTwoDeviceTask()
    const [runA] = database.listQueuedDeviceRunJobs(task.id)
    database.cancelTask(task.id)

    database.setExecutionState({ taskId: task.id, runId: runA.runId, runStatus: 'passed', progress: 100, finished: true })
    const fallbackChanged = database.failDeviceRun(runA, 'WORKER_UNEXPECTED_ERROR', 'late error')

    expect(fallbackChanged).toBe(false)
    expect(database.getTask(task.id)?.status).toBe('cancelled')
    expect(database.getTask(task.id)?.runs['device-a']).toMatchObject({
      status: 'blocked',
      failureCode: 'TASK_CANCELLED',
    })
  })

  it('队列兜底只修改目标运行，不影响同任务其他设备', () => {
    const task = createTwoDeviceTask()
    const [runA] = database.listQueuedDeviceRunJobs(task.id)

    expect(database.failDeviceRun(
      runA,
      'INSTALL_USER_ACTION_REQUIRED',
      '检测到荣耀安全风险安装页面，需要人工确认安装授权；平台未自动点击任何含义不明确的按钮。',
    )).toBe(true)
    const updated = database.getTask(task.id)!
    expect(updated.runs['device-a']).toMatchObject({
      status: 'failed',
      failureCode: 'INSTALL_USER_ACTION_REQUIRED',
      failureMessage: expect.stringContaining('需要人工确认安装授权'),
    })
    expect(updated.runs['device-b']).toMatchObject({ status: 'queued' })
    expect(updated.status).toBe('running')
  })
})
