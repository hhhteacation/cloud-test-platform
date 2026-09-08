import { DatabaseSync } from 'node:sqlite'

import { config, databasePath } from './config.js'
import type { DeviceRunExecution, DeviceRunJob } from './database/contracts.js'
import { runDatabaseMigrations } from './database/migrations/index.js'
import { markInterruptedTasks, seedDefaultDevices } from './database/schema.js'
import { ArtifactStore } from './database/stores/artifact-store.js'
import { AuditStore } from './database/stores/audit-store.js'
import { DeviceRunStore } from './database/stores/device-run-store.js'
import { DeviceStore, type UpsertAdbDeviceInput } from './database/stores/device-store.js'
import { DeviceEndpointStore, type UpsertEndpointInput } from './database/stores/device-endpoint-store.js'
import { NetworkConnectionOperationStore } from './database/stores/network-connection-operation-store.js'
import { TaskStore } from './database/stores/task-store.js'
import { VideoExecutionStore } from './database/stores/video-execution-store.js'
import type { ArtifactRecord, CheckResult, MediaIntegrityResult } from './types.js'

export type { DeviceRunExecution, DeviceRunJob, VideoRunExecution } from './database/contracts.js'

export interface PlatformDatabaseOptions {
  databasePath?: string
  seedDevice?: boolean
  markInterruptedTasks?: boolean
  deviceSerial?: string
}

/**
 * Compatibility facade for existing callers.
 * SQL ownership lives in domain Stores; routes and workers do not receive raw SQL details.
 */
export class PlatformDatabase {
  readonly db: DatabaseSync
  readonly artifacts: ArtifactStore
  readonly devices: DeviceStore
  readonly deviceEndpoints: DeviceEndpointStore
  readonly deviceRuns: DeviceRunStore
  readonly audit: AuditStore
  readonly videoExecutions: VideoExecutionStore
  readonly tasks: TaskStore
  readonly networkConnectionOperations: NetworkConnectionOperationStore

  constructor(options: PlatformDatabaseOptions = {}) {
    const resolvedDatabasePath = options.databasePath ?? databasePath
    this.db = new DatabaseSync(resolvedDatabasePath)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    runDatabaseMigrations(this.db, resolvedDatabasePath)

    this.artifacts = new ArtifactStore(this.db)
    this.devices = new DeviceStore(this.db)
    this.deviceEndpoints = new DeviceEndpointStore(this.db)
    this.audit = new AuditStore(this.db)
    this.deviceRuns = new DeviceRunStore(this.db, this.audit)
    this.videoExecutions = new VideoExecutionStore(this.db)
    this.tasks = new TaskStore(
      this.db, this.artifacts, this.deviceRuns, this.audit, this.videoExecutions,
      {
        maxVideosPerTask: config.maxTaskVideos,
        maxVideoBytes: config.maxVideoBytes,
        maxTotalVideoBytes: config.maxTaskInputVideoBytes,
      },
    )
    this.networkConnectionOperations = new NetworkConnectionOperationStore(this.db)
    this.networkConnectionOperations.markInterrupted()
    this.deviceRuns.setTaskStateChangedHandler((taskId) => this.tasks.recompute(taskId))
    this.videoExecutions.setResultStateChangedHandler((taskId, runId) => {
      this.deviceRuns.recomputeFromVideoResults(taskId, runId)
    })

    const seedSerial = Object.hasOwn(options, 'deviceSerial') ? options.deviceSerial : config.deviceSerial
    if (options.seedDevice !== false && seedSerial) seedDefaultDevices(this.db, seedSerial)
    if (options.markInterruptedTasks !== false) markInterruptedTasks(this.db)
  }

  close() { this.db.close() }

  insertArtifact(input: Omit<ArtifactRecord, 'id' | 'createdAt'>) { return this.artifacts.insert(input) }
  getArtifact(id: string) { return this.artifacts.get(id) }
  listArtifactStoragePaths() { return this.artifacts.listStoragePaths() }

  listDevices() { return this.devices.list() }
  getDevice(id: string) { return this.devices.get(id) }
  getDeviceBySerial(serial: string) { return this.devices.getBySerial(serial) }
  markDeviceSeen(deviceId: string) { return this.devices.markSeen(deviceId) }
  upsertAdbDevice(input: UpsertAdbDeviceInput) { return this.devices.upsertAdb(input) }
  listDeviceEndpoints(deviceId: string) { return this.deviceEndpoints.listForDevice(deviceId) }
  getDeviceEndpoint(id: string) { return this.deviceEndpoints.get(id) }
  getDeviceEndpointByKind(deviceId: string, kind: Parameters<DeviceEndpointStore['getByDeviceAndKind']>[1]) { return this.deviceEndpoints.getByDeviceAndKind(deviceId, kind) }
  getDeviceEndpointBySerial(serial: string) { return this.deviceEndpoints.getBySerial(serial) }
  upsertDeviceEndpoint(input: UpsertEndpointInput) { return this.deviceEndpoints.upsert(input) }
  updateDeviceEndpointStatus(id: string, status: Parameters<DeviceEndpointStore['updateStatus']>[1], lastError?: string) { return this.deviceEndpoints.updateStatus(id, status, lastError) }
  removeDeviceEndpoint(id: string) { return this.deviceEndpoints.remove(id) }
  hasActiveNetworkConnectionOperation() { return this.networkConnectionOperations.hasActive() }
  getNetworkConnectionOperation(id: string) { return this.networkConnectionOperations.get(id) }

  createTask(input: Parameters<TaskStore['create']>[0]) { return this.tasks.create(input) }
  listTasks() { return this.tasks.list() }
  getTask(taskId: string) { return this.tasks.get(taskId) }
  getReport(taskId: string) { return this.tasks.report(taskId) }
  isCancelled(taskId: string) { return this.tasks.isCancelled(taskId) }
  cancelTask(taskId: string) { return this.tasks.cancel(taskId) }

  listQueuedDeviceRunJobs(taskId?: string): DeviceRunJob[] { return this.deviceRuns.listQueuedJobs(taskId) }
  getRunForTask(taskId: string) { return this.deviceRuns.getFirstForTask(taskId) }
  getDeviceQueueStatus(deviceId: string) { return this.deviceRuns.getQueueStatus(deviceId) }
  getDeviceRunExecution(taskId: string, runId: string): DeviceRunExecution | undefined {
    return this.deviceRuns.getExecution(taskId, runId)
  }
  hasDeviceRun(taskId: string, runId: string) { return this.deviceRuns.has(taskId, runId) }
  assignDeviceRunEndpoint(
    job: DeviceRunJob,
    endpoint: Parameters<DeviceRunStore['assignExecutionEndpoint']>[1],
  ) {
    return this.deviceRuns.assignExecutionEndpoint(job, endpoint)
  }
  setExecutionState(input: Parameters<DeviceRunStore['setState']>[0]) { return this.deviceRuns.setState(input) }
  failDeviceRun(job: DeviceRunJob, failureCode: string, failureMessage: string) {
    return this.deviceRuns.fail(job, failureCode, failureMessage)
  }
  recordMediaIntegrity(runId: string, result: MediaIntegrityResult) {
    return this.deviceRuns.recordMediaIntegrity(runId, result)
  }

  addLog(taskId: string, runId: string, message: string, level = 'info') {
    return this.audit.addLog(taskId, runId, message, level)
  }
  upsertCheck(runId: string, check: CheckResult) { return this.audit.upsertCheck(runId, check) }
  addVideoLog(taskId: string, runId: string, videoRunResultId: string, message: string, level = 'info') {
    return this.audit.addVideoLog(taskId, runId, videoRunResultId, message, level)
  }
  upsertVideoCheck(runId: string, videoRunResultId: string, check: CheckResult) {
    return this.audit.upsertVideoCheck(runId, videoRunResultId, check)
  }

  createVideoAttempt(videoRunResultId: string, input?: Parameters<VideoExecutionStore['createAttempt']>[1]) {
    return this.videoExecutions.createAttempt(videoRunResultId, input)
  }
  listVideoExecutionsForDeviceRun(taskId: string, runId: string) {
    return this.videoExecutions.listExecutionsForDeviceRun(taskId, runId)
  }
  getVideoRunResultForDeviceRun(taskId: string, runId: string, taskVideoId: string) {
    return this.videoExecutions.getResultForDeviceRun(taskId, runId, taskVideoId)
  }
  getVideoResultLatestAttemptEvidenceDirectory(videoRunResultId: string) {
    return this.videoExecutions.latestAttemptEvidenceDirectory(videoRunResultId)
  }
  getDeviceRunLatestAttemptEvidenceDirectory(taskId: string, runId: string) {
    return this.videoExecutions.latestAttemptEvidenceDirectoryForDeviceRun(taskId, runId)
  }
  setVideoExecutionState(input: Parameters<VideoExecutionStore['setState']>[0]) {
    return this.videoExecutions.setState(input)
  }
  finishVideoAttempt(attemptId: string, input: Parameters<VideoExecutionStore['finishAttempt']>[1]) {
    return this.videoExecutions.finishAttempt(attemptId, input)
  }
  recordVideoMediaIntegrity(videoRunResultId: string, result: MediaIntegrityResult) {
    return this.videoExecutions.recordMediaIntegrity(videoRunResultId, result)
  }
  blockRemainingVideoResults(input: Parameters<VideoExecutionStore['blockRemaining']>[0]) {
    return this.videoExecutions.blockRemaining(input)
  }

  addOutput(input: Parameters<ArtifactStore['addOutput']>[0]) { return this.artifacts.addOutput(input) }
  addVideoOutput(input: Parameters<ArtifactStore['addVideoOutput']>[0]) { return this.artifacts.addVideoOutput(input) }
  getOutput(id: string) { return this.artifacts.getOutput(id) }
  getOutputRecord(id: string) { return this.artifacts.getOutputRecord(id) }
}
