import type { ApkDialogAutomationConfig } from '../../apk-protocols.js'
import { TaskExecutionError } from '../execution-errors.js'
import { delay } from '../file-utils.js'
import type { HandledDialog, PreparationEvent } from './contracts.js'
import { hasDialogObservationProfileForManufacturer } from './dialog-profiles.js'
import { DialogPhaseStateMachine } from './dialog-phase-state-machine.js'
import type { SystemDialogController } from './system-dialog-controller.js'

interface PostLaunchDialogRequest {
  manufacturer: string
  packageName: string
  applicationLabel: string
  diagnosticsDirectory: string
  automation?: ApkDialogAutomationConfig
  signal: AbortSignal
  onEvent: (event: PreparationEvent) => void
}

type PostLaunchDialogInspector = Pick<
  SystemDialogController,
  'inspectAndHandle' | 'saveTimeoutDiagnostics'
>

function postLaunchDialogOptions(
  request: PostLaunchDialogRequest,
  automation: ApkDialogAutomationConfig,
) {
  return {
    manufacturer: request.manufacturer,
    packageName: request.packageName,
    applicationLabel: request.applicationLabel,
    phase: 'post-launch' as const,
    profileIds: automation.profileIds,
    diagnosticsDirectory: request.diagnosticsDirectory,
    maxActions: automation.maxActions,
    signal: request.signal,
  }
}

function stablePostLaunchFailure(inspection: { kind: 'unrecognized' | 'waiting' }) {
  if (inspection.kind === 'waiting') {
    return new TaskExecutionError(
      '已执行应用启动后弹窗白名单操作，但界面在宽限期内没有发生可验证迁移',
      'POST_LAUNCH_DIALOG_TIMEOUT',
    )
  }

  return new TaskExecutionError(
    '检测到应用启动后的系统提示，但界面未满足严格白名单，平台拒绝自动点击',
    'POST_LAUNCH_DIALOG_UNRECOGNIZED',
  )
}

/**
 * Handles protocol-declared, optional system compatibility notices that can
 * appear after the app's warmup launch. It does not grant permissions, change
 * global settings or accept generic confirmation buttons.
 */
export class PostLaunchDialogCoordinator {
  constructor(private readonly dialogs: PostLaunchDialogInspector) {}

  async handleOptionalDialog(request: PostLaunchDialogRequest): Promise<HandledDialog[]> {
    const automation = request.automation
    if (!automation || automation.mode !== 'strict-whitelist') return []
    if (!hasDialogObservationProfileForManufacturer(
      automation.profileIds,
      request.manufacturer,
      'post-launch',
    )) return []

    const options = postLaunchDialogOptions(request, automation)
    const startedAt = Date.now()
    const unknownGraceMs = automation.unrecognizedGraceMs ?? 1_500
    const dialogPhase = new DialogPhaseStateMachine({
      phase: 'post-launch',
      stalledAfterMs: unknownGraceMs,
    })

    try {
      while (Date.now() - startedAt < automation.timeoutMs) {
        const inspection = await this.dialogs.inspectAndHandle(
          options,
          dialogPhase.interactionState(),
        )
        const observation = dialogPhase.observe(inspection)

        if (inspection.kind === 'none') {
          if (observation.transitionVerified) return dialogPhase.handledDialogs()
        } else if (inspection.kind === 'handled') {
          request.onEvent({
            phase: 'handling_app_dialog',
            progress: 24,
            message: `已通过 ${inspection.dialog.profileId} 自动关闭应用启动兼容提示，正在验证页面迁移`,
          })
        } else if (inspection.kind === 'manual-action-required') {
          request.onEvent({
            phase: 'handling_app_dialog',
            progress: 24,
            message: inspection.block.summary,
          })
          // The current block Profile represents an unfinished install
          // authorization. Preserve the business cause even when it remains
          // visible after launch instead of relabeling it as a post-launch issue.
          throw new TaskExecutionError(
            inspection.block.summary,
            'INSTALL_USER_ACTION_REQUIRED',
          )
        } else if (observation.stable) {
          await this.dialogs.saveTimeoutDiagnostics(options)
          throw stablePostLaunchFailure(inspection)
        }

        await delay(automation.pollIntervalMs, request.signal)
      }

      // The notice is optional only when every observation reported no known
      // system dialog. Once the state machine observes a dialog or action,
      // leaving the phase without a verified transition would leak unresolved
      // UI state into the protocol executor.
      if (dialogPhase.state() === 'observing') {
        dialogPhase.complete()
        return []
      }

      await this.dialogs.saveTimeoutDiagnostics(options)
      dialogPhase.markTimeout()
      throw new TaskExecutionError(
        '应用启动后的系统提示在协议时限内没有完成可验证迁移',
        'POST_LAUNCH_DIALOG_TIMEOUT',
      )
    } catch (error) {
      if (request.signal.aborted) dialogPhase.cancel()
      else if (dialogPhase.state() === 'observing') dialogPhase.fail()
      throw error
    }
  }
}
