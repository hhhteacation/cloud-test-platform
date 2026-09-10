import { DatabaseSync } from 'node:sqlite'

import { config, databasePath } from './config.js'
import type { DeviceRunExecution, DeviceRunJob } from './database/contracts.js'
import { runDatabaseMigrations } from './database/migrations/index.js'
import { markInterruptedTasks, seedDefaultDevices } from './database/schema.js'
import { ArtifactStore } from './database/stores/artifact-store.js'
import { ConnectionEventStore, type AppendConnectionEventInput } from './database/stores/connection-event-store.js'
import { AuditStore } from './database/stores/audit-store.js'
import { DeviceRunStore } from './database/stores/device-run-store.js'
import { DeviceStore, type UpsertAdbDeviceInput } from './database/stores/device-store.js'
import { DeviceEndpointStore, type UpsertEndpointInput } from './database/stores/device-endpoint-store.js'
import {
  DeviceConnectionStateStore,
  type BeginDeviceConnectionOperationInput,
  type CommitDeviceConnectionOperationInput,
  type CurrentDeviceConnectionOperationInput,
  type ExpireDeviceConnectionOperationInput,
  type RecordDeviceConnectionHealthFailureInput,
  type RecordPassiveDeviceConnectionHealthInput,
} from './database/stores/device-connection-state-store.js'
import { NetworkConnectionOperationStore } from './database/stores/network-connection-operation-store.js'
import { TaskStore } from './database/stores/task-store.js'
import { VideoExecutionStore } from './database/stores/video-execution-store.js'
import type { ArtifactRecord, CheckResult, MediaIntegrityResult } from './types.js'

export interface ActivateVerifiedNetworkEndpointInput {
  deviceId: string
  operationId: string
  generation: number
  endpoint: UpsertEndpointInput
  profile: Parameters<DeviceStore['updateProfile']>[1]
  event: Omit<AppendConnectionEventInput, 'deviceId' | 'operationId' | 'generation'>
}

class StaleDeviceConnectionActivationError extends Error {}

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
  readonly connectionEvents: ConnectionEventStore
  readonly devices: DeviceStore
  readonly deviceEndpoints: DeviceEndpointStore
  readonly deviceConnectionStates: DeviceConnectionStateStore
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
    this.connectionEvents = new ConnectionEventStore(this.db)
    this.devices = new DeviceStore(this.db)
    this.deviceEndpoints = new DeviceEndpointStore(this.db)
    this.deviceConnectionStates = new DeviceConnectionStateStore(this.db)
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
    for (const operation of this.deviceConnectionStates.markInterrupted()) {
      this.connectionEvents.append({
        ...operation,
        eventType: 'operation_interrupted',
        source: 'service_startup',
        result: 'cancelled',
        failureCode: 'SERVICE_RESTARTED',
      })
    }
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
  getDeviceEndpointByTransport(deviceId: string, kind: Parameters<DeviceEndpointStore['getByDeviceAndTransport']>[1], transportType: Parameters<DeviceEndpointStore['getByDeviceAndTransport']>[2]) { return this.deviceEndpoints.getByDeviceAndTransport(deviceId, kind, transportType) }
  getDeviceEndpointBySerial(serial: string) { return this.deviceEndpoints.getBySerial(serial) }
  upsertDeviceEndpoint(input: UpsertEndpointInput) { return this.deviceEndpoints.upsert(input) }
  updateDeviceEndpointStatus(id: string, status: Parameters<DeviceEndpointStore['updateStatus']>[1], lastError?: string) { return this.deviceEndpoints.updateStatus(id, status, lastError) }
  recordDeviceEndpointHealthFailure(id: string, input: Parameters<DeviceEndpointStore['recordHealthFailure']>[1]) { return this.deviceEndpoints.recordHealthFailure(id, input) }
  recordDeviceEndpointHealthSuccess(id: string, evaluatedAt?: string) { return this.deviceEndpoints.recordHealthSuccess(id, evaluatedAt) }
  updateDeviceEndpointObservation(id: string, input: Parameters<DeviceEndpointStore['updateObservation']>[1]) { return this.deviceEndpoints.updateObservation(id, input) }
  removeDeviceEndpoint(id: string) { return this.deviceEndpoints.remove(id) }
  appendConnectionEvent(input: AppendConnectionEventInput) { return this.connectionEvents.append(input) }
  listConnectionEvents(deviceId: string) { return this.connectionEvents.listForDevice(deviceId) }
  getDeviceConnectionState(deviceId: string) { return this.deviceConnectionStates.get(deviceId) }
  listDeviceConnectionStates() { return this.deviceConnectionStates.list() }
  setDeviceConnectionManagementMode(deviceId: string, mode: Parameters<DeviceConnectionStateStore['setManagementMode']>[1]) { return this.deviceConnectionStates.setManagementMode(deviceId, mode) }
  beginDeviceConnectionOperation(input: BeginDeviceConnectionOperationInput) { return this.deviceConnectionStates.begin(input) }
  commitDeviceConnectionOperation(input: CommitDeviceConnectionOperationInput) { return this.deviceConnectionStates.commit(input) }
  restoreDeviceConnectionOperationAfterAbort(input: CommitDeviceConnectionOperationInput) { return this.deviceConnectionStates.restoreAfterAbort(input) }
  isCurrentDeviceConnectionOperation(input: CurrentDeviceConnectionOperationInput) { return this.deviceConnectionStates.isCurrent(input) }
  expireDeviceConnectionOperation(input: ExpireDeviceConnectionOperationInput) { return this.deviceConnectionStates.expire(input) }
  recordDeviceConnectionHealthFailure(input: RecordDeviceConnectionHealthFailureInput) { return this.deviceConnectionStates.recordHealthFailure(input) }
  recordPassiveDeviceConnectionHealth(input: RecordPassiveDeviceConnectionHealthInput) { return this.deviceConnectionStates.recordPassiveHealth(input) }
  activateVerifiedNetworkEndpoint(input: ActivateVerifiedNetworkEndpointInput) {
    if (input.endpoint.deviceId !== input.deviceId || input.endpoint.kind !== 'network') {
      throw new Error('联网 Endpoint 激活参数与目标物理设备不一致')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const identity = {
        deviceId: input.deviceId,
        operationId: input.operationId,
        generation: input.generation,
      }
      if (!this.deviceConnectionStates.isCurrent(identity)) {
        throw new StaleDeviceConnectionActivationError()
      }
      this.devices.updateProfile(input.deviceId, input.profile)
      this.devices.markSeen(input.deviceId)
      const endpoint = this.deviceEndpoints.upsert(input.endpoint)
      if (!this.deviceConnectionStates.commit({
        ...identity,
        desiredState: 'connected',
        observedState: 'online',
        activeEndpointId: endpoint.id,
      })) {
        throw new StaleDeviceConnectionActivationError()
      }
      this.connectionEvents.append({ ...identity, ...input.event })
      this.db.exec('COMMIT')
      return endpoint
    } catch (error) {
      this.db.exec('ROLLBACK')
      if (error instanceof StaleDeviceConnectionActivationError) return undefined
      throw error
    }
  }
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
  upsertVideoCheck(runId: string, videoRunResultId: string, check: CheckResult, attemptId?: string) {
    return this.audit.upsertVideoCheck(runId, videoRunResultId, check, attemptId)
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
  recordVideoMediaIntegrity(videoRunResultId: string, result: MediaIntegrityResult, attemptId?: string) {
    return this.videoExecutions.recordMediaIntegrity(videoRunResultId, result, attemptId)
  }
  blockRemainingVideoResults(input: Parameters<VideoExecutionStore['blockRemaining']>[0]) {
    return this.videoExecutions.blockRemaining(input)
  }

  addOutput(input: Parameters<ArtifactStore['addOutput']>[0]) { return this.artifacts.addOutput(input) }
  addVideoOutput(input: Parameters<ArtifactStore['addVideoOutput']>[0]) { return this.artifacts.addVideoOutput(input) }
  getOutput(id: string) { return this.artifacts.getOutput(id) }
  getOutputRecord(id: string) { return this.artifacts.getOutputRecord(id) }
}
