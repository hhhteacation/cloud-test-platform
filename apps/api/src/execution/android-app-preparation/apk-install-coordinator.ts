import { buildInstallPlan, type ApkDialogAutomationConfig } from '../../apk-protocols.js'
import { TaskExecutionError } from '../execution-errors.js'
import { delay } from '../file-utils.js'
import { createDialogInteractionState } from './contracts.js'
import type {
  AndroidPreparationDevice,
  HandledDialog,
  PreparationEvent,
} from './contracts.js'
import { DialogProgressTracker } from './dialog-progress.js'
import { SystemDialogController, type DialogInspectionOptions } from './system-dialog-controller.js'

interface InstallRequest {
  packageName: string
  applicationLabel: string
  apkPath: string
  installMode: 'replace' | 'clean'
  manufacturer: string
  deviceModel?: string
  diagnosticsDirectory: string
  automation?: ApkDialogAutomationConfig
  signal: AbortSignal
  onEvent: (event: PreparationEvent) => void
}

interface InstallOutcome {
  ok: boolean
  error?: unknown
}

function linkAbortSignal(source: AbortSignal, target: AbortController) {
  const abort = () => target.abort(source.reason)
  source.addEventListener('abort', abort, { once: true })
  if (source.aborted) abort()
  return () => source.removeEventListener('abort', abort)
}

function explainInstallFailure(error: unknown) {
  if (error instanceof TaskExecutionError) {
    if (/INSTALL_FAILED_ABORTED:\s*User rejected permissions/i.test(error.message)) {
      return new TaskExecutionError(
        `设备拒绝了 APK 安装，且严格白名单自动化未能完成确认。原始错误：${error.message}`,
        'APK_INSTALL_FAILED',
      )
    }
    return error
  }
  return new TaskExecutionError(
    error instanceof Error ? error.message : String(error),
    'APK_INSTALL_FAILED',
  )
}

export class ApkInstallCoordinator {
  constructor(
    private readonly device: AndroidPreparationDevice,
    private readonly dialogs: SystemDialogController,
  ) {}

  async install(request: InstallRequest) {
    const installPlan = buildInstallPlan({
      packageName: request.packageName,
      install: { mode: request.installMode, description: '' },
    }, request.apkPath)

    if (installPlan.uninstallPackage) {
      const installed = await this.device.isPackageInstalled(installPlan.uninstallPackage, request.signal)
      if (installed) {
        request.onEvent({
          phase: 'installing_apk',
          progress: 12,
          message: '正在干净卸载旧版本 APK 和旧应用数据',
        })
        await this.device.run(
          ['uninstall', installPlan.uninstallPackage],
          request.signal,
          60_000,
          'APK_INSTALL_FAILED',
        )
      } else {
        request.onEvent({
          phase: 'installing_apk',
          progress: 12,
          message: '设备上没有旧版本 APK，跳过卸载',
        })
      }
    }

    request.onEvent({
      phase: 'installing_apk',
      progress: 15,
      message: `正在安装 ${request.packageName}`,
    })

    if (!request.automation || request.automation.mode === 'none') {
      try {
        await this.device.run(
          installPlan.installArguments,
          request.signal,
          120_000,
          'APK_INSTALL_FAILED',
        )
      } catch (error) {
        throw explainInstallFailure(error)
      }
      return []
    }

    return this.installWithDialogMonitoring(request, installPlan.installArguments, request.automation)
  }

  private async installWithDialogMonitoring(
    request: InstallRequest,
    installArguments: string[],
    automation: ApkDialogAutomationConfig,
  ) {
    const installController = new AbortController()
    const unlinkAbort = linkAbortSignal(request.signal, installController)
    const handledDialogs: HandledDialog[] = []
    const interactionState = createDialogInteractionState()
    const dialogProgress = new DialogProgressTracker()
    const unrecognizedGraceMs = automation.unrecognizedGraceMs ?? 15_000

    const installOutcome = this.device.run(
      installArguments,
      installController.signal,
      automation.timeoutMs + 10_000,
      'APK_INSTALL_FAILED',
    ).then<InstallOutcome>(() => ({ ok: true })).catch<InstallOutcome>((error) => ({ ok: false, error }))

    const inspectionOptions: DialogInspectionOptions = {
      manufacturer: request.manufacturer,
      deviceModel: request.deviceModel,
      packageName: request.packageName,
      applicationLabel: request.applicationLabel,
      profileIds: automation.profileIds,
      diagnosticsDirectory: request.diagnosticsDirectory,
      maxActions: automation.maxActions,
      signal: installController.signal,
      phase: 'install',
    }

    const acceptRecognizedInspection = (
      inspection: Awaited<ReturnType<SystemDialogController['inspectAndHandle']>>,
    ) => {
      if (inspection.kind === 'handled') {
        dialogProgress.reset()
        handledDialogs.push(inspection.dialog)
        request.onEvent({
          phase: 'handling_install_dialog',
          progress: 17,
          message: `已通过严格白名单 ${inspection.dialog.profileId} 自动执行 ${inspection.dialog.action}`,
        })
        return true
      }
      if (inspection.kind === 'manual-action-required') {
        dialogProgress.reset()
        request.onEvent({
          phase: 'handling_install_dialog',
          progress: 17,
          message: inspection.block.summary,
        })
        installController.abort()
        throw new TaskExecutionError(inspection.block.summary, 'INSTALL_USER_ACTION_REQUIRED')
      }
      if (inspection.kind === 'waiting') {
        request.onEvent({
          phase: 'handling_install_dialog',
          progress: 17,
          message: '上一次安装器动作尚未观察到页面迁移，等待下一次状态观察',
        })
      }
      return false
    }

    const startedAt = Date.now()
    try {
      while (Date.now() - startedAt < automation.timeoutMs) {
        const outcome = await Promise.race([
          installOutcome,
          delay(automation.pollIntervalMs, installController.signal).then(() => undefined),
        ])
        if (outcome) {
          if (!outcome.ok) throw explainInstallFailure(outcome.error)
          return handledDialogs
        }

        const inspection = await this.dialogs.inspectAndHandle(inspectionOptions, interactionState)
        if (acceptRecognizedInspection(inspection)) continue

        if (inspection.kind === 'unrecognized' || inspection.kind === 'waiting') {
          const progress = dialogProgress.observe(inspection)
          if (progress.changed) {
            request.onEvent({
              phase: 'handling_install_dialog',
              progress: 16,
              message: inspection.kind === 'waiting'
                ? '上一次安装器动作尚未观察到页面迁移，等待严格白名单特征稳定'
                : '安装器界面仍在加载或安全扫描，等待严格白名单特征稳定',
            })
          }
          if (progress.elapsedMs >= unrecognizedGraceMs) {
            // The timeout diagnostics used to capture a newer frame after the
            // unrecognized decision. On slowly rendering OEM installers this
            // could save a fully recognizable page while still reporting the
            // stale frame as INSTALL_DIALOG_UNRECOGNIZED. Reclassify once at
            // the boundary before committing to the failure.
            const finalInspection = await this.dialogs.inspectAndHandle(inspectionOptions, interactionState)
            if (acceptRecognizedInspection(finalInspection)) continue
            if (finalInspection.kind === 'none') {
              dialogProgress.reset()
              continue
            }
            if (finalInspection.kind === 'unrecognized' || finalInspection.kind === 'waiting') {
              const finalProgress = dialogProgress.observe(finalInspection)
              if (finalProgress.changed) continue
            }

            await this.dialogs.saveTimeoutDiagnostics(inspectionOptions)
            installController.abort()
            throw new TaskExecutionError(
              '检测到安装器窗口，但界面未满足任何严格白名单 Profile，平台拒绝自动点击',
              'INSTALL_DIALOG_UNRECOGNIZED',
            )
          }
        } else {
          dialogProgress.reset()
        }
      }

      await this.dialogs.saveTimeoutDiagnostics(inspectionOptions)
      installController.abort()
      throw new TaskExecutionError(
        `等待 APK 安装或安全确认超过 ${Math.round(automation.timeoutMs / 1000)} 秒`,
        'INSTALL_DIALOG_TIMEOUT',
      )
    } finally {
      installController.abort()
      unlinkAbort()
    }
  }
}
