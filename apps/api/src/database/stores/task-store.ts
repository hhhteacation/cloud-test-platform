import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { findApkExecutionProtocol, toPublicApkProtocol } from '../../apk-protocols.js'
import { getTaskCapabilities } from '../../task-capabilities.js'
import type {
  ArtifactRecord, DevicePlatform, DeviceRunPhase, DeviceRunView, RunStatus, TaskStatus,
  TestReportView, TestTaskView,
} from '../../types.js'
import type { ArtifactStore } from './artifact-store.js'
import type { AuditStore } from './audit-store.js'
import type { DeviceRunStore } from './device-run-store.js'
import type { TaskConnectionMode } from '../../types.js'
import { asNumber, asString, now, type Row } from './shared.js'

/** Owns task aggregate creation, views, cancellation and aggregate status. */
export class TaskStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly artifacts: ArtifactStore,
    private readonly runs: DeviceRunStore,
    private readonly audit: AuditStore,
  ) {}

  create(input: {
    name: string
    platform?: 'android'
    apkArtifactId: string
    videoArtifactId: string
    deviceIds: string[]
    timeoutSeconds: number
    connectionMode?: TaskConnectionMode
  }) {
    const taskId = `task-${randomUUID()}`
    const createdAt = now()
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`
        INSERT INTO tasks (
          id, platform, name, apk_artifact_id, video_artifact_id, status,
          progress, timeout_seconds, connection_mode, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
      `).run(
        taskId, input.platform ?? 'android', input.name, input.apkArtifactId,
        input.videoArtifactId, input.timeoutSeconds, input.connectionMode ?? 'auto', createdAt, createdAt,
      )
      for (const deviceId of input.deviceIds) {
        this.db.prepare(`
          INSERT INTO device_runs (id, task_id, device_id, status, progress)
          VALUES (?, ?, ?, 'queued', 0)
        `).run(
          `run-${randomUUID()}`, taskId, deviceId,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.get(taskId)!
  }

  list() {
    const rows = this.db.prepare('SELECT id FROM tasks ORDER BY created_at DESC').all() as Row[]
    return rows.map((row) => this.get(asString(row.id))).filter(Boolean) as TestTaskView[]
  }

  get(taskId: string): TestTaskView | undefined {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined
    if (!task) return undefined
    const apk = this.artifacts.get(asString(task.apk_artifact_id))
    const video = this.artifacts.get(asString(task.video_artifact_id))
    if (!apk || !video) return undefined

    const runs: Record<string, DeviceRunView> = {}
    for (const row of this.runs.listRows(taskId)) {
      const runId = asString(row.id)
      const deviceId = asString(row.device_id)
      let mediaMetadata: DeviceRunView['mediaMetadata']
      try { mediaMetadata = asString(row.media_metadata) ? JSON.parse(asString(row.media_metadata)) : undefined } catch { mediaMetadata = undefined }
      runs[deviceId] = {
        id: runId, deviceId, status: asString(row.status) as RunStatus,
        phase: (asString(row.phase) || undefined) as DeviceRunPhase | undefined,
        progress: asNumber(row.progress),
        checks: this.audit.listChecks(runId), logs: this.audit.listMessages(runId),
        outputs: this.artifacts.listOutputsForRun(runId),
        startedAt: asString(row.started_at) || undefined,
        finishedAt: asString(row.finished_at) || undefined,
        mode: 'ADB 真机',
        connectionKind: (asString(row.connection_kind) || undefined) as DeviceRunView['connectionKind'],
        endpointId: asString(row.endpoint_id) || undefined,
        adbSerial: asString(row.adb_serial) || undefined,
        failureCode: asString(row.failure_code) || undefined,
        failureMessage: asString(row.failure_message) || undefined,
        executionStatus: (asString(row.execution_status) || 'pending') as DeviceRunView['executionStatus'],
        executionFailureCode: asString(row.execution_failure_code) || undefined,
        mediaIntegrityStatus: (asString(row.media_integrity_status) || 'not_checked') as DeviceRunView['mediaIntegrityStatus'],
        mediaIntegrityFailureCode: asString(row.media_integrity_failure_code) || undefined,
        mediaMetadata,
        logcatUrl: `/api/tasks/${taskId}/device-runs/${runId}/logcat`,
        screenshotUrl: `/api/tasks/${taskId}/device-runs/${runId}/screenshots/final`,
      }
    }

    return {
      id: asString(task.id), platform: (asString(task.platform) || 'android') as DevicePlatform,
      name: asString(task.name), apk: this.artifactView(apk), asset: this.artifactView(video),
      deviceIds: Object.keys(runs),
      connectionMode: (asString(task.connection_mode) || 'auto') as TestTaskView['connectionMode'],
      status: asString(task.status) as TaskStatus,
      progress: asNumber(task.progress), passRate: task.pass_rate == null ? undefined : asNumber(task.pass_rate),
      createdAt: asString(task.created_at), runs,
      capabilities: getTaskCapabilities(asString(task.status) as TaskStatus),
    }
  }

  report(taskId: string): TestReportView | undefined {
    const task = this.get(taskId)
    if (!task) return undefined
    const statuses = Object.values(task.runs).map((run) => run.status)
    const conclusion = task.status === 'cancelled' ? 'cancelled'
      : statuses.includes('failed') ? 'failed'
        : statuses.length > 0 && statuses.every((status) => status === 'passed') ? 'passed'
          : statuses.some((status) => status === 'blocked') && statuses.every((status) => status !== 'queued' && status !== 'running')
            ? 'blocked' : 'not_executed'
    return { ...task, conclusion, generatedAt: now() }
  }

  isCancelled(taskId: string) {
    const row = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as Row | undefined
    return asString(row?.status) === 'cancelled'
  }

  cancel(taskId: string) {
    const timestamp = now()
    this.db.prepare(`
      UPDATE tasks SET status = 'cancelled', failure_code = 'TASK_CANCELLED',
      failure_message = '用户取消任务', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(timestamp, taskId)
    this.runs.cancelForTask(taskId, timestamp)
  }

  recompute(taskId: string) {
    const task = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as Row | undefined
    if (!task || asString(task.status) === 'cancelled') return
    const rows = this.runs.listRows(taskId)
    if (!rows.length) return
    const statuses = rows.map((run) => asString(run.status) as RunStatus)
    const progress = Math.round(rows.reduce((sum, run) => sum + asNumber(run.progress), 0) / rows.length)
    const passed = statuses.filter((status) => status === 'passed').length
    const allQueued = statuses.every((status) => status === 'queued')
    const unfinished = statuses.some((status) => status === 'queued' || status === 'running')
    const status: TaskStatus = allQueued ? 'queued' : unfinished ? 'running' : statuses.every((item) => item === 'passed') ? 'passed' : 'failed'
    const failure = rows.find((run) => ['failed', 'blocked'].includes(asString(run.status)))
    this.db.prepare(`
      UPDATE tasks SET status = ?, progress = ?, pass_rate = ?,
        failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?
    `).run(
      status, progress, (passed / rows.length) * 100,
      failure ? asString(failure.failure_code) || null : null,
      failure ? asString(failure.failure_message) || null : null,
      now(), taskId,
    )
  }

  private artifactView(artifact: ArtifactRecord) {
    const protocol = artifact.kind === 'apk' ? findApkExecutionProtocol(artifact.packageName) : undefined
    return {
      id: artifact.id, kind: artifact.kind, name: artifact.originalName,
      sizeBytes: artifact.sizeBytes, mimeType: artifact.mimeType, sha256: artifact.sha256,
      packageName: artifact.packageName, protocol: protocol ? toPublicApkProtocol(protocol) : undefined,
      previewUrl: artifact.kind === 'video' ? `/api/artifacts/${artifact.id}/content` : undefined,
    }
  }
}
