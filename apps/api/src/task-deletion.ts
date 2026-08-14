import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { artifactsDir as defaultArtifactsDir, config, tasksDir as defaultTasksDir } from './config.js'
import type { PlatformDatabase } from './database.js'
import { isTaskDeletable } from './task-capabilities.js'
import type {
  ArtifactKind,
  DeletedRecordCounts,
  TaskDeletionReceipt,
  TaskStatus,
} from './types.js'

interface TaskRow {
  id: string
  name: string
  status: TaskStatus
  apk_artifact_id: string
  video_artifact_id: string
}

interface ArtifactRow {
  id: string
  kind: ArtifactKind
  storage_path: string
}

interface PlannedArtifact {
  record: ArtifactRow
  referencedByOtherTasks: boolean
}

interface TaskDeletionPlan {
  taskId: string
  taskName: string
  expectedStatus: Extract<TaskStatus, 'passed' | 'failed' | 'cancelled'>
  apkArtifactId: string
  videoArtifactId: string
  taskDirectory: string
  recordCounts: DeletedRecordCounts
  artifacts: PlannedArtifact[]
}

interface StagedPath {
  originalPath: string
  stagedPath: string
}

interface TaskDeletionServiceOptions {
  tasksDir?: string
  artifactsDir?: string
  trashDir?: string
  deletedBy?: string
}

export type TaskDeletionErrorCode =
  | 'INVALID_TASK_ID'
  | 'TASK_NOT_FOUND'
  | 'TASK_NOT_DELETABLE'
  | 'TASK_STATE_CHANGED'
  | 'TASK_DELETE_FAILED'

export class TaskDeletionError extends Error {
  constructor(
    readonly code: TaskDeletionErrorCode,
    message: string,
    readonly statusCode: 400 | 404 | 409 | 500,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TaskDeletionError'
  }
}

const TASK_ID_PATTERN = /^task-[a-zA-Z0-9-]+$/

function valueAsString(value: unknown) {
  return typeof value === 'string' ? value : String(value ?? '')
}

function countValue(row: Record<string, unknown> | undefined) {
  return Number(row?.count ?? 0)
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

export class TaskDeletionService {
  private readonly tasksDir: string
  private readonly artifactsDir: string
  private readonly trashDir: string
  private readonly deletedBy: string
  private deletionInProgress = false

  constructor(
    private readonly database: PlatformDatabase,
    options: TaskDeletionServiceOptions = {},
  ) {
    this.tasksDir = path.resolve(options.tasksDir ?? defaultTasksDir)
    this.artifactsDir = path.resolve(options.artifactsDir ?? defaultArtifactsDir)
    this.trashDir = path.resolve(options.trashDir ?? path.join(config.dataDir, '.trash'))
    this.deletedBy = options.deletedBy ?? 'local-user'
  }

  async deleteTask(taskId: string): Promise<TaskDeletionReceipt> {
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new TaskDeletionError('INVALID_TASK_ID', '测试任务 ID 格式不正确', 400)
    }
    if (this.deletionInProgress) {
      throw new TaskDeletionError('TASK_STATE_CHANGED', '另一个删除操作正在执行，请稍后重试', 409)
    }

    this.deletionInProgress = true
    try {
      return await this.deleteTaskOnce(taskId)
    } finally {
      this.deletionInProgress = false
    }
  }

  private async deleteTaskOnce(taskId: string): Promise<TaskDeletionReceipt> {
    const initialTask = this.readTask(taskId)
    if (!initialTask) {
      throw new TaskDeletionError('TASK_NOT_FOUND', '测试任务不存在', 404)
    }
    if (!isTaskDeletable(initialTask.status)) {
      throw new TaskDeletionError('TASK_NOT_DELETABLE', '任务正在排队或执行，请先取消任务', 409)
    }
    const initialPlan = this.createDeletionPlan(initialTask)

    const deletionId = `delete-${randomUUID()}`
    const operationTrashDir = path.join(this.trashDir, deletionId)
    const stagedPaths: StagedPath[] = []
    const warnings: string[] = []
    let transactionStarted = false
    let auditId = ''
    let receipt: TaskDeletionReceipt | undefined

    try {
      await mkdir(this.trashDir, { recursive: true })
      await mkdir(operationTrashDir, { recursive: false })
      this.database.db.exec('BEGIN IMMEDIATE')
      transactionStarted = true

      const currentTask = this.readTask(taskId)
      if (!currentTask) {
        throw new TaskDeletionError('TASK_STATE_CHANGED', '任务在删除前已发生变化', 409)
      }
      if (
        currentTask.status !== initialTask.status ||
        currentTask.apk_artifact_id !== initialTask.apk_artifact_id ||
        currentTask.video_artifact_id !== initialTask.video_artifact_id
      ) {
        throw new TaskDeletionError('TASK_STATE_CHANGED', '任务状态或素材引用已经变化，请刷新后重试', 409)
      }
      if (!isTaskDeletable(currentTask.status)) {
        throw new TaskDeletionError('TASK_NOT_DELETABLE', '任务正在排队或执行，请先取消任务', 409)
      }

      const plan = this.createDeletionPlan(currentTask)
      if (!this.deletionPlansMatch(initialPlan, plan)) {
        throw new TaskDeletionError('TASK_STATE_CHANGED', '任务附属记录或素材引用已经变化，请刷新后重试', 409)
      }

      const orphanArtifacts: ArtifactRow[] = []
      const retainedArtifactIds: string[] = []

      for (const plannedArtifact of plan.artifacts) {
        const artifact = plannedArtifact.record
        if (plannedArtifact.referencedByOtherTasks) {
          retainedArtifactIds.push(artifact.id)
          continue
        }

        if (!this.isSafeArtifactPath(artifact)) {
          retainedArtifactIds.push(artifact.id)
          warnings.push(`素材 ${artifact.id} 的存储路径未通过安全校验，已保留素材记录和文件`)
          continue
        }

        orphanArtifacts.push(artifact)
      }

      await this.stageDirectory(
        plan.taskDirectory,
        path.join(operationTrashDir, 'task'),
        stagedPaths,
        warnings,
        `任务目录 ${taskId} 不存在，无需清理`,
      )

      for (const artifact of orphanArtifacts) {
        await this.stageDirectory(
          path.dirname(path.resolve(artifact.storage_path)),
          path.join(operationTrashDir, 'artifacts', artifact.id),
          stagedPaths,
          warnings,
          `素材 ${artifact.id} 的磁盘目录不存在，仅删除孤立数据库记录`,
        )
      }

      const deleteTaskResult = this.database.db.prepare(`
        DELETE FROM tasks
        WHERE id = ? AND status IN ('passed', 'failed', 'cancelled')
      `).run(taskId)

      if (Number(deleteTaskResult.changes) !== 1) {
        throw new TaskDeletionError('TASK_STATE_CHANGED', '任务状态已经变化，删除操作已取消', 409)
      }

      const deletedArtifactIds: string[] = []
      for (const artifact of orphanArtifacts) {
        const result = this.database.db.prepare(`
          DELETE FROM artifacts
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM tasks
              WHERE apk_artifact_id = ? OR video_artifact_id = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM task_videos WHERE artifact_id = ?
            )
        `).run(artifact.id, artifact.id, artifact.id, artifact.id)

        if (Number(result.changes) !== 1) {
          throw new TaskDeletionError(
            'TASK_STATE_CHANGED',
            `素材 ${artifact.id} 的引用状态发生变化，删除操作已回滚`,
            409,
          )
        }
        deletedArtifactIds.push(artifact.id)
      }

      const deletedAt = new Date().toISOString()
      auditId = `deletion-audit-${randomUUID()}`
      receipt = {
        taskId,
        deletedAt,
        deletedRecordCounts: plan.recordCounts,
        deletedArtifactIds,
        retainedArtifactIds: Array.from(new Set(retainedArtifactIds)),
        fileCleanupWarnings: warnings,
      }

      this.database.db.prepare(`
        INSERT INTO task_deletion_audits (
          id, task_id, task_name, status_before_delete, deleted_by,
          deleted_record_counts, deleted_artifact_ids, retained_artifact_ids,
          file_cleanup_warnings, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        auditId,
        taskId,
        plan.taskName,
        currentTask.status,
        this.deletedBy,
        JSON.stringify(plan.recordCounts),
        JSON.stringify(receipt.deletedArtifactIds),
        JSON.stringify(receipt.retainedArtifactIds),
        JSON.stringify(warnings),
        deletedAt,
      )

      this.database.db.exec('COMMIT')
      transactionStarted = false
    } catch (error) {
      if (transactionStarted) {
        try {
          this.database.db.exec('ROLLBACK')
        } catch {
          // 保留原始异常；下面仍会尽力恢复文件。
        }
      }

      const restoreWarnings = await this.restoreStagedPaths(stagedPaths)
      try {
        await rm(operationTrashDir, { recursive: true, force: true })
      } catch {
        // 隔离目录无法清理时不覆盖更关键的数据库/文件恢复异常。
      }

      if (restoreWarnings.length > 0) {
        throw new TaskDeletionError(
          'TASK_DELETE_FAILED',
          `删除失败，部分暂存文件未能自动恢复：${restoreWarnings.join('；')}`,
          500,
          { cause: error },
        )
      }
      if (error instanceof TaskDeletionError) throw error
      throw new TaskDeletionError(
        'TASK_DELETE_FAILED',
        '删除任务失败，数据库和已暂存文件已回滚',
        500,
        { cause: error },
      )
    }

    if (!receipt) {
      throw new TaskDeletionError('TASK_DELETE_FAILED', '删除任务失败，未生成删除结果', 500)
    }

    try {
      await rm(operationTrashDir, { recursive: true, force: true })
    } catch (error) {
      receipt.fileCleanupWarnings.push(`隔离目录 ${deletionId} 暂时无法清理，可由后续清理任务重试`)
      if (!(error instanceof Error)) {
        receipt.fileCleanupWarnings.push('文件清理返回了未知错误')
      }
      if (auditId) {
        try {
          this.database.db.prepare(`
            UPDATE task_deletion_audits SET file_cleanup_warnings = ? WHERE id = ?
          `).run(JSON.stringify(receipt.fileCleanupWarnings), auditId)
        } catch {
          receipt.fileCleanupWarnings.push('删除已完成，但清理警告未能写回审计记录')
        }
      }
    }

    return receipt
  }


  private createDeletionPlan(task: TaskRow): TaskDeletionPlan {
    if (!isTaskDeletable(task.status)) {
      throw new TaskDeletionError('TASK_NOT_DELETABLE', '任务正在排队或执行，请先取消任务', 409)
    }

    return {
      taskId: task.id,
      taskName: task.name,
      expectedStatus: task.status,
      apkArtifactId: task.apk_artifact_id,
      videoArtifactId: task.video_artifact_id,
      taskDirectory: this.resolveTaskDirectory(task.id),
      recordCounts: this.readRecordCounts(task.id),
      artifacts: this.readTaskArtifacts(task).map((record) => ({
        record,
        referencedByOtherTasks: this.countOtherArtifactReferences(task.id, record.id) > 0,
      })),
    }
  }

  private deletionPlansMatch(left: TaskDeletionPlan, right: TaskDeletionPlan) {
    return left.taskId === right.taskId
      && left.taskName === right.taskName
      && left.expectedStatus === right.expectedStatus
      && left.apkArtifactId === right.apkArtifactId
      && left.videoArtifactId === right.videoArtifactId
      && left.taskDirectory === right.taskDirectory
      && JSON.stringify(left.recordCounts) === JSON.stringify(right.recordCounts)
      && JSON.stringify(left.artifacts) === JSON.stringify(right.artifacts)
  }

  private readTask(taskId: string): TaskRow | undefined {
    const row = this.database.db.prepare(`
      SELECT id, name, status, apk_artifact_id, video_artifact_id
      FROM tasks WHERE id = ?
    `).get(taskId) as Record<string, unknown> | undefined

    if (!row) return undefined
    return {
      id: valueAsString(row.id),
      name: valueAsString(row.name),
      status: valueAsString(row.status) as TaskStatus,
      apk_artifact_id: valueAsString(row.apk_artifact_id),
      video_artifact_id: valueAsString(row.video_artifact_id),
    }
  }

  private readRecordCounts(taskId: string): DeletedRecordCounts {
    const count = (sql: string) => countValue(
      this.database.db.prepare(sql).get(taskId) as Record<string, unknown> | undefined,
    )

    return {
      tasks: 1,
      deviceRuns: count('SELECT COUNT(*) AS count FROM device_runs WHERE task_id = ?'),
      checkResults: count(`
        SELECT COUNT(*) AS count
        FROM check_results c
        JOIN device_runs r ON r.id = c.device_run_id
        WHERE r.task_id = ?
      `),
      logs: count('SELECT COUNT(*) AS count FROM task_logs WHERE task_id = ?'),
      outputs: count('SELECT COUNT(*) AS count FROM task_outputs WHERE task_id = ?'),
    }
  }

  private readTaskArtifacts(task: TaskRow): ArtifactRow[] {
    const taskVideoRows = this.database.db.prepare(`
      SELECT artifact_id FROM task_videos
      WHERE task_id = ?
      ORDER BY sequence
    `).all(task.id) as Array<Record<string, unknown>>
    const videoArtifactIds = taskVideoRows.length > 0
      ? taskVideoRows.map((row) => valueAsString(row.artifact_id))
      : [task.video_artifact_id]
    const ids = Array.from(new Set([task.apk_artifact_id, ...videoArtifactIds]))
    const artifacts: ArtifactRow[] = []

    for (const id of ids) {
      const row = this.database.db.prepare(`
        SELECT id, kind, storage_path FROM artifacts WHERE id = ?
      `).get(id) as Record<string, unknown> | undefined
      if (!row) {
        throw new TaskDeletionError('TASK_STATE_CHANGED', `任务引用的素材 ${id} 不存在`, 409)
      }
      artifacts.push({
        id: valueAsString(row.id),
        kind: valueAsString(row.kind) as ArtifactKind,
        storage_path: valueAsString(row.storage_path),
      })
    }

    return artifacts
  }

  private countOtherArtifactReferences(taskId: string, artifactId: string) {
    const row = this.database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT id AS task_id
        FROM tasks
        WHERE id <> ? AND (apk_artifact_id = ? OR video_artifact_id = ?)
        UNION
        SELECT task_id
        FROM task_videos
        WHERE task_id <> ? AND artifact_id = ?
      )
    `).get(taskId, artifactId, artifactId, taskId, artifactId) as Record<string, unknown> | undefined
    return countValue(row)
  }

  private resolveTaskDirectory(taskId: string) {
    const candidate = path.resolve(this.tasksDir, taskId)
    if (path.dirname(candidate) !== this.tasksDir || !isPathInside(this.tasksDir, candidate)) {
      throw new TaskDeletionError('INVALID_TASK_ID', '任务目录未通过安全校验', 400)
    }
    return candidate
  }

  private isSafeArtifactPath(artifact: ArtifactRow) {
    const storagePath = path.resolve(artifact.storage_path)
    const directory = path.dirname(storagePath)
    const expectedName = artifact.kind === 'apk' ? 'test.apk' : 'input.mp4'
    const relativeDirectory = path.relative(this.artifactsDir, directory)

    return isPathInside(this.artifactsDir, storagePath)
      && path.basename(storagePath) === expectedName
      && relativeDirectory !== ''
      && !relativeDirectory.includes(path.sep)
      && path.basename(directory).startsWith('store-')
  }

  private async stageDirectory(
    source: string,
    target: string,
    stagedPaths: StagedPath[],
    warnings: string[],
    missingWarning: string,
  ) {
    try {
      await lstat(source)
    } catch (error) {
      if (isMissingFileError(error)) {
        warnings.push(missingWarning)
        return
      }
      throw error
    }

    await mkdir(path.dirname(target), { recursive: true })
    await rename(source, target)
    stagedPaths.push({ originalPath: source, stagedPath: target })
  }

  private async restoreStagedPaths(stagedPaths: StagedPath[]) {
    const warnings: string[] = []
    for (const entry of [...stagedPaths].reverse()) {
      try {
        await mkdir(path.dirname(entry.originalPath), { recursive: true })
        await rename(entry.stagedPath, entry.originalPath)
      } catch (error) {
        warnings.push(`${entry.originalPath}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return warnings
  }
}
