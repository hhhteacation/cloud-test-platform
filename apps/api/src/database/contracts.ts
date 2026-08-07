import type { DeviceConnectionKind, DevicePlatform, RunStatus, TaskStatus } from '../types.js'

export interface DeviceRunJob {
  taskId: string
  runId: string
  deviceId: string
}

export interface DeviceRunExecution extends DeviceRunJob {
  deviceSerial: string
  deviceName: string
  endpointId?: string
  connectionKind?: DeviceConnectionKind
  platform: DevicePlatform
  apkPath: string
  apkPackageName?: string
  videoPath: string
  videoOriginalName: string
  timeoutSeconds: number
  taskStatus: TaskStatus
  runStatus: RunStatus
}
