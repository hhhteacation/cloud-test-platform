import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type { VideoRunExecution } from '../contracts.js'
import { createExecutionFailure, serializeExecutionFailure, type ExecutionFailure } from '../../execution/execution-failures.js'
import type {
  DeviceRunPhase, ExecutionStatus, MediaIntegrityResult, RunStatus, VideoRunAttemptView,
} from '../../types.js'
import { asNumber, asString, now, type Row } from './shared.js'

export interface TaskVideoRecord {
  id: string
  taskId: string
  artifactId: string
  sequence: number
  displayName: string
  createdAt: string
}

export interface VideoRunResultRecord {
  id: string
  taskId: string
  taskVideoId: string
  deviceRunId: string
  deviceId: string
  status: RunStatus
  phase?: string
  progress: number
  failureCode?: string
  failureMessage?: string
  executionStatus?: string
  executionFailureCode?: string
  executionFailureJson?: string
  startedAt?: string
  finishedAt?: string
  mediaIntegrityStatus: string
  mediaIntegrityFailureCode?: string
  mediaMetadata?: string
}

/** Owns ordered TaskVideo membership, the video/device result matrix, and attempt history. */
export class VideoExecutionStore {
  private onResultStateChanged: (taskId: string, deviceRunId: string) => void = () => undefined

  constructor(private readonly db: DatabaseSync) {}

  setResultStateChangedHandler(handler: (taskId: string, deviceRunId: string) => void) {
    this.onResultStateChanged = handler
  }

  createMatrix(input: {
    taskId: string
    videos: Array<{ artifactId: string; displayName: string }>
    deviceRuns: Array<{ id: string; deviceId: string }>
    createdAt: string
  }) {
    const taskVideos = input.videos.map((video, sequence): TaskVideoRecord => ({
      id: `task-video-${randomUUID()}`,
      taskId: input.taskId,
      artifactId: video.artifactId,
      sequence,
      displayName: video.displayName,
      createdAt: input.createdAt,
    }))
    const insertVideo = this.db.prepare(`
      INSERT INTO task_videos (id, task_id, artifact_id, sequence, display_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const insertResult = this.db.prepare(`
      INSERT INTO video_run_results (
        id, task_id, task_video_id, device_run_id,
        status, progress, media_integrity_status
      ) VALUES (?, ?, ?, ?, 'queued', 0, 'not_checked')
    `)

    for (const video of taskVideos) {
      insertVideo.run(
        video.id, video.taskId, video.artifactId,
        video.sequence, video.displayName, video.createdAt,
      )
      for (const run of input.deviceRuns) {
        insertResult.run(`video-run-${randomUUID()}`, input.taskId, video.id, run.id)
      }
    }
    return taskVideos
  }

  listTaskVideos(taskId: string): TaskVideoRecord[] {
    return (this.db.prepare(`
      SELECT * FROM task_videos
      WHERE task_id = ?
      ORDER BY sequence
    `).all(taskId) as Row[]).map((row) => ({
      id: asString(row.id), taskId: asString(row.task_id), artifactId: asString(row.artifact_id),
      sequence: asNumber(row.sequence), displayName: asString(row.display_name), createdAt: asString(row.created_at),
    }))
  }

  listExecutionsForDeviceRun(taskId: string, deviceRunId: string): VideoRunExecution[] {
    return (this.db.prepare(`
      SELECT vrr.id AS video_run_result_id, tv.id AS task_video_id,
             tv.artifact_id, tv.sequence, tv.display_name,
             artifacts.storage_path AS video_path, artifacts.original_name AS video_original_name,
             vrr.status AS video_run_status
      FROM video_run_results vrr
      JOIN task_videos tv ON tv.id = vrr.task_video_id
      JOIN artifacts ON artifacts.id = tv.artifact_id
      WHERE vrr.task_id = ? AND vrr.device_run_id = ?
      ORDER BY tv.sequence
    `).all(taskId, deviceRunId) as Row[]).map((row) => ({
      videoRunResultId: asString(row.video_run_result_id),
      taskVideoId: asString(row.task_video_id),
      artifactId: asString(row.artifact_id),
      sequence: asNumber(row.sequence),
      displayName: asString(row.display_name) || asString(row.video_original_name) || 'input.mp4',
      videoPath: asString(row.video_path),
      videoOriginalName: asString(row.video_original_name) || 'input.mp4',
      runStatus: asString(row.video_run_status) as RunStatus,
    }))
  }

  getResult(videoRunResultId: string): VideoRunResultRecord | undefined {
    const row = this.db.prepare(`
      SELECT video_run_results.*, device_runs.device_id
      FROM video_run_results
      JOIN device_runs ON device_runs.id = video_run_results.device_run_id
      WHERE video_run_results.id = ?
    `).get(videoRunResultId) as Row | undefined
    return row ? this.mapResult(row) : undefined
  }

  listResults(taskId: string): VideoRunResultRecord[] {
    return (this.db.prepare(`
      SELECT video_run_results.*, device_runs.device_id
      FROM video_run_results
      JOIN task_videos ON task_videos.id = video_run_results.task_video_id
      JOIN device_runs ON device_runs.id = video_run_results.device_run_id
      WHERE video_run_results.task_id = ?
      ORDER BY task_videos.sequence, device_runs.rowid
    `).all(taskId) as Row[]).map((row) => this.mapResult(row))
  }

  listResultsForDeviceRun(deviceRunId: string): VideoRunResultRecord[] {
    return (this.db.prepare(`
      SELECT video_run_results.*, device_runs.device_id
      FROM video_run_results
      JOIN task_videos ON task_videos.id = video_run_results.task_video_id
      JOIN device_runs ON device_runs.id = video_run_results.device_run_id
      WHERE video_run_results.device_run_id = ?
      ORDER BY task_videos.sequence
    `).all(deviceRunId) as Row[]).map((row) => this.mapResult(row))
  }

  setState(input: {
    videoRunResultId: string
    attemptId?: string
    runStatus?: RunStatus
    phase?: DeviceRunPhase
    progress?: number
    failureCode?: string | null
    failureMessage?: string | null
    failure?: ExecutionFailure | null
    executionStatus?: ExecutionStatus
    executionFailureCode?: string | null
    started?: boolean
    finished?: boolean
  }) {
    const current = this.db.prepare('SELECT * FROM video_run_results WHERE id = ?')
      .get(input.videoRunResultId) as Row | undefined
    if (!current) throw new Error(`视频执行结果 ${input.videoRunResultId} 不存在`)
    const timestamp = now()
    const phase = input.phase ?? (asString(current.phase) || 'validating_device') as DeviceRunPhase
    const legacyFailureChanged = input.failureCode !== undefined || input.failureMessage !== undefined
    const legacyCode = input.failureCode === undefined ? asString(current.failure_code) || null : input.failureCode
    const legacyMessage = input.failureMessage === undefined ? asString(current.failure_message) || null : input.failureMessage
    const failure = input.failure !== undefined
      ? input.failure
      : legacyFailureChanged && legacyCode
        ? createExecutionFailure({ code: legacyCode, phase, message: legacyMessage || legacyCode })
        : legacyFailureChanged ? null : undefined
    const failureCode = failure === undefined ? legacyCode : failure?.code ?? null
    const failureMessage = failure === undefined ? legacyMessage : failure?.message ?? null
    const failureJson = failure === undefined
      ? asString(current.execution_failure_json) || null
      : serializeExecutionFailure(failure)

    const updated = this.db.prepare(`
      UPDATE video_run_results SET status = ?, phase = ?, progress = ?,
        failure_code = ?, failure_message = ?, execution_status = ?, execution_failure_code = ?,
        execution_failure_json = ?, started_at = ?, finished_at = ?
      WHERE id = ?
        AND (
          ? IS NULL
          OR EXISTS (
            SELECT 1
            FROM video_run_attempts AS attempt
            WHERE attempt.id = ?
              AND attempt.video_run_result_id = video_run_results.id
              AND attempt.status = 'running'
              AND attempt.attempt_number = (
                SELECT MAX(latest.attempt_number)
                FROM video_run_attempts AS latest
                WHERE latest.video_run_result_id = video_run_results.id
              )
              AND (
                COALESCE(attempt.connection_kind, '') <> 'network'
                OR EXISTS (
                  SELECT 1
                  FROM device_runs
                  JOIN device_connection_state
                    ON device_connection_state.device_id = device_runs.device_id
                  WHERE device_runs.id = video_run_results.device_run_id
                    AND device_connection_state.observed_network_state = 'online'
                    AND device_connection_state.active_endpoint_id = attempt.endpoint_id
                    AND device_connection_state.connection_generation = attempt.endpoint_generation
                )
              )
          )
        )
    `).run(
      input.runStatus ?? asString(current.status),
      phase,
      input.progress ?? asNumber(current.progress),
      failureCode,
      failureMessage,
      input.executionStatus ?? (asString(current.execution_status) || 'pending'),
      input.executionFailureCode === undefined
        ? asString(current.execution_failure_code) || null
        : input.executionFailureCode,
      failureJson,
      input.started ? timestamp : asString(current.started_at) || null,
      input.finished ? timestamp : asString(current.finished_at) || null,
      input.videoRunResultId,
      input.attemptId ?? null,
      input.attemptId ?? null,
    )
    if (updated.changes > 0) {
      this.onResultStateChanged(asString(current.task_id), asString(current.device_run_id))
    }
    return updated.changes === 1
  }

  blockRemaining(input: {
    taskId: string
    deviceRunId: string
    afterSequence: number
    failure: ExecutionFailure
  }) {
    const timestamp = now()
    const result = this.db.prepare(`
      UPDATE video_run_results
      SET status = 'blocked', progress = 100,
          failure_code = ?, failure_message = ?, execution_status = 'failed',
          execution_failure_code = ?, execution_failure_json = ?, finished_at = ?
      WHERE task_id = ? AND device_run_id = ? AND status = 'queued'
        AND task_video_id IN (
          SELECT id FROM task_videos WHERE task_id = ? AND sequence > ?
        )
    `).run(
      input.failure.code, input.failure.message, input.failure.code,
      serializeExecutionFailure(input.failure), timestamp,
      input.taskId, input.deviceRunId, input.taskId, input.afterSequence,
    )
    if (result.changes > 0) this.onResultStateChanged(input.taskId, input.deviceRunId)
    return result.changes
  }

  cancelForTask(taskId: string, timestamp: string) {
    const failure = createExecutionFailure({
      code: 'TASK_CANCELLED', phase: 'validating_device', message: '用户取消任务',
    })
    this.db.prepare(`
      UPDATE video_run_attempts
      SET status = 'blocked', failure_code = ?, failure_message = ?,
          execution_failure_json = ?, finished_at = ?
      WHERE status = 'running' AND video_run_result_id IN (
        SELECT id FROM video_run_results WHERE task_id = ?
      )
    `).run(failure.code, failure.message, serializeExecutionFailure(failure), timestamp, taskId)
    this.db.prepare(`
      UPDATE video_run_results
      SET status = 'blocked', progress = 100,
          failure_code = ?, failure_message = ?, execution_status = 'cancelled',
          execution_failure_code = ?, execution_failure_json = ?, finished_at = ?
      WHERE task_id = ? AND status IN ('queued', 'running')
    `).run(
      failure.code, failure.message, failure.code, serializeExecutionFailure(failure), timestamp, taskId,
    )
  }

  createAttempt(videoRunResultId: string, input: {
    status?: RunStatus
    failureCode?: string
    failureMessage?: string
    executionFailureJson?: string
    evidenceDirectory?: string
    startedAt?: string
    finishedAt?: string
  } = {}): VideoRunAttemptView {
    if (!this.getResult(videoRunResultId)) throw new Error(`视频执行结果 ${videoRunResultId} 不存在`)
    const connection = this.db.prepare(`
      SELECT device_runs.endpoint_id, device_runs.connection_kind, device_runs.adb_serial,
             device_endpoints.transport_type,
             COALESCE(device_connection_state.connection_generation, 0) AS endpoint_generation
      FROM video_run_results
      JOIN device_runs ON device_runs.id = video_run_results.device_run_id
      LEFT JOIN device_endpoints ON device_endpoints.id = device_runs.endpoint_id
      LEFT JOIN device_connection_state ON device_connection_state.device_id = device_runs.device_id
      WHERE video_run_results.id = ?
    `).get(videoRunResultId) as Row
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
      FROM video_run_attempts
      WHERE video_run_result_id = ?
    `).get(videoRunResultId) as Row
    const attemptNumber = asNumber(row.attempt_number)
    const id = `video-attempt-${randomUUID()}`
    const createdAt = now()
    this.db.prepare(`
      INSERT INTO video_run_attempts (
        id, video_run_result_id, attempt_number, status,
        failure_code, failure_message, execution_failure_json,
        evidence_directory, endpoint_id, connection_kind, network_transport,
        adb_serial, endpoint_generation, started_at, finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, videoRunResultId, attemptNumber, input.status ?? 'running',
      input.failureCode ?? null, input.failureMessage ?? null, input.executionFailureJson ?? null,
      input.evidenceDirectory ?? null,
      asString(connection.endpoint_id) || null,
      asString(connection.connection_kind) || null,
      asString(connection.connection_kind) === 'network'
        ? (asString(connection.transport_type) || 'tcp_legacy')
        : null,
      asString(connection.adb_serial) || null,
      asNumber(connection.endpoint_generation),
      input.startedAt ?? createdAt, input.finishedAt ?? null, createdAt,
    )
    return this.listAttempts(videoRunResultId).find((attempt) => attempt.id === id)!
  }

  finishAttempt(attemptId: string, input: {
    status: Extract<RunStatus, 'passed' | 'failed' | 'blocked'>
    failure?: ExecutionFailure | null
    finishedAt?: string
  }) {
    const result = this.db.prepare(`
      UPDATE video_run_attempts
      SET status = ?, failure_code = ?, failure_message = ?, execution_failure_json = ?, finished_at = ?
      WHERE id = ? AND status = 'running'
        AND attempt_number = (
          SELECT MAX(latest.attempt_number)
          FROM video_run_attempts AS latest
          WHERE latest.video_run_result_id = video_run_attempts.video_run_result_id
        )
        AND (
          COALESCE(connection_kind, '') <> 'network'
          OR EXISTS (
            SELECT 1
            FROM video_run_results
            JOIN device_runs ON device_runs.id = video_run_results.device_run_id
            JOIN device_connection_state ON device_connection_state.device_id = device_runs.device_id
            WHERE video_run_results.id = video_run_attempts.video_run_result_id
              AND device_connection_state.observed_network_state = 'online'
              AND device_connection_state.active_endpoint_id = video_run_attempts.endpoint_id
              AND device_connection_state.connection_generation = video_run_attempts.endpoint_generation
          )
        )
    `).run(
      input.status,
      input.failure?.code ?? null,
      input.failure?.message ?? null,
      serializeExecutionFailure(input.failure),
      input.finishedAt ?? now(),
      attemptId,
    )
    if (result.changes === 1) return true

    const staleFailure = createExecutionFailure({
      code: 'STALE_DEVICE_LEASE',
      phase: 'validating_device',
      message: 'Attempt 的设备 Lease 或联网 Endpoint generation 已过期，已拒绝迟到终态',
    })
    this.db.prepare(`
      UPDATE video_run_attempts
      SET status = 'blocked', failure_code = ?, failure_message = ?,
          execution_failure_json = ?, finished_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      staleFailure.code,
      staleFailure.message,
      serializeExecutionFailure(staleFailure),
      input.finishedAt ?? now(),
      attemptId,
    )
    return false
  }

  recordMediaIntegrity(videoRunResultId: string, result: MediaIntegrityResult, attemptId?: string) {
    const current = this.getResult(videoRunResultId)
    if (!current) throw new Error(`视频执行结果 ${videoRunResultId} 不存在`)
    const updated = this.db.prepare(`
      UPDATE video_run_results
      SET media_integrity_status = ?, media_integrity_failure_code = ?, media_metadata = ?
      WHERE id = ?
        AND (
          ? IS NULL
          OR EXISTS (
            SELECT 1
            FROM video_run_attempts AS attempt
            WHERE attempt.id = ?
              AND attempt.video_run_result_id = video_run_results.id
              AND attempt.status = 'running'
              AND attempt.attempt_number = (
                SELECT MAX(latest.attempt_number)
                FROM video_run_attempts AS latest
                WHERE latest.video_run_result_id = video_run_results.id
              )
              AND (
                COALESCE(attempt.connection_kind, '') <> 'network'
                OR EXISTS (
                  SELECT 1
                  FROM device_runs
                  JOIN device_connection_state
                    ON device_connection_state.device_id = device_runs.device_id
                  WHERE device_runs.id = video_run_results.device_run_id
                    AND device_connection_state.observed_network_state = 'online'
                    AND device_connection_state.active_endpoint_id = attempt.endpoint_id
                    AND device_connection_state.connection_generation = attempt.endpoint_generation
                )
              )
          )
        )
    `).run(
      result.status,
      result.failureCode ?? null,
      result.metadata ? JSON.stringify(result.metadata) : null,
      videoRunResultId,
      attemptId ?? null,
      attemptId ?? null,
    )
    if (updated.changes > 0) this.onResultStateChanged(current.taskId, current.deviceRunId)
    return updated.changes === 1
  }

  listAttempts(videoRunResultId: string): VideoRunAttemptView[] {
    return (this.db.prepare(`
      SELECT * FROM video_run_attempts
      WHERE video_run_result_id = ?
      ORDER BY attempt_number
    `).all(videoRunResultId) as Row[]).map((row) => ({
      id: asString(row.id),
      videoRunResultId: asString(row.video_run_result_id),
      attemptNumber: asNumber(row.attempt_number),
      status: asString(row.status) as RunStatus,
      failureCode: asString(row.failure_code) || undefined,
      failureMessage: asString(row.failure_message) || undefined,
      endpointId: asString(row.endpoint_id) || undefined,
      connectionKind: (asString(row.connection_kind) || undefined) as VideoRunAttemptView['connectionKind'],
      networkTransport: (asString(row.network_transport) || undefined) as VideoRunAttemptView['networkTransport'],
      adbSerial: asString(row.adb_serial) || undefined,
      endpointGeneration: asNumber(row.endpoint_generation),
      startedAt: asString(row.started_at) || undefined,
      finishedAt: asString(row.finished_at) || undefined,
      createdAt: asString(row.created_at),
    }))
  }

  private mapResult(row: Row): VideoRunResultRecord {
    return {
      id: asString(row.id), taskId: asString(row.task_id), taskVideoId: asString(row.task_video_id),
      deviceRunId: asString(row.device_run_id), deviceId: asString(row.device_id),
      status: asString(row.status) as RunStatus,
      phase: asString(row.phase) || undefined, progress: asNumber(row.progress),
      failureCode: asString(row.failure_code) || undefined,
      failureMessage: asString(row.failure_message) || undefined,
      executionStatus: asString(row.execution_status) || undefined,
      executionFailureCode: asString(row.execution_failure_code) || undefined,
      executionFailureJson: asString(row.execution_failure_json) || undefined,
      startedAt: asString(row.started_at) || undefined,
      finishedAt: asString(row.finished_at) || undefined,
      mediaIntegrityStatus: asString(row.media_integrity_status) || 'not_checked',
      mediaIntegrityFailureCode: asString(row.media_integrity_failure_code) || undefined,
      mediaMetadata: asString(row.media_metadata) || undefined,
    }
  }
}
