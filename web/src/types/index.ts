export type TestTaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'

export type DeviceRunStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'

export type CheckStatus = 'passed' | 'failed' | 'blocked'
export type ArtifactKind = 'apk' | 'video'
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

export type ExecutionFailureCategory =
  | 'observation'
  | 'device'
  | 'business'
  | 'protocol'
  | 'infrastructure'
  | 'user_action'
  | 'cancelled'
export type ExecutionFailureRetryability = 'never' | 'safe' | 'conditional'
export type ExecutionFailureConfidence = 'confirmed' | 'probable' | 'unknown'

export interface ExecutionFailure {
  code: string
  category: ExecutionFailureCategory
  phase: DeviceRunPhase
  retryability: ExecutionFailureRetryability
  confidence: ExecutionFailureConfidence
  message: string
  evidenceRefs: string[]
}

export interface ApkExecutionProtocol {
  id: string
  name: string
  packageName: string
  launchActivity: string
  recognized: true
  executable: true
  requiresRunAs: boolean
  install: {
    mode: 'replace' | 'clean'
    description: string
    runtimePermissions?: string[]
    dialogAutomation?: {
      mode: 'none' | 'strict-whitelist'
      profileIds: string[]
      timeoutMs: number
      pollIntervalMs: number
      maxActions: number
    }
  }
  input: {
    description: string
    remoteDirectoryTemplate: string
    fileName: string
    launchValue: 'input_file' | 'input_directory'
  }
  launch: {
    description: string
    action?: string
    supportsTaskId: boolean
    supportsAutoRun: boolean
    requiresUiInteraction: boolean
  }
  output: {
    description: string
    remoteDirectoryTemplate: string
    filePattern: string
    fixedFileName?: string
  }
  progress: { mode: 'structured_log' | 'logcat_pattern'; description: string; logTag: string }
  completion: { mode: 'result_json' | 'marker_file'; description: string; remotePathTemplate: string }
  failure: { description: string }
  result: { apkGeneratesResultJson: boolean; description: string; remotePathTemplate?: string }
  cancellation: { mode: 'force_stop'; description: string }
}

export interface Artifact {
  id: string
  kind: ArtifactKind
  name: string
  sizeBytes: number
  mimeType: string
  sha256?: string
  packageName?: string
  protocol?: ApkExecutionProtocol
  previewUrl?: string
}

export type VideoAsset = Artifact & {
  kind: 'video'
  previewUrl: string
  durationMs?: number
}

export type ApkAsset = Artifact & {
  kind: 'apk'
}

export interface DeviceProfile {
  id: string
  platform: DevicePlatform
  name: string
  manufacturer: string
  osVersion: string
  apiLevel: number
  architecture: string
  executionMode: 'simulated' | 'adb' | 'xctest' | 'hdc'
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
  /** Stable Android hardware identity when the backend could verify it. */
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
}

export interface CheckResult {
  key: string
  name: string
  status: CheckStatus
  durationMs?: number
  message?: string
}

export type CheckDefinition = Omit<CheckResult, 'status'>

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


export interface VideoRunAttempt {
  id: string
  videoRunResultId: string
  attemptNumber: number
  status: DeviceRunStatus
  failureCode?: string
  failureMessage?: string
  startedAt?: string
  finishedAt?: string
  createdAt: string
}

export interface VideoRunResult {
  id: string
  taskId: string
  taskVideoId: string
  deviceRunId: string
  deviceId: string
  status: DeviceRunStatus
  phase?: DeviceRunPhase
  progress: number
  checks: CheckResult[]
  logs: string[]
  outputs: TestOutput[]
  primaryOutput?: TestOutput
  attempts: VideoRunAttempt[]
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
  /** 按视频下载该结果最新 Attempt 的 logcat；尚未执行的视频没有该地址。 */
  logcatUrl?: string
  /** 按视频查看该结果最新 Attempt 的最终截图；尚未执行的视频没有该地址。 */
  screenshotUrl?: string
}

export interface DeviceRunResult {
  id?: string
  deviceId: string
  status: DeviceRunStatus
  phase?: DeviceRunPhase
  progress: number
  checks: CheckResult[]
  logs: string[]
  outputs: TestOutput[]
  startedAt?: string
  finishedAt?: string
  mode: '模拟结果' | 'ADB 真机'
  adapter?: 'DemoPlaybackAdapter' | 'RealSdkAdapter' | string
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

export interface TestTask {
  id: string
  platform: DevicePlatform
  name: string
  /** 兼容旧的浏览器 Mock 任务，因此 APK 允许为空。 */
  apk?: Artifact
  asset: Artifact
  videos?: Array<{
    id: string
    taskId: string
    artifactId: string
    sequence: number
    displayName: string
    asset: Artifact
  }>
  deviceIds: string[]
  connectionMode?: TaskConnectionMode
  status: TestTaskStatus
  progress: number
  passRate?: number
  createdAt: string
  runs: Record<string, DeviceRunResult>
  videoRuns?: Record<string, Record<string, VideoRunResult>>
  capabilities: TaskCapabilities
}

export interface TestReport extends TestTask {
  conclusion: 'passed' | 'failed' | 'blocked' | 'cancelled' | 'not_executed'
  generatedAt: string
  output?: TestOutput
}

/** 真实 HTTP API 创建任务时只传已经上传完成的文件 ID。 */
export interface CreateTaskInput {
  name: string
  platform: 'android'
  apkArtifactId: string
  /** Legacy single-video field accepted by older clients. */
  videoArtifactId?: string
  /** Ordered video IDs used by new multi-video tasks. */
  videoArtifactIds?: string[]
  deviceIds: string[]
  connectionMode?: TaskConnectionMode
  testPlan: {
    type: 'sdk-video-processing-compatibility'
    timeoutSeconds: number
  }
}

/** Mock Runner 使用的内部输入，不会发送给后端。 */
export interface MockCreateTaskInput {
  name: string
  apk: ApkAsset
  asset: VideoAsset
  assets?: VideoAsset[]
  deviceIds: string[]
  connectionMode: TaskConnectionMode
  executions: Array<{
    deviceId: string
    endpointId: string
    connectionKind: DeviceConnectionKind
    adbSerial: string
  }>
}

export type TaskUpdateListener = (task: TestTask) => void

export interface TestRunner {
  createTask(input: MockCreateTaskInput): Promise<TestTask>
  getTask(taskId: string): Promise<TestTask | undefined>
  subscribeTask(taskId: string, listener: TaskUpdateListener): () => void
  getReport(taskId: string): Promise<TestReport | undefined>
  cancelTask(taskId: string): Promise<void>
}

export interface TestPlatformClient {
  readonly mode: 'mock' | 'real'
  listDevices(): Promise<DeviceProfile[]>
  refreshDevices(): Promise<DeviceProfile[]>
  discoverDevices(): Promise<DeviceDiscoveryCandidate[]>
  discoverNetworkDevices(): Promise<DeviceDiscoveryCandidate[]>
  connectNetworkDevice(deviceId: string, host: string, port: number): Promise<DeviceEndpoint>
  disconnectNetworkDevice(deviceId: string, endpointId: string): Promise<DeviceEndpoint>
  refreshNetworkDevice(deviceId: string, endpointId: string): Promise<DeviceEndpoint>
  removeNetworkDevice(deviceId: string, endpointId: string): Promise<void>
  startNetworkConnectionOperation(): Promise<NetworkConnectionOperationStart>
  getNetworkConnectionOperation(operationId: string): Promise<NetworkConnectionOperation>
  cancelNetworkConnectionOperation(operationId: string): Promise<NetworkConnectionOperation>
  registerDevice(serial: string): Promise<DeviceProfile>
  uploadArtifact(file: File, kind: ArtifactKind): Promise<Artifact>
  createTask(input: CreateTaskInput): Promise<TestTask>
  listTasks(): Promise<TestTask[]>
  getTask(taskId: string): Promise<TestTask | undefined>
  subscribeTask(taskId: string, listener: TaskUpdateListener): () => void
  getReport(taskId: string): Promise<TestReport | undefined>
  cancelTask(taskId: string): Promise<void>
  deleteTask(taskId: string): Promise<TaskDeletionReceipt>
}
