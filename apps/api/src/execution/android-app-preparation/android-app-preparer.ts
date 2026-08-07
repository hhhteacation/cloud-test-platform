import { buildWarmupLaunchArguments } from '../../apk-protocols.js'
import { config } from '../../config.js'
import { AdbDeviceClient } from '../adb-client.js'
import { AdbStreams } from '../adb-streams.js'
import { TaskExecutionError } from '../execution-errors.js'
import { delay } from '../file-utils.js'
import { TaskProcessRegistry } from '../process-registry.js'
import { ApkInstallCoordinator } from './apk-install-coordinator.js'
import type {
  AndroidAppPreparer,
  AndroidAppPreparationReceipt,
  AndroidAppPreparationRequest,
  AndroidPreparationDeviceFactory,
  DiagnosticScreenshotCapture,
} from './contracts.js'
import { AndroidDeviceReadiness } from './device-readiness.js'
import { PostLaunchDialogCoordinator } from './post-launch-dialog-coordinator.js'
import { RuntimePermissionDialogCoordinator } from './runtime-permission-dialog-coordinator.js'
import { RuntimePermissionManager } from './runtime-permissions.js'
import { SystemDialogController } from './system-dialog-controller.js'

export interface DefaultAndroidAppPreparerDependencies {
  createDevice?: AndroidPreparationDeviceFactory
  captureScreenshot?: DiagnosticScreenshotCapture
}

function applicationLabel(packageName: string) {
  if (packageName === 'com.morphoinc.videopostprocessor') return 'Morpho VideoStabilizer'
  return packageName
}

function permissionLabel(permission: string) {
  if (permission === 'android.permission.CAMERA') return '相机权限'
  if (permission === 'android.permission.RECORD_AUDIO') return '录音权限'
  return permission
}

/**
 * Deep Android-only module: readiness, clean install, OEM dialog handling,
 * runtime permissions and the optional warmup launch are kept behind one call.
 */
export class DefaultAndroidAppPreparer implements AndroidAppPreparer {
  constructor(private readonly dependencies: DefaultAndroidAppPreparerDependencies = {}) {}

  async prepareApplication(
    request: AndroidAppPreparationRequest,
  ): Promise<AndroidAppPreparationReceipt> {
    const device = this.dependencies.createDevice?.(request.deviceSerial)
      ?? new AdbDeviceClient(config.adbPath, request.deviceSerial)
    const captureScreenshot = this.dependencies.captureScreenshot
      ?? this.createScreenshotCapture(request.deviceSerial)
    const dialogs = new SystemDialogController(device, captureScreenshot)
    const readiness = new AndroidDeviceReadiness(device)
    const installer = new ApkInstallCoordinator(device, dialogs)
    const permissions = new RuntimePermissionManager(device)
    const permissionDialogs = new RuntimePermissionDialogCoordinator(permissions, dialogs)
    const postLaunchDialogs = new PostLaunchDialogCoordinator(dialogs)

    const readinessObservation = await readiness.prepare(request.signal)
    if (readinessObservation.condition !== 'ready') {
      request.onEvent({
        phase: 'installing_apk',
        progress: 10,
        message: `DEVICE_READINESS condition=${readinessObservation.condition} evidence=${readinessObservation.summary} phase=before_install`,
      })
    }

    const installStartedAt = Date.now()
    const handledDialogs = await installer.install({
      packageName: request.protocol.packageName,
      applicationLabel: applicationLabel(request.protocol.packageName),
      apkPath: request.apkPath,
      installMode: request.protocol.install.mode,
      manufacturer: request.deviceManufacturer,
      deviceModel: request.deviceModel,
      diagnosticsDirectory: request.diagnosticsDirectory,
      automation: request.protocol.install.dialogAutomation,
      signal: request.signal,
      onEvent: request.onEvent,
    })

    if (!await device.isPackageInstalled(request.protocol.packageName, request.signal)) {
      throw new TaskExecutionError('ADB 安装命令已结束，但系统中未找到目标 APK', 'APK_INSTALL_FAILED')
    }
    const installMs = Date.now() - installStartedAt
    request.onEvent({ phase: 'installing_apk', progress: 18, message: 'APK 安装完成并已验证包名' })

    if (request.protocol.requiresRunAs) {
      try {
        await device.run(
          ['shell', 'run-as', request.protocol.packageName, 'id'],
          request.signal,
          15_000,
          'INVALID_TEST_APK',
        )
      } catch {
        throw new TaskExecutionError('当前测试载体协议要求 APK 支持 debug/run-as', 'INVALID_TEST_APK')
      }
    }

    const permissionStartedAt = Date.now()
    const requestedPermissions = request.protocol.install.runtimePermissions ?? []
    const permissionPreparation = await permissions.grantAndVerify(
      request.protocol.packageName,
      requestedPermissions,
      request.signal,
      (permission, state) => request.onEvent({
        phase: 'granting_permissions',
        progress: state === 'granting' ? 19 : 20,
        message: state === 'granting'
          ? `正在授予${permissionLabel(permission)}`
          : `${permissionLabel(permission)}验证通过`,
      }),
    )
    let grantedPermissions = permissionPreparation.grantedPermissions

    const warmupArguments = buildWarmupLaunchArguments(request.protocol)
    if (warmupArguments) {
      if (permissionPreparation.mode === 'ui-required') {
        request.onEvent({
          phase: 'granting_permissions',
          progress: 20,
          message: 'ADB 直接授权被设备系统拒绝，切换到严格权限弹窗兜底',
        })
      }
      request.onEvent({
        phase: 'launching_app',
        progress: 21,
        message: permissionPreparation.mode === 'ui-required'
          ? '正在启动 MainActivity 请求运行时权限'
          : '正在启动 MainActivity 初始化应用数据目录',
      })
      await device.run(warmupArguments, request.signal, 30_000, 'APP_LAUNCH_FAILED')
      await delay(request.protocol.launch.warmupBeforeTransferMs ?? 0, request.signal)

      const automation = request.protocol.install.dialogAutomation
      if (permissionPreparation.mode === 'ui-required') {
        if (!automation) {
          throw new TaskExecutionError(
            '设备禁止 ADB 直接授权，但当前 APK 协议没有配置权限弹窗自动化',
            'RUNTIME_PERMISSION_GRANT_FAILED',
          )
        }
        const runtimeDialogs = await permissionDialogs.waitUntilGranted({
          manufacturer: request.deviceManufacturer,
          packageName: request.protocol.packageName,
          applicationLabel: applicationLabel(request.protocol.packageName),
          permissions: requestedPermissions,
          diagnosticsDirectory: request.diagnosticsDirectory,
          automation,
          signal: request.signal,
          onEvent: request.onEvent,
        })
        handledDialogs.push(...runtimeDialogs)
        grantedPermissions = await permissions.verifyAll(
          request.protocol.packageName,
          requestedPermissions,
          request.signal,
        )
        for (const permission of requestedPermissions) {
          request.onEvent({
            phase: 'granting_permissions',
            progress: 23,
            message: `${permissionLabel(permission)}验证通过`,
          })
        }
      } else if (automation?.mode === 'strict-whitelist'
        && automation.profileIds.includes('android-runtime-permission-v1')) {
        const runtimeDialog = await dialogs.inspectAndHandle({
          manufacturer: request.deviceManufacturer,
          packageName: request.protocol.packageName,
          applicationLabel: applicationLabel(request.protocol.packageName),
          profileIds: ['android-runtime-permission-v1'],
          diagnosticsDirectory: request.diagnosticsDirectory,
          maxActions: automation.maxActions,
          signal: request.signal,
        })
        if (runtimeDialog.kind === 'handled') {
          handledDialogs.push(runtimeDialog.dialog)
          request.onEvent({
            phase: 'granting_permissions',
            progress: 22,
            message: `厂商系统仍显示权限弹窗，已通过 ${runtimeDialog.dialog.profileId} 自动处理`,
          })
          await delay(300, request.signal)
          await permissions.verifyAll(request.protocol.packageName, requestedPermissions, request.signal)
        }
      }

      const launchDialogs = await postLaunchDialogs.handleOptionalDialog({
        manufacturer: request.deviceManufacturer,
        packageName: request.protocol.packageName,
        applicationLabel: applicationLabel(request.protocol.packageName),
        diagnosticsDirectory: request.diagnosticsDirectory,
        automation: request.protocol.launch.postLaunchDialogAutomation,
        signal: request.signal,
        onEvent: request.onEvent,
      })
      handledDialogs.push(...launchDialogs)
    } else if (permissionPreparation.mode === 'ui-required') {
      throw new TaskExecutionError(
        '设备禁止 ADB 直接授权，但当前 APK 协议没有可用于触发权限弹窗的启动入口',
        'RUNTIME_PERMISSION_GRANT_FAILED',
      )
    }

    return {
      packageName: request.protocol.packageName,
      cleanInstalled: request.protocol.install.mode === 'clean',
      grantedPermissions,
      handledDialogs,
      timings: {
        installMs,
        permissionMs: Date.now() - permissionStartedAt,
      },
    }
  }

  private createScreenshotCapture(serial: string): DiagnosticScreenshotCapture {
    const streams = new AdbStreams(config.adbPath, serial, new TaskProcessRegistry())
    return (targetPath, signal) => streams.captureScreenshot('android-app-preparation', targetPath, signal)
  }
}
