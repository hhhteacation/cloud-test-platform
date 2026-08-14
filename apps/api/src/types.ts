import type { ApkExecutionProtocol } from './apk-protocols.js'
import type { ExecutionFailure } from './execution/execution-failures.js'

export type ArtifactKind = 'apk' | 'video'
export type TaskStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled'
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'blocked'
export type CheckStatus = 'passed' | 'failed' | 'blocked'
export type DevicePlatform = 'android' | 'ios' | 'harmonyos'
export type DeviceConnectionStatus = 'online' | 'offline' | 'unauthorized' | 'unknown'
export type DeviceConnectionKind = 'usb' | 'network'
export type TaskConnectionMode = 'auto' | 'usb' | 'network'
export type DeviceQueueStatus = 'idle' | 'queued' | 'running'

export interface DeviceEndpoint {
  id: string
  deviceId: string
  kind: DeviceConnectionKind
  adbSerial: string
  host?: string
  port?: number
  status: DeviceConnectionStatus
  lastSeenAt?: string
  lastError?: string
}
export type ExecutionStatus = 'pending' | 'running' | 'passed' | 'failed' | 'cancelled'
export type MediaIntegrityStatus = 'not_checked' | 'passed' | 'failed' | 'blocked'

export interface MediaMetadata {
  sizeBytes: number
  container?: string
  videoCodec?: string
  width?: number
  height?: number
  frameRate?: number
  frameCount?: number
  durationSeconds?: number
  hasAudio: boolean
  audioCodec?: string
}

export interface MediaIntegrityResult {
  status: 'passed' | 'failed'
  failureCode?: string
  message: string
  metadata?: MediaMetadata
}

export type DeviceRunPhase =
  | 'validating_device'
  | 'validating_apk'
  | 'installing_apk'
  | 'handling_install_dialog'
  | 'granting_permissions'
  | 'handling_app_dialog'
  | 'transferring_input'
  | 'launching_app'
  | 'processing'
  | 'validating_output'
  | 'collecting_output'
  | 'generating_report'
  | 'completed'

export interface ArtifactRecord {
  id: string
  kind: ArtifactKind
  originalName: string
  mimeType: string
  storagePath: string
  sizeBytes: number
  sha256: string
  packageName?: string
  createdAt: string
}

export interface DeviceProfile {
  id: string
  platform: DevicePlatform
  name: string
  manufacturer: string
  osVersion: string
  apiLevel: number
  architecture: string
  executionMode: 'adb' | 'simulated' | 'xctest' | 'hdc'
  eligible: boolean
  serial?: string
  model?: string
  buildVersion?: string
  securityPatch?: string
  registeredAt?: string
  lastSeenAt?: string
  connectionStatus?: DeviceConnectionStatus
  endpoints?: Partial<Record<DeviceConnectionKind, DeviceEndpoint>>
  overallConnectionStatus?: DeviceConnectionStatus
  selectable?: boolean
  unavailableReason?: string
  queueStatus?: DeviceQueueStatus
}

export interface DeviceDiscoveryCandidate {
  /** ADB transport serial. Network transports use host:port here. */
  serial: string
  /** Stable Android hardware identity read from ro.serialno/ro.boot.serialno. */
  hardwareSerial?: string
  platform: 'android'
  manufacturer?: string
  name?: string
  model?: string
  androidVersion?: string
  apiLevel?: number
  architecture?: string
  buildVersion?: string
  securityPatch?: string
  connectionStatus: DeviceConnectionStatus
  registeredDeviceId?: string
  kind?: DeviceConnectionKind
  host?: string
  port?: number
  failureCode?: string
  failureMessage?: string
  adbExitCode?: number
  adbStdout?: string
  adbStderr?: string
  adbStdoutTruncated?: boolean
  adbStderrTruncated?: boolean
}

export type NetworkConnectionOperationStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
export type NetworkConnectionOperationItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'

export interface NetworkConnectionOperationItem {
  id: string
  operationId: string
  deviceId: string
  endpointId: string
  host: string
  port: number
  status: NetworkConnectionOperationItemStatus
  skipReason?: string
  failureCode?: string
  failureMessage?: string
  adbExitCode?: number
  adbStdout?: string
  adbStderr?: string
  adbStdoutTruncated?: boolean
  adbStderrTruncated?: boolean
  cancelReason?: string
  startedAt?: string
  finishedAt?: string
}

export interface NetworkConnectionOperation {
  id: string
  status: NetworkConnectionOperationStatus
  totalCount: number
  succeeded: number
  failed: number
  skipped: number
  cancelled: number
  cancelRequested: boolean
  cancelReason?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  items: NetworkConnectionOperationItem[]
}

export interface NetworkConnectionOperationStart {
  operationId: string
  status: NetworkConnectionOperationStatus
  totalCount: number
}

export interface CheckResult {
  key: string
  name: string
  status: CheckStatus
  durationMs?: number
  message?: string
}

export interface TestOutput {
  id: string
  taskId: string
  deviceRunId: string
  videoRunResultId?: string
  kind: 'processed_video'
  name: string
  mimeType: 'video/mp4'
  sizeBytes: number
  sha256: string
  previewUrl: string
  downloadUrl: string
}

export interface TaskVideoView {
  id: string
  taskId: string
  artifactId: string
  sequence: number
  displayName: string
  asset: ArtifactView
}

export interface VideoRunAttemptView {
  id: string
  videoRunResultId: string
  attemptNumber: number
  status: RunStatus
  failureCode?: string
  failureMessage?: string
  startedAt?: string
  finishedAt?: string
  createdAt: string
}

export interface VideoRunResultView {
  id: string
  taskId: string
  taskVideoId: string
  deviceRunId: string
  deviceId: string
  status: RunStatus
  phase?: DeviceRunPhase
  progress: number
  checks: CheckResult[]
  logs: string[]
  outputs: TestOutput[]
  primaryOutput?: TestOutput
  attempts: VideoRunAttemptView[]
  startedAt?: string
  finishedAt?: string
  failureCode?: string
  failureMessage?: string
  failure?: ExecutionFailure
  executionStatus?: ExecutionStatus
  executionFailureCode?: string
  mediaIntegrityStatus: MediaIntegrityStatus
  mediaIntegrityFailureCode?: string
  mediaMetadata?: MediaMetadata
}

export interface DeviceRunView {
  id: string
  deviceId: string
  status: RunStatus
  phase?: DeviceRunPhase
  progress: number
  checks: CheckResult[]
  logs: string[]
  outputs: TestOutput[]
  startedAt?: string
  finishedAt?: string
  mode: 'ADB 真机'
  connectionKind?: DeviceConnectionKind
  endpointId?: string
  adbSerial?: string
  failureCode?: string
  failureMessage?: string
  failure?: ExecutionFailure
  executionStatus?: ExecutionStatus
  executionFailureCode?: string
  mediaIntegrityStatus?: MediaIntegrityStatus
  mediaIntegrityFailureCode?: string
  mediaMetadata?: MediaMetadata
  logcatUrl?: string
  screenshotUrl?: string
}

export interface ArtifactView {
  id: string
  kind: ArtifactKind
  name: string
  sizeBytes: number
  mimeType: string
  sha256: string
  packageName?: string
  protocol?: ApkExecutionProtocol & { recognized: true; executable: true }
  previewUrl?: string
}

export interface TaskCapabilities {
  canCancel: boolean
  canDelete: boolean
  deleteBlockedReason?: string
}

export interface DeletedRecordCounts {
  tasks: number
  deviceRuns: number
  checkResults: number
  logs: number
  outputs: number
}

export interface TaskDeletionReceipt {
  taskId: string
  deletedAt: string
  deletedRecordCounts: DeletedRecordCounts
  deletedArtifactIds: string[]
  retainedArtifactIds: string[]
  fileCleanupWarnings: string[]
}

export interface TestTaskView {
  id: string
  platform: DevicePlatform
  name: string
  apk: ArtifactView
  asset: ArtifactView
  videos: TaskVideoView[]
  videoRuns: Record<string, Record<string, VideoRunResultView>>
  deviceIds: string[]
  connectionMode?: TaskConnectionMode
  status: TaskStatus
  progress: number
  passRate?: number
  createdAt: string
  runs: Record<string, DeviceRunView>
  capabilities: TaskCapabilities
}

export interface TestReportView extends TestTaskView {
  conclusion: 'passed' | 'failed' | 'blocked' | 'cancelled' | 'not_executed'
  generatedAt: string
  output?: TestOutput
}

export interface AndroidCheckEvent {
  protocolVersion?: number
  taskId?: string
  eventType?: string
  checkKey?: string
  name?: string
  status?: CheckStatus | 'running'
  timestamp?: string
  progress?: number
  durationMs?: number
  message?: string
}

export interface AndroidResult {
  protocolVersion?: number
  taskId: string
  status: 'passed' | 'failed'
  adapter?: string
  failureCode?: string
  failureMessage?: string
  checks?: CheckResult[]
  output?: {
    name?: string
    relativePath?: string
    sizeBytes?: number
    sha256?: string
  }
}
