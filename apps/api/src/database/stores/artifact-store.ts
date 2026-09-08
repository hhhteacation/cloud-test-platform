import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { mapArtifactRow, mapOutputRow } from '../mappers.js'
import type { ArtifactRecord, TestOutput } from '../../types.js'
import { asString, now, type Row } from './shared.js'

/** Owns Artifact and generated-output persistence. */
export class ArtifactStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: Omit<ArtifactRecord, 'id' | 'createdAt'>) {
    const artifact: ArtifactRecord = { ...input, id: `artifact-${randomUUID()}`, createdAt: now() }
    this.db.prepare(`
      INSERT INTO artifacts (
        id, kind, original_name, mime_type, storage_path,
        size_bytes, sha256, package_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id, artifact.kind, artifact.originalName, artifact.mimeType,
      artifact.storagePath, artifact.sizeBytes, artifact.sha256,
      artifact.packageName ?? null, artifact.createdAt,
    )
    return artifact
  }

  get(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined
    return row ? mapArtifactRow(row) : undefined
  }

  listStoragePaths() {
    return (this.db.prepare('SELECT storage_path FROM artifacts').all() as Row[]).map((row) => asString(row.storage_path))
  }

  /** Compatibility output writer for the legacy DeviceRun scope. */
  addOutput(input: { taskId: string; runId: string; storagePath: string; sizeBytes: number; sha256: string }) {
    const id = `output-${randomUUID()}`
    this.db.prepare(`
      INSERT INTO task_outputs (id, task_id, device_run_id, kind, name, mime_type, storage_path, size_bytes, sha256, created_at)
      VALUES (?, ?, ?, 'processed_video', 'output.mp4', 'video/mp4', ?, ?, ?, ?)
    `).run(id, input.taskId, input.runId, input.storagePath, input.sizeBytes, input.sha256, now())
    return this.getOutput(id)!
  }

  addVideoOutput(input: {
    videoRunResultId: string
    attemptId?: string
    storagePath: string
    sizeBytes: number
    sha256: string
  }) {
    const id = `output-${randomUUID()}`
    const inserted = this.db.prepare(`
      INSERT INTO task_outputs (
        id, task_id, device_run_id, video_run_result_id,
        kind, name, mime_type, storage_path, size_bytes, sha256, created_at
      )
      SELECT ?, task_id, device_run_id, id,
        'processed_video', 'output.mp4', 'video/mp4', ?, ?, ?, ?
      FROM video_run_results
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
      id, input.storagePath, input.sizeBytes, input.sha256, now(), input.videoRunResultId,
      input.attemptId ?? null, input.attemptId ?? null,
    )
    if (inserted.changes !== 1) {
      if (this.db.prepare('SELECT 1 FROM video_run_results WHERE id = ?').get(input.videoRunResultId)) return undefined
      throw new Error(`视频执行结果 ${input.videoRunResultId} 不存在`)
    }
    return this.getOutput(id)!
  }

  getOutput(id: string) {
    const row = this.db.prepare('SELECT * FROM task_outputs WHERE id = ?').get(id) as Row | undefined
    return row ? mapOutputRow(row) : undefined
  }

  getOutputRecord(id: string) {
    return this.db.prepare('SELECT * FROM task_outputs WHERE id = ?').get(id) as Row | undefined
  }

  listOutputsForRun(runId: string): TestOutput[] {
    return (this.db.prepare('SELECT * FROM task_outputs WHERE device_run_id = ? ORDER BY created_at').all(runId) as Row[]).map(mapOutputRow)
  }

  listOutputsForVideoResult(videoRunResultId: string): TestOutput[] {
    return (this.db.prepare(`
      SELECT * FROM task_outputs
      WHERE video_run_result_id = ?
      ORDER BY created_at
    `).all(videoRunResultId) as Row[]).map(mapOutputRow)
  }
}
