import { TaskExecutionError } from '../execution-errors.js'
import type { AndroidPreparationDevice } from './contracts.js'

type RuntimePermissionState = 'granted' | 'denied' | 'unknown'

export type RuntimePermissionPreparationResult =
  | {
      mode: 'adb'
      grantedPermissions: string[]
      pendingPermissions: []
    }
  | {
      mode: 'ui-required'
      grantedPermissions: string[]
      pendingPermissions: string[]
      adbFailureMessage: string
    }

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Only this explicit OEM shell-policy failure may fall back to a system
 * permission dialog. Transport errors, invalid packages and ordinary grant
 * failures must remain hard failures.
 */
export function isOemRuntimeGrantRestriction(error: unknown) {
  if (!(error instanceof TaskExecutionError)) return false
  if (error.code !== 'RUNTIME_PERMISSION_GRANT_FAILED') return false
  return /SecurityException/i.test(error.message)
    && /grantRuntimePermission/i.test(error.message)
    && /GRANT_RUNTIME_PERMISSIONS/i.test(error.message)
}

/**
 * Android does not expose one portable `check-permission` shell command on all
 * OEM builds. `dumpsys package` is available on the supported API range and
 * reports each runtime permission as `granted=true|false`.
 */
function readRuntimePermissionState(dumpsys: string, permission: string): RuntimePermissionState {
  const match = new RegExp(
    `^\\s*${escapeRegExp(permission)}:\\s+granted=(true|false)\\b`,
    'im',
  ).exec(dumpsys)
  if (!match) return 'unknown'
  return match[1].toLowerCase() === 'true' ? 'granted' : 'denied'
}

export class RuntimePermissionManager {
  constructor(private readonly device: AndroidPreparationDevice) {}

  async grantAndVerify(
    packageName: string,
    permissions: readonly string[],
    signal: AbortSignal,
    onPermission: (permission: string, state: 'granting' | 'granted') => void,
  ): Promise<RuntimePermissionPreparationResult> {
    const granted: string[] = []
    for (const permission of permissions) {
      onPermission(permission, 'granting')
      try {
        await this.device.run(
          ['shell', 'pm', 'grant', packageName, permission],
          signal,
          15_000,
          'RUNTIME_PERMISSION_GRANT_FAILED',
        )
      } catch (error) {
        if (!isOemRuntimeGrantRestriction(error)) {
          if (error instanceof TaskExecutionError) throw error
          throw new TaskExecutionError(
            `无法授予 ${permission}：${error instanceof Error ? error.message : String(error)}`,
            'RUNTIME_PERMISSION_GRANT_FAILED',
          )
        }

        const states = await this.readPermissionStates(packageName, permissions, signal)
        return {
          mode: 'ui-required',
          grantedPermissions: permissions.filter((item) => states.get(item) === 'granted'),
          pendingPermissions: permissions.filter((item) => states.get(item) !== 'granted'),
          adbFailureMessage: error instanceof Error ? error.message : String(error),
        }
      }

      await this.verifyPermission(packageName, permission, signal)
      await this.readAppOpDiagnostic(packageName, permission, signal)
      granted.push(permission)
      onPermission(permission, 'granted')
    }
    return { mode: 'adb', grantedPermissions: granted, pendingPermissions: [] }
  }

  async areAllGranted(
    packageName: string,
    permissions: readonly string[],
    signal: AbortSignal,
  ) {
    const states = await this.readPermissionStates(packageName, permissions, signal)
    const unknown = permissions.find((permission) => states.get(permission) === 'unknown')
    if (unknown) {
      throw new TaskExecutionError(
        `系统无法在 dumpsys package 中确认 ${unknown} 的授权状态`,
        'RUNTIME_PERMISSION_VERIFICATION_UNSUPPORTED',
      )
    }
    return permissions.every((permission) => states.get(permission) === 'granted')
  }

  async verifyAll(packageName: string, permissions: readonly string[], signal: AbortSignal) {
    for (const permission of permissions) {
      await this.verifyPermission(packageName, permission, signal, true)
      await this.readAppOpDiagnostic(packageName, permission, signal)
    }
    return [...permissions]
  }

  private async readPermissionStates(
    packageName: string,
    permissions: readonly string[],
    signal: AbortSignal,
  ) {
    const verification = await this.device.run(
      ['shell', 'dumpsys', 'package', packageName],
      signal,
      15_000,
      'RUNTIME_PERMISSION_VERIFICATION_UNSUPPORTED',
    )
    return new Map(permissions.map((permission) => [
      permission,
      readRuntimePermissionState(verification.stdout, permission),
    ]))
  }

  private async verifyPermission(
    packageName: string,
    permission: string,
    signal: AbortSignal,
    afterLaunch = false,
  ) {
    const states = await this.readPermissionStates(packageName, [permission], signal)
    const state = states.get(permission)
    if (state === 'granted') return
    if (state === 'denied') {
      throw new TaskExecutionError(
        afterLaunch
          ? `应用启动后 ${permission} 未保持授权状态`
          : `${permission} 授权命令已执行，但 dumpsys 显示 granted=false`,
        'RUNTIME_PERMISSION_NOT_GRANTED',
      )
    }
    throw new TaskExecutionError(
      `系统无法在 dumpsys package 中确认 ${permission} 的授权状态`,
      'RUNTIME_PERMISSION_VERIFICATION_UNSUPPORTED',
    )
  }

  private async readAppOpDiagnostic(
    packageName: string,
    permission: string,
    signal: AbortSignal,
  ) {
    const appOp = permission === 'android.permission.CAMERA'
      ? 'CAMERA'
      : permission === 'android.permission.RECORD_AUDIO'
        ? 'RECORD_AUDIO'
        : undefined
    if (!appOp) return
    await this.device.run(
      ['shell', 'cmd', 'appops', 'get', packageName, appOp],
      signal,
      10_000,
      'RUNTIME_PERMISSION_NOT_GRANTED',
    ).catch(() => undefined)
  }
}
