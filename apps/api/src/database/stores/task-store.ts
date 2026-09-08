import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { findApkExecutionProtocol, toPublicApkProtocol } from '../../apk-protocols.js'
import { getTaskCapabilities } from '../../task-capabilities.js'
import { deserializeExecutionFailure, mapExecutionFailureEvidence } from '../../execution/execution-failures.js'
import type {
  ArtifactRecord, DevicePlatform, DeviceRunPhase, DeviceRunView, RunStatus, TaskStatus,
  TestReportView, TestTaskView, TaskConnectionMode, TaskVideoView, VideoRunResultView,
} from '../../types.js'
import type { ArtifactStore } from './artifact-store.js'
import type { AuditStore } from './audit-store.js'
import type { DeviceRunStore } from './device-run-store.js'
import { asNumber, asString, now, type Row } from './shared.js'
import { VideoExecutionStore } from './video-execution-store.js'

export interface TaskVideoLimits {
  maxVideosPerTask: number
  maxVideoBytes: number
  maxTotalVideoBytes: number
}

export const DEFAULT_TASK_VIDEO_LIMITS: TaskVideoLimits = {
  maxVideosPerTask: 10,
  maxVideoBytes: 4 * 1024 * 1024 * 1024,
  maxTotalVideoBytes: 10 * 1024 * 1024 * 1024,
}

export type TaskStoreErrorCode =
  | 'APK_REQUIRED'
  | 'VIDEO_REQUIRED'
  | 'VIDEO_LIMIT_EXCEEDED'
  | 'VIDEO_NOT_FOUND'
  | 'INVALID_VIDEO_ARTIFACT'
  | 'DUPLICATE_VIDEO_ID'
  | 'DUPLICATE_VIDEO_CONTENT'
  | 'VIDEO_TOO_LARGE'
  | 'TASK_VIDEO_BYTES_EXCEEDED'
  | 'DEVICE_CONNECTION_BUSY'

export class TaskStoreError extends Error {
  constructor(readonly code: TaskStoreErrorCode, message: string) {
    super(message)
    this.name = 'TaskStoreError'
  }
}

/** Owns task aggregate creation, views, cancellation and aggregate status. */
export class TaskStore {
  private readonly limits: TaskVideoLimits

  constructor(
    private readonly db: DatabaseSync,
    private readonly artifacts: ArtifactStore,
    private readonly runs: DeviceRunStore,
    private readonly audit: AuditStore,
    private readonly videoExecutions = new VideoExecutionStore(db),
    limits: Partial<TaskVideoLimits> = {},
  ) {
    this.limits = { ...DEFAULT_TASK_VIDEO_LIMITS, ...limits }
  }

  create(input: {
    name: string
    platform?: 'android'
    apkArtifactId: string
    videoArtifactId?: string
    videoArtifactIds?: readonly string[]
    deviceIds: string[]
    timeoutSeconds: number
    connectionMode?: TaskConnectionMode
  }) {
    const apk = this.artifacts.get(input.apkArtifactId)
    if (!apk || apk.kind !== 'apk') throw new TaskStoreError('APK_REQUIRED', '请选择有效的 APK Artifact')
    const videos = this.resolveVideos(input)

    const taskId = `task-${randomUUID()}`
    const createdAt = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const placeholders = input.deviceIds.map(() => '?').join(', ')
      const busyConnection = input.deviceIds.length > 0
        ? this.db.prepare(`
            SELECT device_id
            FROM device_connection_state
            WHERE device_id IN (${placeholders})
              AND observed_network_state IN ('discovered', 'connecting', 'verifying', 'recovering')
            LIMIT 1
          `).get(...input.deviceIds) as Row | undefined
        : undefined
      if (busyConnection) {
        throw new TaskStoreError(
          'DEVICE_CONNECTION_BUSY',
          `设备 ${asString(busyConnection.device_id)} 正在执行连接操作，请等待连接状态稳定后再创建任务`,
        )
      }
      this.db.prepare(`
        INSERT INTO tasks (
          id, platform, name, apk_artifact_id, video_artifact_id, status,
          progress, timeout_seconds, connection_mode, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
      `).run(
        taskId, input.platform ?? 'android', input.name, apk.id,
        videos[0].id, input.timeoutSeconds, input.connectionMode ?? 'auto', createdAt, createdAt,
      )
      const deviceRuns = input.deviceIds.map((deviceId) => ({ id: `run-${randomUUID()}`, deviceId }))
      const insertRun = this.db.prepare(`
        INSERT INTO device_runs (id, task_id, device_id, status, progress)
        VALUES (?, ?, ?, 'queued', 0)
      `)
      for (const run of deviceRuns) insertRun.run(run.id, taskId, run.deviceId)
      this.videoExecutions.createMatrix({
        taskId,
        videos: videos.map((video) => ({ artifactId: video.id, displayName: video.originalName })),
        deviceRuns,
        createdAt,
      })
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
    if (!apk) return undefined

    const videos: TaskVideoView[] = []
    for (const taskVideo of this.videoExecutions.listTaskVideos(taskId)) {
      const artifact = this.artifacts.get(taskVideo.artifactId)
      if (!artifact || artifact.kind !== 'video') return undefined
      videos.push({
        id: taskVideo.id,
        taskId: taskVideo.taskId,
        artifactId: taskVideo.artifactId,
        sequence: taskVideo.sequence,
        displayName: taskVideo.displayName,
        asset: this.artifactView(artifact),
      })
    }
    if (!videos.length) return undefined

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
        failure: this.failureView({
          taskId, runId,
          serialized: asString(row.execution_failure_json) || undefined,
          legacyCode: asString(row.failure_code) || undefined,
          legacyMessage: asString(row.failure_message) || undefined,
          phase: (asString(row.phase) || 'validating_device') as DeviceRunPhase,
        }),
        executionStatus: (asString(row.execution_status) || 'pending') as DeviceRunView['executionStatus'],
        executionFailureCode: asString(row.execution_failure_code) || undefined,
        mediaIntegrityStatus: (asString(row.media_integrity_status) || 'not_checked') as DeviceRunView['mediaIntegrityStatus'],
        mediaIntegrityFailureCode: asString(row.media_integrity_failure_code) || undefined,
        mediaMetadata,
        logcatUrl: `/api/tasks/${taskId}/device-runs/${runId}/logcat`,
        screenshotUrl: `/api/tasks/${taskId}/device-runs/${runId}/screenshots/final`,
      }
    }

    const videoRuns: Record<string, Record<string, VideoRunResultView>> = Object.fromEntries(
      videos.map((video) => [video.id, {}]),
    )
    for (const result of this.videoExecutions.listResults(taskId)) {
      let mediaMetadata: VideoRunResultView['mediaMetadata']
      try { mediaMetadata = result.mediaMetadata ? JSON.parse(result.mediaMetadata) : undefined } catch { mediaMetadata = undefined }
      const outputs = this.artifacts.listOutputsForVideoResult(result.id)
      const view: VideoRunResultView = {
        id: result.id,
        taskId: result.taskId,
        taskVideoId: result.taskVideoId,
        deviceRunId: result.deviceRunId,
        deviceId: result.deviceId,
        status: result.status,
        phase: result.phase as DeviceRunPhase | undefined,
        progress: result.progress,
        checks: this.audit.listChecksForVideoResult(result.id),
        logs: this.audit.listMessagesForVideoResult(result.id),
        outputs,
        primaryOutput: outputs[0],
        attempts: this.videoExecutions.listAttempts(result.id),
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        failureCode: result.failureCode,
        failureMessage: result.failureMessage,
        failure: this.failureView({
          taskId, runId: result.deviceRunId,
          serialized: result.executionFailureJson,
          legacyCode: result.failureCode,
          legacyMessage: result.failureMessage,
          phase: (result.phase || 'transferring_input') as DeviceRunPhase,
        }),
        executionStatus: (result.executionStatus || 'pending') as VideoRunResultView['executionStatus'],
        executionFailureCode: result.executionFailureCode,
        mediaIntegrityStatus: result.mediaIntegrityStatus as VideoRunResultView['mediaIntegrityStatus'],
        mediaIntegrityFailureCode: result.mediaIntegrityFailureCode,
        mediaMetadata,
      }
      videoRuns[result.taskVideoId] ??= {}
      videoRuns[result.taskVideoId][result.deviceId] = view
    }

    return {
      id: asString(task.id), platform: (asString(task.platform) || 'android') as DevicePlatform,
      name: asString(task.name), apk: this.artifactView(apk), asset: videos[0].asset,
      videos, videoRuns,
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
    this.videoExecutions.cancelForTask(taskId, timestamp)
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

  private resolveVideos(input: { videoArtifactId?: string; videoArtifactIds?: readonly string[] }) {
    const ids = input.videoArtifactIds?.length
      ? [...input.videoArtifactIds]
      : input.videoArtifactId ? [input.videoArtifactId] : []
    if (!ids.length) throw new TaskStoreError('VIDEO_REQUIRED', '请至少选择一个视频 Artifact')
    if (ids.length > this.limits.maxVideosPerTask) {
      throw new TaskStoreError('VIDEO_LIMIT_EXCEEDED', `单任务最多允许 ${this.limits.maxVideosPerTask} 个视频`)
    }
    if (new Set(ids).size !== ids.length) {
      throw new TaskStoreError('DUPLICATE_VIDEO_ID', '同一任务不能重复加入相同的视频 Artifact')
    }

    const videos = ids.map((id) => {
      const artifact = this.artifacts.get(id)
      if (!artifact) throw new TaskStoreError('VIDEO_NOT_FOUND', `视频 Artifact ${id} 不存在`)
      if (artifact.kind !== 'video') throw new TaskStoreError('INVALID_VIDEO_ARTIFACT', `Artifact ${id} 不是视频`)
      if (artifact.sizeBytes > this.limits.maxVideoBytes) {
        throw new TaskStoreError('VIDEO_TOO_LARGE', `视频 ${artifact.originalName} 超过单视频大小上限`)
      }
      return artifact
    })
    const hashes = videos.map((video) => video.sha256)
    if (new Set(hashes).size !== hashes.length) {
      throw new TaskStoreError('DUPLICATE_VIDEO_CONTENT', '同一任务不能加入 SHA-256 相同的视频内容')
    }
    if (videos.reduce((total, video) => total + video.sizeBytes, 0) > this.limits.maxTotalVideoBytes) {
      throw new TaskStoreError('TASK_VIDEO_BYTES_EXCEEDED', '任务输入视频总大小超过上限')
    }
    return videos
  }

  private failureView(input: {
    taskId: string
    runId: string
    serialized?: string
    legacyCode?: string
    legacyMessage?: string
    phase: DeviceRunPhase
  }) {
    return mapExecutionFailureEvidence(deserializeExecutionFailure({
      serialized: input.serialized,
      legacyCode: input.legacyCode,
      legacyMessage: input.legacyMessage,
      phase: input.phase,
    }), (ref) => this.evidenceUrl(input.taskId, input.runId, ref))
  }

  private evidenceUrl(taskId: string, runId: string, ref: string) {
    if (ref.startsWith('/')) return ref
    const encodedRef = ref.split('/').map((part) => encodeURIComponent(part)).join('/')
    return `/api/tasks/${encodeURIComponent(taskId)}/device-runs/${encodeURIComponent(runId)}/evidence/${encodedRef}`
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
