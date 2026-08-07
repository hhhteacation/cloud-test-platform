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

/**
 * Per-phase interaction history. The coordinator that owns a business phase
 * creates and scopes this state; dialog inspection must not retain it
 * implicitly across install, permission, or post-launch phases.
 *
 * The mutable representation stays behind this small seam so callers cannot
 * accidentally reset or increment controller state themselves.
 */
export class DialogInteractionState {
  private readonly clickedActionFingerprints = new Set<string>()
  private actionCount = 0

  canPerformAction(maxActions: number) {
    return this.actionCount < maxActions
  }

  hasSeenAction(fingerprint: string) {
    return this.clickedActionFingerprints.has(fingerprint)
  }

  recordAction(fingerprint: string) {
    this.clickedActionFingerprints.add(fingerprint)
    this.actionCount += 1
  }
}

export function createDialogInteractionState() {
  return new DialogInteractionState()
}

export interface AndroidAppPreparationReceipt {
  packageName: string
  cleanInstalled: boolean
  grantedPermissions: string[]
  handledDialogs: HandledDialog[]
  timings: {
    installMs: number
    permissionMs: number
  }
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
