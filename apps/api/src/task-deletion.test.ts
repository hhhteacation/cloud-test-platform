import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PlatformDatabase } from './database.js'
import { TaskDeletionError, TaskDeletionService } from './task-deletion.js'
import type { ArtifactKind, ArtifactRecord } from './types.js'

async function pathExists(candidate: string) {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

describe('TaskDeletionService', () => {
  let rootDir: string
  let artifactsDir: string
  let tasksDir: string
  let trashDir: string
  let database: PlatformDatabase
  let service: TaskDeletionService

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'sdk-task-deletion-'))
    artifactsDir = path.join(rootDir, 'artifacts')
    tasksDir = path.join(rootDir, 'tasks')
    trashDir = path.join(rootDir, '.trash')
    await Promise.all([
      mkdir(artifactsDir, { recursive: true }),
      mkdir(tasksDir, { recursive: true }),
    ])
    database = new PlatformDatabase({
      databasePath: path.join(rootDir, 'cloud-test.sqlite'),
      deviceSerial: 'test-device',
      markInterruptedTasks: false,
    })
    service = new TaskDeletionService(database, { artifactsDir, tasksDir, trashDir })
  })

  afterEach(async () => {
    database.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  async function createArtifact(kind: ArtifactKind, label: string, overridePath?: string) {
    const directory = overridePath ? path.dirname(overridePath) : path.join(artifactsDir, `store-${label}`)
    const storagePath = overridePath ?? path.join(directory, kind === 'apk' ? 'test.apk' : 'input.mp4')
    await mkdir(directory, { recursive: true })
    await writeFile(storagePath, `${kind}-${label}`)
    const artifact = database.insertArtifact({
      kind,
      originalName: kind === 'apk' ? `${label}.apk` : `${label}.mp4`,
      mimeType: kind === 'apk' ? 'application/vnd.android.package-archive' : 'video/mp4',
      storagePath,
      sizeBytes: Buffer.byteLength(`${kind}-${label}`),
      sha256: `sha-${label}`,
      packageName: kind === 'apk' ? 'com.morphoinc.videopostprocessor' : undefined,
    })
    return { artifact, directory, storagePath }
  }

  function createTask(apk: ArtifactRecord, video: ArtifactRecord) {
    return database.createTask({
      name: `任务-${video.originalName}`,
      apkArtifactId: apk.id,
      videoArtifactId: video.id,
      deviceIds: ['honor-magic-v3'],
      timeoutSeconds: 300,
    })
  }

  function finishTask(taskId: string, status: 'passed' | 'failed' | 'cancelled' = 'passed') {
    database.db.prepare('UPDATE tasks SET status = ?, progress = 100 WHERE id = ?').run(status, taskId)
    database.db.prepare("UPDATE device_runs SET status = 'passed', progress = 100 WHERE task_id = ?").run(taskId)
  }

  it('只删除目标任务及其孤立素材，保留其他任务、设备和共享素材', async () => {
    const sharedApk = await createArtifact('apk', 'shared-apk')
    const videoA = await createArtifact('video', 'video-a')
    const videoB = await createArtifact('video', 'video-b')
    const taskA = createTask(sharedApk.artifact, videoA.artifact)
    const taskB = createTask(sharedApk.artifact, videoB.artifact)
    finishTask(taskA.id)
    finishTask(taskB.id, 'failed')

    const runA = database.getRunForTask(taskA.id)!
    const taskADirectory = path.join(tasksDir, taskA.id)
    const taskBDirectory = path.join(tasksDir, taskB.id)
    await mkdir(taskBDirectory, { recursive: true })
    await writeFile(path.join(taskBDirectory, 'must-remain.txt'), 'task-b')
    const outputPath = path.join(taskADirectory, 'device-runs', runA.id, 'output.mp4')
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, 'processed-video')
    database.upsertCheck(runA.id, { key: 'output', name: '输出视频', status: 'passed' })
    database.addLog(taskA.id, runA.id, '处理完成')
    database.addOutput({ taskId: taskA.id, runId: runA.id, storagePath: outputPath, sizeBytes: 15, sha256: 'output-sha' })

    const taskBRunCountBefore = Number((database.db.prepare(
      'SELECT COUNT(*) AS count FROM device_runs WHERE task_id = ?',
    ).get(taskB.id) as { count: number }).count)
    const deviceCountBefore = Number((database.db.prepare(
      'SELECT COUNT(*) AS count FROM devices',
    ).get() as { count: number }).count)

    const receipt = await service.deleteTask(taskA.id)

    expect(receipt.deletedRecordCounts).toEqual({
      tasks: 1,
      deviceRuns: 1,
      checkResults: 1,
      logs: 1,
      outputs: 1,
    })
    expect(receipt.deletedArtifactIds).toEqual([videoA.artifact.id])
    expect(receipt.retainedArtifactIds).toEqual([sharedApk.artifact.id])
    expect(database.getTask(taskA.id)).toBeUndefined()
    expect(database.getTask(taskB.id)?.id).toBe(taskB.id)
    expect(database.getArtifact(sharedApk.artifact.id)?.id).toBe(sharedApk.artifact.id)
    expect(database.getArtifact(videoA.artifact.id)).toBeUndefined()
    expect(database.getArtifact(videoB.artifact.id)?.id).toBe(videoB.artifact.id)
    expect(await pathExists(taskADirectory)).toBe(false)
    expect(await pathExists(path.join(taskBDirectory, 'must-remain.txt'))).toBe(true)
    expect(await pathExists(videoA.directory)).toBe(false)
    expect(await pathExists(videoB.directory)).toBe(true)
    expect(await pathExists(sharedApk.directory)).toBe(true)

    const taskBRunCountAfter = Number((database.db.prepare(
      'SELECT COUNT(*) AS count FROM device_runs WHERE task_id = ?',
    ).get(taskB.id) as { count: number }).count)
    const deviceCountAfter = Number((database.db.prepare(
      'SELECT COUNT(*) AS count FROM devices',
    ).get() as { count: number }).count)
    expect(taskBRunCountAfter).toBe(taskBRunCountBefore)
    expect(deviceCountAfter).toBe(deviceCountBefore)
    expect(database.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])

    const audit = database.db.prepare(
      'SELECT * FROM task_deletion_audits WHERE task_id = ?',
    ).get(taskA.id) as Record<string, unknown> | undefined
    expect(audit?.deleted_by).toBe('local-user')
    expect(JSON.parse(String(audit?.deleted_artifact_ids))).toEqual([videoA.artifact.id])
  })

  it('删除多视频任务时清理全部孤立视频，并保留被其他任务引用的视频', async () => {
    const apk = await createArtifact('apk', 'multi-apk')
    const first = await createArtifact('video', 'multi-first')
    const shared = await createArtifact('video', 'multi-shared')
    const other = await createArtifact('video', 'other-only')
    const multiTask = database.createTask({
      name: '多视频任务', apkArtifactId: apk.artifact.id,
      videoArtifactIds: [first.artifact.id, shared.artifact.id],
      deviceIds: ['honor-magic-v3'], timeoutSeconds: 300,
    })
    const otherTask = database.createTask({
      name: '共享视频任务', apkArtifactId: apk.artifact.id,
      videoArtifactIds: [shared.artifact.id, other.artifact.id],
      deviceIds: ['honor-magic-v3'], timeoutSeconds: 300,
    })
    finishTask(multiTask.id)
    finishTask(otherTask.id)

    const receipt = await service.deleteTask(multiTask.id)

    expect(receipt.deletedArtifactIds).toEqual([first.artifact.id])
    expect(receipt.retainedArtifactIds).toEqual(expect.arrayContaining([apk.artifact.id, shared.artifact.id]))
    expect(database.getArtifact(first.artifact.id)).toBeUndefined()
    expect(database.getArtifact(shared.artifact.id)).toBeDefined()
    expect(database.getArtifact(other.artifact.id)).toBeDefined()
    expect(database.getTask(otherTask.id)?.videos.map((video) => video.artifactId)).toEqual([
      shared.artifact.id, other.artifact.id,
    ])
    expect(await pathExists(first.directory)).toBe(false)
    expect(await pathExists(shared.directory)).toBe(true)
  })

  it('拒绝删除排队中任务，并且不改变数据库和文件', async () => {
    const apk = await createArtifact('apk', 'queued-apk')
    const video = await createArtifact('video', 'queued-video')
    const task = createTask(apk.artifact, video.artifact)
    const taskDirectory = path.join(tasksDir, task.id)
    await mkdir(taskDirectory, { recursive: true })
    await writeFile(path.join(taskDirectory, 'keep.txt'), 'keep')

    await expect(service.deleteTask(task.id)).rejects.toMatchObject<TaskDeletionError>({
      code: 'TASK_NOT_DELETABLE',
      statusCode: 409,
    })

    expect(database.getTask(task.id)?.status).toBe('queued')
    expect(await pathExists(taskDirectory)).toBe(true)
    expect(database.getArtifact(apk.artifact.id)).toBeDefined()
    expect(database.getArtifact(video.artifact.id)).toBeDefined()
  })

  it('素材路径不安全时宁可保留素材记录和文件', async () => {
    const apk = await createArtifact('apk', 'unsafe-apk')
    const outsideVideoPath = path.join(rootDir, 'outside-storage', 'input.mp4')
    const video = await createArtifact('video', 'unsafe-video', outsideVideoPath)
    const task = createTask(apk.artifact, video.artifact)
    finishTask(task.id, 'cancelled')

    const receipt = await service.deleteTask(task.id)

    expect(receipt.deletedArtifactIds).toEqual([apk.artifact.id])
    expect(receipt.retainedArtifactIds).toContain(video.artifact.id)
    expect(receipt.fileCleanupWarnings.join(' ')).toContain('安全校验')
    expect(database.getArtifact(video.artifact.id)?.id).toBe(video.artifact.id)
    expect(await pathExists(outsideVideoPath)).toBe(true)
  })


  it('数据库删除失败时回滚事务并恢复所有已暂存目录', async () => {
    const apk = await createArtifact('apk', 'rollback-apk')
    const video = await createArtifact('video', 'rollback-video')
    const task = createTask(apk.artifact, video.artifact)
    finishTask(task.id, 'failed')
    const taskDirectory = path.join(tasksDir, task.id)
    await mkdir(taskDirectory, { recursive: true })
    await writeFile(path.join(taskDirectory, 'result.json'), '{}')

    database.db.exec(`
      CREATE TRIGGER prevent_target_task_delete
      BEFORE DELETE ON tasks
      WHEN OLD.id = '${task.id}'
      BEGIN
        SELECT RAISE(ABORT, 'forced delete failure');
      END;
    `)

    await expect(service.deleteTask(task.id)).rejects.toMatchObject<TaskDeletionError>({
      code: 'TASK_DELETE_FAILED',
      statusCode: 500,
    })

    expect(database.getTask(task.id)?.status).toBe('failed')
    expect(database.getArtifact(apk.artifact.id)).toBeDefined()
    expect(database.getArtifact(video.artifact.id)).toBeDefined()
    expect(await pathExists(path.join(taskDirectory, 'result.json'))).toBe(true)
    expect(await pathExists(apk.directory)).toBe(true)
    expect(await pathExists(video.directory)).toBe(true)
    expect(database.db.prepare(
      'SELECT COUNT(*) AS count FROM task_deletion_audits WHERE task_id = ?',
    ).get(task.id)).toMatchObject({ count: 0 })
  })

  it('任务目录不存在时仍可安全删除数据库记录并返回清理警告', async () => {
    const apk = await createArtifact('apk', 'missing-task-dir-apk')
    const video = await createArtifact('video', 'missing-task-dir-video')
    const task = createTask(apk.artifact, video.artifact)
    finishTask(task.id, 'cancelled')

    const receipt = await service.deleteTask(task.id)

    expect(database.getTask(task.id)).toBeUndefined()
    expect(receipt.fileCleanupWarnings.join(' ')).toContain('任务目录')
    expect(receipt.fileCleanupWarnings.join(' ')).toContain('不存在')
  })

  it('拒绝非法任务 ID，并串行化并发删除请求', async () => {
    await expect(service.deleteTask('../cloud-test.sqlite')).rejects.toMatchObject<TaskDeletionError>({
      code: 'INVALID_TASK_ID',
      statusCode: 400,
    })

    const apk = await createArtifact('apk', 'concurrent-apk')
    const video = await createArtifact('video', 'concurrent-video')
    const task = createTask(apk.artifact, video.artifact)
    finishTask(task.id)

    const results = await Promise.allSettled([
      service.deleteTask(task.id),
      service.deleteTask(task.id),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'TASK_STATE_CHANGED', statusCode: 409 })
  })
})
