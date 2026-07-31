import type { ApkDialogAutomationConfig } from '../../apk-protocols.js'
import { TaskExecutionError } from '../execution-errors.js'
import { delay } from '../file-utils.js'
import type { HandledDialog, PreparationEvent } from './contracts.js'
import { RuntimePermissionManager } from './runtime-permissions.js'
import { SystemDialogController } from './system-dialog-controller.js'

interface RuntimePermissionDialogRequest {
  manufacturer: string
  packageName: string
  applicationLabel: string
  permissions: readonly string[]
  diagnosticsDirectory: string
  automation: ApkDialogAutomationConfig
  signal: AbortSignal
  onEvent: (event: PreparationEvent) => void
}

/**
 * Handles only the runtime-permission fallback after an OEM explicitly rejects
 * shell `pm grant`. It never broadens install-dialog matching or changes global
 * device settings.
 */
export class RuntimePermissionDialogCoordinator {
  constructor(
    private readonly permissions: RuntimePermissionManager,
    private readonly dialogs: SystemDialogController,
  ) {}

  async waitUntilGranted(request: RuntimePermissionDialogRequest) {
    if (request.automation.mode !== 'strict-whitelist'
      || !request.automation.profileIds.includes('android-runtime-permission-v1')) {
      throw new TaskExecutionError(
        '设备禁止 ADB 直接授权，但当前 APK 协议没有启用严格权限弹窗 Profile',
        'RUNTIME_PERMISSION_GRANT_FAILED',
      )
    }

    const handledDialogs: HandledDialog[] = []
    const startedAt = Date.now()
    const graceMs = request.automation.unrecognizedGraceMs ?? 15_000
    let unknownFingerprint: string | undefined
    let unknownSince = 0

    while (Date.now() - startedAt < request.automation.timeoutMs) {
      if (await this.permissions.areAllGranted(
        request.packageName,
        request.permissions,
        request.signal,
      )) {
        await this.permissions.verifyAll(
          request.packageName,
          request.permissions,
          request.signal,
        )
        return handledDialogs
      }

      const inspection = await this.dialogs.inspectAndHandle({
        manufacturer: request.manufacturer,
        packageName: request.packageName,
        applicationLabel: request.applicationLabel,
        profileIds: ['android-runtime-permission-v1'],
        diagnosticsDirectory: request.diagnosticsDirectory,
        maxActions: request.automation.maxActions,
        signal: request.signal,
      })

      if (inspection.kind === 'handled') {
        handledDialogs.push(inspection.dialog)
        unknownFingerprint = undefined
        unknownSince = 0
        request.onEvent({
          phase: 'granting_permissions',
          progress: 22,
          message: `已通过 ${inspection.dialog.profileId} 自动确认相机和麦克风权限`,
        })
      } else if (inspection.kind === 'unrecognized') {
        const now = Date.now()
        if (unknownFingerprint !== inspection.fingerprint) {
          unknownFingerprint = inspection.fingerprint
          unknownSince = now
        } else if (now - unknownSince >= graceMs) {
          await this.dialogs.saveTimeoutDiagnostics({
            manufacturer: request.manufacturer,
            packageName: request.packageName,
            applicationLabel: request.applicationLabel,
            profileIds: ['android-runtime-permission-v1'],
            diagnosticsDirectory: request.diagnosticsDirectory,
            maxActions: request.automation.maxActions,
            signal: request.signal,
          })
          throw new TaskExecutionError(
            '检测到权限控制器窗口，但界面未满足严格权限白名单，平台拒绝自动点击',
            'RUNTIME_PERMISSION_DIALOG_UNRECOGNIZED',
          )
        }
      } else {
        unknownFingerprint = undefined
        unknownSince = 0
      }

      await delay(request.automation.pollIntervalMs, request.signal)
    }

    await this.dialogs.saveTimeoutDiagnostics({
      manufacturer: request.manufacturer,
      packageName: request.packageName,
      applicationLabel: request.applicationLabel,
      profileIds: ['android-runtime-permission-v1'],
      diagnosticsDirectory: request.diagnosticsDirectory,
      maxActions: request.automation.maxActions,
      signal: request.signal,
    })
    throw new TaskExecutionError(
      '等待 Android 运行时权限确认超过协议时限',
      'RUNTIME_PERMISSION_DIALOG_TIMEOUT',
    )
  }
}
