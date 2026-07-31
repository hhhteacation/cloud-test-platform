import type { ProcessResult } from '../../process.js'
import type { ApkExecutionProtocol } from '../../apk-protocols.js'
import type { AdbConnectionStatus } from '../adb-client.js'

export type PreparationPhase =
  | 'installing_apk'
  | 'handling_install_dialog'
  | 'granting_permissions'
  | 'launching_app'
  | 'handling_app_dialog'

export interface PreparationEvent {
  phase: PreparationPhase
  message: string
  progress?: number
}

export interface AndroidAppPreparationRequest {
  deviceSerial: string
  deviceManufacturer: string
  deviceModel: string
  apkPath: string
  protocol: ApkExecutionProtocol
  diagnosticsDirectory: string
  signal: AbortSignal
  onEvent: (event: PreparationEvent) => void
}

export interface HandledDialog {
  profileId: string
  action: string
  timestamp: string
}

export interface AndroidAppPreparationReceipt {
  packageName: string
  cleanInstalled: boolean
  grantedPermissions: string[]
  handledDialogs: HandledDialog[]
}

export interface AndroidAppPreparer {
  prepareApplication(
    request: AndroidAppPreparationRequest,
  ): Promise<AndroidAppPreparationReceipt>
}

/** Internal seam used by the preparer and its Fake ADB tests. */
export interface AndroidPreparationDevice {
  connectionStatus(): Promise<AdbConnectionStatus>
  run(
    args: string[],
    signal: AbortSignal,
    timeoutMs?: number,
    code?: string,
  ): Promise<ProcessResult>
  isPackageInstalled(packageName: string, signal: AbortSignal): Promise<boolean>
}

export type AndroidPreparationDeviceFactory = (
  serial: string,
) => AndroidPreparationDevice

export type DiagnosticScreenshotCapture = (
  targetPath: string,
  signal: AbortSignal,
) => Promise<void>
