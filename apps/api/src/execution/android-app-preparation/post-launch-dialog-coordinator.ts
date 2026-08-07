import type { ApkDialogAutomationConfig } from '../../apk-protocols.js'
import { TaskExecutionError } from '../execution-errors.js'
import { delay } from '../file-utils.js'
import { createDialogInteractionState } from './contracts.js'
import type { HandledDialog, PreparationEvent } from './contracts.js'
import { hasDialogObservationProfileForManufacturer } from './dialog-profiles.js'
import { DialogProgressTracker } from './dialog-progress.js'
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
    if (!hasDialogObservationProfileForManufacturer(
      automation.profileIds,
      request.manufacturer,
      'post-launch',
    )) return []

    const interactionState = createDialogInteractionState()
    const startedAt = Date.now()
    const unknownGraceMs = automation.unrecognizedGraceMs ?? 1_500
    const dialogProgress = new DialogProgressTracker()

    while (Date.now() - startedAt < automation.timeoutMs) {
      const inspection = await this.dialogs.inspectAndHandle({
        manufacturer: request.manufacturer,
        packageName: request.packageName,
        applicationLabel: request.applicationLabel,
        phase: 'post-launch',
        profileIds: automation.profileIds,
        diagnosticsDirectory: request.diagnosticsDirectory,
        maxActions: automation.maxActions,
        signal: request.signal,
      }, interactionState)

      if (inspection.kind === 'handled') {
        request.onEvent({
          phase: 'handling_app_dialog',
          progress: 24,
          message: `已通过 ${inspection.dialog.profileId} 自动关闭应用启动兼容提示`,
        })
        return [inspection.dialog]
      }

      if (inspection.kind === 'manual-action-required') {
        request.onEvent({
          phase: 'handling_app_dialog',
          progress: 24,
          message: inspection.block.summary,
        })
        throw new TaskExecutionError(
          inspection.block.summary,
          'POST_LAUNCH_DIALOG_MANUAL_ACTION_REQUIRED',
        )
      }

      if (inspection.kind === 'unrecognized' || inspection.kind === 'waiting') {
        const progress = dialogProgress.observe(inspection)
        if (progress.elapsedMs >= unknownGraceMs) {
          await this.dialogs.saveTimeoutDiagnostics({
            manufacturer: request.manufacturer,
            packageName: request.packageName,
            applicationLabel: request.applicationLabel,
        phase: 'post-launch',
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
        dialogProgress.reset()
      }

      await delay(automation.pollIntervalMs, request.signal)
    }

    // This notice is optional. A timeout with no recognized/unknown dialog
    // means the device did not show it, so application preparation may continue.
    return []
  }
}
