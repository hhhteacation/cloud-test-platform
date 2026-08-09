import type { ApkDialogAutomationConfig } from '../../apk-protocols.js'
import { TaskExecutionError } from '../execution-errors.js'
import { delay } from '../file-utils.js'
import type { HandledDialog, PreparationEvent } from './contracts.js'
import type { RuntimePermissionManager } from './runtime-permissions.js'
import { DialogPhaseStateMachine } from './dialog-phase-state-machine.js'
import type { SystemDialogController } from './system-dialog-controller.js'

interface RuntimePermissionDialogBaseRequest {
  manufacturer: string
  packageName: string
  applicationLabel: string
  diagnosticsDirectory: string
  automation: ApkDialogAutomationConfig
  signal: AbortSignal
  onEvent: (event: PreparationEvent) => void
}

interface RuntimePermissionDialogRequest extends RuntimePermissionDialogBaseRequest {
  permissions: readonly string[]
}

type RuntimePermissionVerifier = Pick<
  RuntimePermissionManager,
  'areAllGranted' | 'verifyAll'
>

type RuntimePermissionDialogInspector = Pick<
  SystemDialogController,
  'inspectAndHandle' | 'saveTimeoutDiagnostics'
>

function runtimePermissionDialogOptions(request: RuntimePermissionDialogBaseRequest) {
  return {
    manufacturer: request.manufacturer,
    packageName: request.packageName,
    applicationLabel: request.applicationLabel,
    phase: 'runtime-permission' as const,
    // The controller still gates every action by allowedPhases. Passing the
    // complete protocol set allows phase-independent block Profiles to classify
    // a known unsafe page without enabling install actions in this phase.
    profileIds: request.automation.profileIds,
    diagnosticsDirectory: request.diagnosticsDirectory,
    maxActions: request.automation.maxActions,
    signal: request.signal,
  }
}

function manualActionFailure(summary: string) {
  // The currently supported block Profile represents an unfinished install
  // authorization. Preserve that business cause even if the page is observed
  // later by the runtime-permission coordinator.
  return new TaskExecutionError(summary, 'INSTALL_USER_ACTION_REQUIRED')
}

function stableDialogFailure(
  inspection: { kind: 'unrecognized' | 'waiting' },
  residual: boolean,
) {
  if (inspection.kind === 'waiting') {
    return new TaskExecutionError(
      residual
        ? '已执行残留权限弹窗白名单操作，但界面在宽限期内没有发生可验证迁移'
        : '已执行权限弹窗白名单操作，但界面在宽限期内没有发生可验证迁移',
      'RUNTIME_PERMISSION_DIALOG_TIMEOUT',
    )
  }

  return new TaskExecutionError(
    residual
      ? '检测到残留权限控制器窗口，但界面未满足严格权限白名单，平台拒绝忽略或自动点击'
      : '检测到权限控制器窗口，但界面未满足严格权限白名单，平台拒绝自动点击',
    'RUNTIME_PERMISSION_DIALOG_UNRECOGNIZED',
  )
}

/**
 * Handles only the runtime-permission fallback after an OEM explicitly rejects
 * shell `pm grant`. It never broadens install-dialog matching or changes global
 * device settings.
 */
export class RuntimePermissionDialogCoordinator {
  constructor(
    private readonly permissions: RuntimePermissionVerifier,
    private readonly dialogs: RuntimePermissionDialogInspector,
  ) {}

  /**
   * Handles a residual permission-controller window after ADB verification has
   * already succeeded. A single observation is not enough to conclude that
   * the window is safe to ignore: an unrecognized or waiting observation must
   * remain in the permission-dialog state machine and either settle, disappear,
   * or produce a permission-specific failure.
   */
  async handleResidualDialog(request: RuntimePermissionDialogBaseRequest) {
    if (request.automation.mode !== 'strict-whitelist'
      || !request.automation.profileIds.includes('android-runtime-permission-v1')) {
      return [] as HandledDialog[]
    }

    const startedAt = Date.now()
    const graceMs = request.automation.unrecognizedGraceMs ?? 15_000
    const dialogPhase = new DialogPhaseStateMachine({
      phase: 'runtime-permission',
      stalledAfterMs: graceMs,
    })
    const observationBudgetMs = Math.max(
      request.automation.pollIntervalMs,
      Math.min(request.automation.timeoutMs, Math.max(graceMs, request.automation.pollIntervalMs)),
    )

    try {
      while (Date.now() - startedAt < observationBudgetMs) {
        const inspection = await this.dialogs.inspectAndHandle(
          runtimePermissionDialogOptions(request),
          dialogPhase.interactionState(),
        )

        const observation = dialogPhase.observe(inspection)
        if (inspection.kind === 'none') {
          dialogPhase.complete()
          return dialogPhase.handledDialogs()
        }

        if (inspection.kind === 'handled') {
          request.onEvent({
            phase: 'granting_permissions',
            progress: 22,
            message: `已通过 ${inspection.dialog.profileId} 自动处理残留权限弹窗，正在验证页面迁移`,
          })
        } else if (inspection.kind === 'manual-action-required') {
          request.onEvent({
            phase: 'granting_permissions',
            progress: 22,
            message: inspection.block.summary,
          })
          throw manualActionFailure(inspection.block.summary)
        } else if (observation.stable) {
          await this.dialogs.saveTimeoutDiagnostics(
            runtimePermissionDialogOptions(request),
          )
          throw stableDialogFailure(inspection, true)
        }

        await delay(request.automation.pollIntervalMs, request.signal)
      }

      await this.dialogs.saveTimeoutDiagnostics(
        runtimePermissionDialogOptions(request),
      )
      dialogPhase.markTimeout()
      throw new TaskExecutionError(
        '等待残留 Android 权限弹窗消失超过协议时限',
        'RUNTIME_PERMISSION_DIALOG_TIMEOUT',
      )
    } catch (error) {
      if (request.signal.aborted) dialogPhase.cancel()
      else if (dialogPhase.state() === 'observing') dialogPhase.fail()
      throw error
    }
  }

  async waitUntilGranted(request: RuntimePermissionDialogRequest) {
    if (request.automation.mode !== 'strict-whitelist'
      || !request.automation.profileIds.includes('android-runtime-permission-v1')) {
      throw new TaskExecutionError(
        '设备禁止 ADB 直接授权，但当前 APK 协议没有启用严格权限弹窗 Profile',
        'RUNTIME_PERMISSION_GRANT_FAILED',
      )
    }

    const startedAt = Date.now()
    const graceMs = request.automation.unrecognizedGraceMs ?? 15_000
    const dialogPhase = new DialogPhaseStateMachine({
      phase: 'runtime-permission',
      stalledAfterMs: graceMs,
    })

    try {
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
          dialogPhase.complete()
          return dialogPhase.handledDialogs()
        }

        const inspection = await this.dialogs.inspectAndHandle(
          runtimePermissionDialogOptions(request),
          dialogPhase.interactionState(),
        )
        const observation = dialogPhase.observe(inspection)

        if (inspection.kind === 'handled') {
          request.onEvent({
            phase: 'granting_permissions',
            progress: 22,
            message: `已通过 ${inspection.dialog.profileId} 自动确认相机和麦克风权限`,
          })
        } else if (inspection.kind === 'manual-action-required') {
          request.onEvent({
            phase: 'granting_permissions',
            progress: 22,
            message: inspection.block.summary,
          })
          throw manualActionFailure(inspection.block.summary)
        } else if ((inspection.kind === 'unrecognized' || inspection.kind === 'waiting')
          && observation.stable) {
          await this.dialogs.saveTimeoutDiagnostics(
            runtimePermissionDialogOptions(request),
          )
          throw stableDialogFailure(inspection, false)
        }

        await delay(request.automation.pollIntervalMs, request.signal)
      }

      await this.dialogs.saveTimeoutDiagnostics(
        runtimePermissionDialogOptions(request),
      )
      dialogPhase.markTimeout()
      throw new TaskExecutionError(
        '等待 Android 运行时权限确认超过协议时限',
        'RUNTIME_PERMISSION_DIALOG_TIMEOUT',
      )
    } catch (error) {
      if (request.signal.aborted) dialogPhase.cancel()
      else if (dialogPhase.state() === 'observing') dialogPhase.fail()
      throw error
    }
  }
}
