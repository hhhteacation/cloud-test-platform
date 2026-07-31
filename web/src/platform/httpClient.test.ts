import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TestTask } from '../types'
import { HttpTestPlatformClient } from './httpClient'

function legacyTask(status: TestTask['status']): Omit<TestTask, 'capabilities'> {
  return {
    id: `task-${status}`,
    platform: 'android',
    name: '旧版后端任务',
    asset: {
      id: 'video-1',
      kind: 'video',
      name: 'input.mp4',
      sizeBytes: 100,
      mimeType: 'video/mp4',
      previewUrl: '/api/artifacts/video-1/content',
    },
    deviceIds: ['honor-magic-v3'],
    status,
    progress: 100,
    createdAt: '2026-07-30T00:00:00.000Z',
    runs: {},
  }
}

describe('HttpTestPlatformClient task normalization', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('旧版后端缺少 capabilities 时补齐任务能力，避免任务列表渲染白屏', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify([legacyTask('passed')]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))

    const client = new HttpTestPlatformClient('/api')
    const [task] = await client.listTasks()

    expect(task.capabilities).toEqual({ canCancel: false, canDelete: true })
  })

  it('后端已经返回 capabilities 时保留后端能力结果', async () => {
    const serverTask = {
      ...legacyTask('passed'),
      capabilities: {
        canCancel: false,
        canDelete: false,
        deleteBlockedReason: '服务端维护中',
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(serverTask), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))

    const client = new HttpTestPlatformClient('/api')
    const task = await client.getTask(serverTask.id)

    expect(task?.capabilities).toEqual(serverTask.capabilities)
  })
})
