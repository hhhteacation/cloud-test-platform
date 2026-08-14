import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type { RunStatus, VideoRunAttemptView } from '../../types.js'
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
  constructor(private readonly db: DatabaseSync) {}

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
        evidence_directory, started_at, finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, videoRunResultId, attemptNumber, input.status ?? 'running',
      input.failureCode ?? null, input.failureMessage ?? null, input.executionFailureJson ?? null,
      input.evidenceDirectory ?? null, input.startedAt ?? createdAt, input.finishedAt ?? null, createdAt,
    )
    return this.listAttempts(videoRunResultId).find((attempt) => attempt.id === id)!
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
