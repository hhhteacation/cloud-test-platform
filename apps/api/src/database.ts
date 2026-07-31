import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { findApkExecutionProtocol, toPublicApkProtocol } from './apk-protocols.js'
import { config, databasePath } from './config.js'
import { mapArtifactRow, mapDeviceRow, mapOutputRow, type DatabaseRow } from './database/mappers.js'
import { createDatabaseSchema, markInterruptedTasks, seedDefaultDevices } from './database/schema.js'
import { getTaskCapabilities } from './task-capabilities.js'
import type {
  ArtifactRecord,
  CheckResult,
  DevicePlatform,
  DeviceProfile,
  DeviceRunPhase,
  DeviceRunView,
  RunStatus,
  TaskStatus,
  TestOutput,
  TestReportView,
  TestTaskView,
} from './types.js'

export interface DeviceRunJob {
  taskId: string
  runId: string
  deviceId: string
}

export interface DeviceRunExecution extends DeviceRunJob {
  deviceSerial: string
  deviceName: string
  platform: DevicePlatform
  apkPath: string
  apkPackageName?: string
  videoPath: string
  videoOriginalName: string
  timeoutSeconds: number
  taskStatus: TaskStatus
  runStatus: RunStatus
}

type Row = DatabaseRow
const now = () => new Date().toISOString()
const asString = (value: unknown) => typeof value === 'string' ? value : ''
const asNumber = (value: unknown) => typeof value === 'number' ? value : Number(value ?? 0)

export interface PlatformDatabaseOptions {
  databasePath?: string
  seedDevice?: boolean
  markInterruptedTasks?: boolean
  deviceSerial?: string
}

export class PlatformDatabase {
  readonly db: DatabaseSync

  constructor(options: PlatformDatabaseOptions = {}) {
    this.db = new DatabaseSync(options.databasePath ?? databasePath)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    createDatabaseSchema(this.db)
    if (options.seedDevice !== false) seedDefaultDevices(this.db, options.deviceSerial ?? config.deviceSerial)
    if (options.markInterruptedTasks !== false) markInterruptedTasks(this.db)
  }

  close() { this.db.close() }

  insertArtifact(input: Omit<ArtifactRecord, 'id' | 'createdAt'>) {
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

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined
    return row ? mapArtifactRow(row) : undefined
  }

  listDevices(): DeviceProfile[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY registered_at, id').all() as Row[]).map(mapDeviceRow)
  }

  getDevice(id: string) {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined
    return row ? mapDeviceRow(row) : undefined
  }

  getDeviceBySerial(serial: string) {
    const row = this.db.prepare('SELECT * FROM devices WHERE serial = ?').get(serial) as Row | undefined
    return row ? mapDeviceRow(row) : undefined
  }

  markDeviceSeen(deviceId: string) {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now(), deviceId)
  }

  upsertAdbDevice(input: {
    id: string
    serial: string
    name: string
    manufacturer: string
    model?: string
    osVersion: string
    apiLevel: number
    architecture: string
    buildVersion?: string
    securityPatch?: string
  }) {
    const timestamp = now()
    this.db.prepare(`
      INSERT INTO devices (
        id, platform, name, manufacturer, model, os_version, api_level,
        architecture, execution_mode, eligible, serial, build_version,
        security_patch, registered_at, last_seen_at
      ) VALUES (?, 'android', ?, ?, ?, ?, ?, ?, 'adb', 1, ?, ?, ?, ?, ?)
      ON CONFLICT(serial) WHERE serial IS NOT NULL AND serial <> '' DO UPDATE SET
        name = excluded.name, manufacturer = excluded.manufacturer,
        model = excluded.model, os_version = excluded.os_version,
        api_level = excluded.api_level, architecture = excluded.architecture,
        execution_mode = 'adb', eligible = 1,
        build_version = excluded.build_version,
        security_patch = excluded.security_patch,
        last_seen_at = excluded.last_seen_at
    `).run(
      input.id, input.name, input.manufacturer, input.model ?? null,
      input.osVersion, input.apiLevel, input.architecture, input.serial,
      input.buildVersion ?? null, input.securityPatch ?? null, timestamp, timestamp,
    )
    return this.getDeviceBySerial(input.serial)!
  }

  createTask(input: {
    name: string
    platform?: 'android'
    apkArtifactId: string
    videoArtifactId: string
    deviceIds: string[]
    timeoutSeconds: number
  }) {
    const taskId = `task-${randomUUID()}`
    const createdAt = now()
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`
        INSERT INTO tasks (
          id, platform, name, apk_artifact_id, video_artifact_id, status,
          progress, timeout_seconds, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
      `).run(
        taskId, input.platform ?? 'android', input.name, input.apkArtifactId,
        input.videoArtifactId, input.timeoutSeconds, createdAt, createdAt,
      )
      for (const deviceId of input.deviceIds) {
        this.db.prepare(`
          INSERT INTO device_runs (id, task_id, device_id, status, progress)
          VALUES (?, ?, ?, 'queued', 0)
        `).run(`run-${randomUUID()}`, taskId, deviceId)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getTask(taskId)!
  }

  listTasks() {
    const rows = this.db.prepare('SELECT id FROM tasks ORDER BY created_at DESC').all() as Row[]
    return rows.map((row) => this.getTask(asString(row.id))).filter(Boolean) as TestTaskView[]
  }

  listQueuedDeviceRunJobs(taskId?: string): DeviceRunJob[] {
    return (this.db.prepare(`
      SELECT r.task_id, r.id AS run_id, r.device_id
      FROM device_runs r
      JOIN tasks t ON t.id = r.task_id
      WHERE r.status = 'queued' AND t.status IN ('queued', 'running')
        AND (? IS NULL OR r.task_id = ?)
      ORDER BY t.created_at, r.rowid
    `).all(taskId ?? null, taskId ?? null) as Row[]).map((row) => ({
      taskId: asString(row.task_id),
      runId: asString(row.run_id),
      deviceId: asString(row.device_id),
    }))
  }

  /** Kept for deletion tests and backward-compatible internal callers. */
  getRunForTask(taskId: string) {
    const row = this.db.prepare('SELECT * FROM device_runs WHERE task_id = ? ORDER BY rowid LIMIT 1').get(taskId) as Row | undefined
    if (!row) return undefined
    return { id: asString(row.id), deviceId: asString(row.device_id), status: asString(row.status) as RunStatus }
  }

  getDeviceRunExecution(taskId: string, runId: string): DeviceRunExecution | undefined {
    const row = this.db.prepare(`
      SELECT t.status AS task_status, t.timeout_seconds, t.platform,
             a.storage_path AS apk_path, a.package_name AS apk_package_name,
             v.storage_path AS video_path, v.original_name AS video_original_name,
             r.id AS run_id, r.device_id, r.status AS run_status,
             d.serial AS device_serial, d.name AS device_name
      FROM device_runs r
      JOIN tasks t ON t.id = r.task_id
      JOIN artifacts a ON a.id = t.apk_artifact_id
      JOIN artifacts v ON v.id = t.video_artifact_id
      JOIN devices d ON d.id = r.device_id
      WHERE t.id = ? AND r.id = ?
    `).get(taskId, runId) as Row | undefined
    if (!row) return undefined
    return {
      taskId,
      runId: asString(row.run_id),
      deviceId: asString(row.device_id),
      deviceSerial: asString(row.device_serial),
      deviceName: asString(row.device_name),
      platform: (asString(row.platform) || 'android') as DevicePlatform,
      apkPath: asString(row.apk_path),
      apkPackageName: asString(row.apk_package_name) || undefined,
      videoPath: asString(row.video_path),
      videoOriginalName: asString(row.video_original_name) || 'input.mp4',
      timeoutSeconds: asNumber(row.timeout_seconds),
      taskStatus: asString(row.task_status) as TaskStatus,
      runStatus: asString(row.run_status) as RunStatus,
    }
  }

  getTask(taskId: string): TestTaskView | undefined {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined
    if (!task) return undefined
    const apk = this.getArtifact(asString(task.apk_artifact_id))
    const video = this.getArtifact(asString(task.video_artifact_id))
    if (!apk || !video) return undefined

    const runRows = this.db.prepare('SELECT * FROM device_runs WHERE task_id = ? ORDER BY rowid').all(taskId) as Row[]
    const runs: Record<string, DeviceRunView> = {}
    for (const row of runRows) {
      const runId = asString(row.id)
      const deviceId = asString(row.device_id)
      const checks = (this.db.prepare('SELECT * FROM check_results WHERE device_run_id = ? ORDER BY rowid').all(runId) as Row[])
        .map((check): CheckResult => ({
          key: asString(check.check_key), name: asString(check.name),
          status: asString(check.status) as CheckResult['status'],
          durationMs: check.duration_ms == null ? undefined : asNumber(check.duration_ms),
          message: asString(check.message) || undefined,
        }))
      const logs = (this.db.prepare('SELECT message FROM task_logs WHERE device_run_id = ? ORDER BY id').all(runId) as Row[])
        .map((log) => asString(log.message))
      runs[deviceId] = {
        id: runId, deviceId, status: asString(row.status) as RunStatus,
        phase: (asString(row.phase) || undefined) as DeviceRunPhase | undefined,
        progress: asNumber(row.progress), checks, logs, outputs: this.getOutputsForRun(runId),
        startedAt: asString(row.started_at) || undefined,
        finishedAt: asString(row.finished_at) || undefined,
        mode: 'ADB 真机',
        failureCode: asString(row.failure_code) || undefined,
        failureMessage: asString(row.failure_message) || undefined,
        logcatUrl: `/api/tasks/${taskId}/device-runs/${runId}/logcat`,
        screenshotUrl: `/api/tasks/${taskId}/device-runs/${runId}/screenshots/final`,
      }
    }

    return {
      id: asString(task.id),
      platform: (asString(task.platform) || 'android') as DevicePlatform,
      name: asString(task.name),
      apk: this.artifactView(apk),
      asset: this.artifactView(video),
      deviceIds: Object.keys(runs),
      status: asString(task.status) as TaskStatus,
      progress: asNumber(task.progress),
      passRate: task.pass_rate == null ? undefined : asNumber(task.pass_rate),
      createdAt: asString(task.created_at),
      runs,
      capabilities: getTaskCapabilities(asString(task.status) as TaskStatus),
    }
  }

  getReport(taskId: string): TestReportView | undefined {
    const task = this.getTask(taskId)
    if (!task) return undefined
    const statuses = Object.values(task.runs).map((run) => run.status)
    const conclusion = task.status === 'cancelled'
      ? 'cancelled'
      : statuses.includes('failed')
        ? 'failed'
        : statuses.length > 0 && statuses.every((status) => status === 'passed')
          ? 'passed'
          : statuses.some((status) => status === 'blocked') && statuses.every((status) => status !== 'queued' && status !== 'running')
            ? 'blocked'
            : 'not_executed'
    return { ...task, conclusion, generatedAt: now() }
  }

  hasDeviceRun(taskId: string, runId: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM device_runs WHERE id = ? AND task_id = ?').get(runId, taskId))
  }

  setExecutionState(input: {
    taskId: string
    runId: string
    taskStatus?: TaskStatus
    runStatus?: RunStatus
    phase?: DeviceRunPhase
    progress?: number
    failureCode?: string | null
    failureMessage?: string | null
    started?: boolean
    finished?: boolean
  }) {
    const task = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(input.taskId) as Row | undefined
    if (!task || asString(task.status) === 'cancelled') return
    const currentRun = this.db.prepare('SELECT * FROM device_runs WHERE id = ? AND task_id = ?').get(input.runId, input.taskId) as Row | undefined
    if (!currentRun) return
    const timestamp = now()
    this.db.prepare(`
      UPDATE device_runs SET status = ?, phase = ?, progress = ?,
        failure_code = ?, failure_message = ?, started_at = ?, finished_at = ?
      WHERE id = ? AND task_id = ?
    `).run(
      input.runStatus ?? asString(currentRun.status),
      input.phase ?? (asString(currentRun.phase) || null),
      input.progress ?? asNumber(currentRun.progress),
      input.failureCode === undefined ? asString(currentRun.failure_code) || null : input.failureCode,
      input.failureMessage === undefined ? asString(currentRun.failure_message) || null : input.failureMessage,
      input.started ? timestamp : asString(currentRun.started_at) || null,
      input.finished ? timestamp : asString(currentRun.finished_at) || null,
      input.runId, input.taskId,
    )
    this.recomputeTaskState(input.taskId)
  }

  /**
   * Queue-level safety net for an executor exception that escaped before the
   * platform worker persisted a normal failure. The guarded update prevents a
   * late exception from overwriting completed or cancelled device runs.
   */
  failDeviceRun(job: DeviceRunJob, failureCode: string, failureMessage: string) {
    const timestamp = now()
    const result = this.db.prepare(`
      UPDATE device_runs
      SET status = 'failed', progress = 100,
          failure_code = ?, failure_message = ?, finished_at = ?
      WHERE id = ? AND task_id = ?
        AND status IN ('queued', 'running')
        AND EXISTS (
          SELECT 1 FROM tasks
          WHERE id = ? AND status <> 'cancelled'
        )
    `).run(
      failureCode,
      failureMessage,
      timestamp,
      job.runId,
      job.taskId,
      job.taskId,
    )
    if (result.changes === 1) {
      this.addLog(job.taskId, job.runId, failureMessage, 'error')
      this.recomputeTaskState(job.taskId)
    }
    return result.changes === 1
  }

  private recomputeTaskState(taskId: string) {
    const task = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as Row | undefined
    if (!task || asString(task.status) === 'cancelled') return
    const runs = this.db.prepare('SELECT status, progress, failure_code, failure_message FROM device_runs WHERE task_id = ?').all(taskId) as Row[]
    if (!runs.length) return
    const statuses = runs.map((run) => asString(run.status) as RunStatus)
    const progress = Math.round(runs.reduce((sum, run) => sum + asNumber(run.progress), 0) / runs.length)
    const passed = statuses.filter((status) => status === 'passed').length
    const allQueued = statuses.every((status) => status === 'queued')
    const unfinished = statuses.some((status) => status === 'queued' || status === 'running')
    const status: TaskStatus = allQueued ? 'queued' : unfinished ? 'running' : statuses.every((item) => item === 'passed') ? 'passed' : 'failed'
    const failure = runs.find((run) => ['failed', 'blocked'].includes(asString(run.status)))
    this.db.prepare(`
      UPDATE tasks SET status = ?, progress = ?, pass_rate = ?,
        failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?
    `).run(
      status, progress, (passed / runs.length) * 100,
      failure ? asString(failure.failure_code) || null : null,
      failure ? asString(failure.failure_message) || null : null,
      now(), taskId,
    )
  }

  addLog(taskId: string, runId: string, message: string, level = 'info') {
    this.db.prepare(`INSERT INTO task_logs (task_id, device_run_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(taskId, runId, level, message, now())
  }

  upsertCheck(runId: string, check: CheckResult) {
    this.db.prepare(`
      INSERT INTO check_results (id, device_run_id, check_key, name, status, duration_ms, message, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_run_id, check_key) DO UPDATE SET
        name = excluded.name, status = excluded.status, duration_ms = excluded.duration_ms,
        message = excluded.message, updated_at = excluded.updated_at
    `).run(
      `check-${randomUUID()}`, runId, check.key, check.name, check.status,
      check.durationMs ?? null, check.message ?? null, now(),
    )
  }

  addOutput(input: { taskId: string; runId: string; storagePath: string; sizeBytes: number; sha256: string }) {
    const id = `output-${randomUUID()}`
    this.db.prepare(`
      INSERT INTO task_outputs (id, task_id, device_run_id, kind, name, mime_type, storage_path, size_bytes, sha256, created_at)
      VALUES (?, ?, ?, 'processed_video', 'output.mp4', 'video/mp4', ?, ?, ?, ?)
    `).run(id, input.taskId, input.runId, input.storagePath, input.sizeBytes, input.sha256, now())
    return this.getOutput(id)!
  }

  getOutput(id: string) {
    const row = this.db.prepare('SELECT * FROM task_outputs WHERE id = ?').get(id) as Row | undefined
    return row ? mapOutputRow(row) : undefined
  }

  getOutputRecord(id: string) {
    return this.db.prepare('SELECT * FROM task_outputs WHERE id = ?').get(id) as Row | undefined
  }

  private getOutputsForRun(runId: string): TestOutput[] {
    return (this.db.prepare('SELECT * FROM task_outputs WHERE device_run_id = ? ORDER BY created_at').all(runId) as Row[]).map(mapOutputRow)
  }

  isCancelled(taskId: string) {
    const row = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as Row | undefined
    return asString(row?.status) === 'cancelled'
  }

  cancelTask(taskId: string) {
    const timestamp = now()
    this.db.prepare(`
      UPDATE tasks SET status = 'cancelled', failure_code = 'TASK_CANCELLED',
      failure_message = '用户取消任务', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(timestamp, taskId)
    this.db.prepare(`
      UPDATE device_runs SET status = 'blocked', progress = 100,
      failure_code = 'TASK_CANCELLED', failure_message = '用户取消任务', finished_at = ?
      WHERE task_id = ? AND status IN ('queued', 'running')
    `).run(timestamp, taskId)
  }

  private artifactView(artifact: ArtifactRecord) {
    const protocol = artifact.kind === 'apk' ? findApkExecutionProtocol(artifact.packageName) : undefined
    return {
      id: artifact.id, kind: artifact.kind, name: artifact.originalName,
      sizeBytes: artifact.sizeBytes, mimeType: artifact.mimeType, sha256: artifact.sha256,
      packageName: artifact.packageName,
      protocol: protocol ? toPublicApkProtocol(protocol) : undefined,
      previewUrl: artifact.kind === 'video' ? `/api/artifacts/${artifact.id}/content` : undefined,
    }
  }
}
