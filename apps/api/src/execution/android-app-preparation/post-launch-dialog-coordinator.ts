import type { ApkDialogAutomationConfig } from '../../apk-protocols.js'
import { TaskExecutionError } from '../execution-errors.js'
import { delay } from '../file-utils.js'
import type { HandledDialog, PreparationEvent } from './contracts.js'
import { hasDialogProfileForManufacturer } from './dialog-profiles.js'
import { SystemDialogController } from './system-dialog-controller.js'

interface PostLaunchDialogRequest {
  manufacturer: string
  packageName: string
  applicationLabel: string
  diagnosticsDirectory: string
  automation?: ApkDialogAutomationConfig
  signal: AbortSignal
  onEvent: (event: PreparationEvent) => void
}

/**
 * Handles protocol-declared, optional system compatibility notices that can
 * appear after the app's warmup launch. It does not grant permissions, change
 * global settings or accept generic confirmation buttons.
 */
export class PostLaunchDialogCoordinator {
  constructor(private readonly dialogs: SystemDialogController) {}

  async handleOptionalDialog(request: PostLaunchDialogRequest): Promise<HandledDialog[]> {
    const automation = request.automation
    if (!automation || automation.mode !== 'strict-whitelist') return []
    if (!hasDialogProfileForManufacturer(automation.profileIds, request.manufacturer)) return []

    const startedAt = Date.now()
    const unknownGraceMs = automation.unrecognizedGraceMs ?? 1_500
    let unknownFingerprint: string | undefined
    let unknownSince = 0

    while (Date.now() - startedAt < automation.timeoutMs) {
      const inspection = await this.dialogs.inspectAndHandle({
        manufacturer: request.manufacturer,
        packageName: request.packageName,
        applicationLabel: request.applicationLabel,
        profileIds: automation.profileIds,
        diagnosticsDirectory: request.diagnosticsDirectory,
        maxActions: automation.maxActions,
        signal: request.signal,
      })

      if (inspection.kind === 'handled') {
        request.onEvent({
          phase: 'handling_app_dialog',
          progress: 24,
          message: `已通过 ${inspection.dialog.profileId} 自动关闭应用启动兼容提示`,
        })
        return [inspection.dialog]
      }

      if (inspection.kind === 'unrecognized') {
        const now = Date.now()
        if (unknownFingerprint !== inspection.fingerprint) {
          unknownFingerprint = inspection.fingerprint
          unknownSince = now
        } else if (now - unknownSince >= unknownGraceMs) {
          await this.dialogs.saveTimeoutDiagnostics({
            manufacturer: request.manufacturer,
            packageName: request.packageName,
            applicationLabel: request.applicationLabel,
            profileIds: automation.profileIds,
            diagnosticsDirectory: request.diagnosticsDirectory,
            maxActions: automation.maxActions,
            signal: request.signal,
          })
          throw new TaskExecutionError(
            '检测到应用启动后的系统提示，但界面未满足严格白名单，平台拒绝自动点击',
            'POST_LAUNCH_DIALOG_UNRECOGNIZED',
          )
        }
      } else {
        unknownFingerprint = undefined
        unknownSince = 0
      }

      await delay(automation.pollIntervalMs, request.signal)
    }

    // This notice is optional. A timeout with no recognized/unknown dialog
    // means the device did not show it, so application preparation may continue.
    return []
  }
}
