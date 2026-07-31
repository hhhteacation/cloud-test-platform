import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PlatformDatabase } from '../database.js'
import { TaskDeletionService } from '../task-deletion.js'
import type { ArtifactRecord, TaskStatus } from '../types.js'
import { registerTaskDeletionRoute, type TaskDeletionModule } from './task-deletion-route.js'

describe('DELETE /api/tasks/:id', () => {
  let rootDir: string
  let artifactsDir: string
  let tasksDir: string
  let database: PlatformDatabase
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'sdk-task-delete-route-'))
    artifactsDir = path.join(rootDir, 'artifacts')
    tasksDir = path.join(rootDir, 'tasks')
    await Promise.all([
      mkdir(artifactsDir, { recursive: true }),
      mkdir(tasksDir, { recursive: true }),
    ])

    database = new PlatformDatabase({
      databasePath: path.join(rootDir, 'cloud-test.sqlite'),
      deviceSerial: 'test-device',
      markInterruptedTasks: false,
    })
    app = Fastify({ logger: false })
    registerTaskDeletionRoute(app, new TaskDeletionService(database, {
      artifactsDir,
      tasksDir,
      trashDir: path.join(rootDir, '.trash'),
    }))
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    database.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  async function createArtifact(kind: 'apk' | 'video', label: string) {
    const directory = path.join(artifactsDir, `store-${label}`)
    const storagePath = path.join(directory, kind === 'apk' ? 'test.apk' : 'input.mp4')
    await mkdir(directory, { recursive: true })
    await writeFile(storagePath, label)
    return database.insertArtifact({
      kind,
      originalName: kind === 'apk' ? `${label}.apk` : `${label}.mp4`,
      mimeType: kind === 'apk' ? 'application/vnd.android.package-archive' : 'video/mp4',
      storagePath,
      sizeBytes: Buffer.byteLength(label),
      sha256: `sha-${label}`,
      packageName: kind === 'apk' ? 'com.morphoinc.videopostprocessor' : undefined,
    })
  }

  async function createTask(status: TaskStatus) {
    const apk: ArtifactRecord = await createArtifact('apk', `${status}-apk`)
    const video: ArtifactRecord = await createArtifact('video', `${status}-video`)
    const task = database.createTask({
      name: `${status} task`,
      apkArtifactId: apk.id,
      videoArtifactId: video.id,
      deviceIds: ['honor-magic-v3'],
      timeoutSeconds: 300,
    })
    database.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, task.id)
    await mkdir(path.join(tasksDir, task.id), { recursive: true })
    return task
  }

  it('返回 200 和删除回执', async () => {
    const task = await createTask('passed')

    const response = await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      taskId: task.id,
      deletedRecordCounts: { tasks: 1, deviceRuns: 1 },
      fileCleanupWarnings: [],
    })
    expect(database.getTask(task.id)).toBeUndefined()
  })

  it.each([
    ['非法 ID', '../cloud-test.sqlite', 400, 'INVALID_TASK_ID'],
    ['不存在', 'task-does-not-exist', 404, 'TASK_NOT_FOUND'],
  ])('将%s错误映射为 HTTP 响应', async (_label, taskId, statusCode, code) => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${encodeURIComponent(taskId)}`,
    })

    expect(response.statusCode).toBe(statusCode)
    expect(response.json()).toMatchObject({ code })
  })

  it.each(['queued', 'running'] as const)('对 %s 任务返回 409', async (status) => {
    const task = await createTask(status)

    const response = await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}` })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'TASK_NOT_DELETABLE' })
    expect(database.getTask(task.id)?.status).toBe(status)
  })

  it('隐藏未知异常并返回统一 500 错误', async () => {
    const isolatedApp = Fastify({ logger: false })
    const failingModule: TaskDeletionModule = {
      async deleteTask() {
        throw new Error('sensitive absolute path: /private/data/file')
      },
    }
    registerTaskDeletionRoute(isolatedApp, failingModule)
    await isolatedApp.ready()

    try {
      const response = await isolatedApp.inject({ method: 'DELETE', url: '/api/tasks/task-failure' })
      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({
        code: 'TASK_DELETE_FAILED',
        message: '删除测试任务失败',
      })
      expect(response.body).not.toContain('/private/data/file')
    } finally {
      await isolatedApp.close()
    }
  })
})
