import type { DeviceConnectionKind, DevicePlatform, RunStatus, TaskStatus } from '../types.js'

export interface DeviceRunJob {
  taskId: string
  runId: string
  deviceId: string
}

export interface VideoRunExecution {
  videoRunResultId: string
  taskVideoId: string
  artifactId: string
  sequence: number
  displayName: string
  videoPath: string
  videoOriginalName: string
  runStatus: RunStatus
}

export interface DeviceRunExecution extends DeviceRunJob {
  deviceSerial: string
  deviceName: string
  endpointId?: string
  connectionKind?: DeviceConnectionKind
  platform: DevicePlatform
  apkPath: string
  apkPackageName?: string
  /** Ordered by TaskVideo.sequence. */
  videos: VideoRunExecution[]
  /** Compatibility aliases for legacy single-video callers. */
  videoPath: string
  videoOriginalName: string
  timeoutSeconds: number
  taskStatus: TaskStatus
  runStatus: RunStatus
}
