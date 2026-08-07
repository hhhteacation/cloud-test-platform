import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getTaskCapabilities } from '../features/tasks/taskCapabilities'
import { readTasks, writeTasks } from '../runner/mockStorage'
import type { TestTask } from '../types'
import { MockTestPlatformClient } from './mockClient'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

function task(id: string, status: TestTask['status'], apkId: string, videoId: string): TestTask {
  return {
    platform: 'android',
    id,
    name: id,
    apk: {
      id: apkId,
      kind: 'apk',
      name: `${apkId}.apk`,
      sizeBytes: 10,
      mimeType: 'application/vnd.android.package-archive',
    },
    asset: {
      id: videoId,
      kind: 'video',
      name: `${videoId}.mp4`,
      sizeBytes: 20,
      mimeType: 'video/mp4',
      previewUrl: `blob:${videoId}`,
    },
    deviceIds: ['honor-magic-v3'],
    status,
    progress: status === 'running' ? 50 : 100,
    createdAt: new Date().toISOString(),
    capabilities: getTaskCapabilities(status),
    runs: {
      'honor-magic-v3': {
        deviceId: 'honor-magic-v3',
        status: status === 'passed' ? 'passed' : status === 'running' ? 'running' : 'blocked',
        progress: status === 'running' ? 50 : 100,
        checks: [{ key: 'load', name: '视频加载', status: 'passed' }],
        logs: ['日志一', '日志二'],
        outputs: [],
        mode: '模拟结果',
      },
    },
  }
}

describe('MockTestPlatformClient', () => {
  it('refreshDevices 返回当前 Mock 设备快照', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T04:00:00.000Z'))
    const client = new MockTestPlatformClient()

    await expect(client.refreshDevices()).resolves.toEqual(await client.listDevices())
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('window', globalThis)
    localStorage.setItem('unrelated-setting', 'keep-me')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('network 模式任务保存实际 Endpoint、连接方式和 ADB serial', async () => {
    vi.useFakeTimers()
    const client = new MockTestPlatformClient()
    const devices = await client.listDevices()
    const device = devices.find((candidate) => candidate.endpoints?.network?.status === 'online')!
    const apk = await client.uploadArtifact(
      new File(['apk'], 'test.apk', { type: 'application/vnd.android.package-archive' }),
      'apk',
    )
    const video = await client.uploadArtifact(new File(['mp4'], 'input.mp4', { type: 'video/mp4' }), 'video')

    const created = await client.createTask({
      name: 'Mock 联网任务', platform: 'android', apkArtifactId: apk.id, videoArtifactId: video.id,
      deviceIds: [device.id], connectionMode: 'network',
      testPlan: { type: 'sdk-video-processing-compatibility', timeoutSeconds: 300 },
    })

    expect(created.connectionMode).toBe('network')
    expect(created.runs[device.id]).toMatchObject({
      endpointId: device.endpoints?.network?.id,
      connectionKind: 'network',
      adbSerial: device.endpoints?.network?.adbSerial,
    })
  })

  it('只删除目标任务并保留共享素材和无关 localStorage 数据', async () => {
    const taskA = task('task-a', 'passed', 'shared-apk', 'video-a')
    const taskB = task('task-b', 'failed', 'shared-apk', 'video-b')
    writeTasks([taskA, taskB])
    const client = new MockTestPlatformClient()

    const receipt = await client.deleteTask(taskA.id)

    expect(readTasks().map((item) => item.id)).toEqual([taskB.id])
    expect(localStorage.getItem('unrelated-setting')).toBe('keep-me')
    expect(receipt.deletedArtifactIds).toEqual(['video-a'])
    expect(receipt.retainedArtifactIds).toEqual(['shared-apk'])
    expect(receipt.deletedRecordCounts).toEqual({
      tasks: 1,
      deviceRuns: 1,
      checkResults: 1,
      logs: 2,
      outputs: 0,
    })
  })

  it('拒绝删除运行中的任务', async () => {
    const runningTask = task('task-running', 'running', 'apk-running', 'video-running')
    writeTasks([runningTask])
    const client = new MockTestPlatformClient()

    await expect(client.deleteTask(runningTask.id)).rejects.toMatchObject({
      code: 'TASK_NOT_DELETABLE',
      status: 409,
    })
    expect(readTasks()).toHaveLength(1)
  })
})
