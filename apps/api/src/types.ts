import type { ApkExecutionProtocol } from './apk-protocols.js'

export type ArtifactKind = 'apk' | 'video'
export type TaskStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled'
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'blocked'
export type CheckStatus = 'passed' | 'failed' | 'blocked'
export type DevicePlatform = 'android' | 'ios' | 'harmonyos'
export type DeviceConnectionStatus = 'online' | 'offline' | 'unauthorized' | 'unknown'

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
}

export interface DeviceDiscoveryCandidate {
  serial: string
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
  kind: 'processed_video'
  name: string
  mimeType: 'video/mp4'
  sizeBytes: number
  sha256: string
  previewUrl: string
  downloadUrl: string
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
  failureCode?: string
  failureMessage?: string
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
  deviceIds: string[]
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
