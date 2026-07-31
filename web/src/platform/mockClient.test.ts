import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('MockTestPlatformClient.deleteTask', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    localStorage.setItem('unrelated-setting', 'keep-me')
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
