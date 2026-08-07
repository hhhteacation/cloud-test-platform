import { describe, expect, it } from 'vitest'

import { TaskExecutionError } from '../execution-errors.js'
import type { ProcessResult } from '../../process.js'
import type { AndroidPreparationDevice } from './contracts.js'
import { RuntimePermissionManager } from './runtime-permissions.js'

class PermissionFakeDevice implements AndroidPreparationDevice {
  constructor(
    private readonly permissionResult = 'granted',
    private readonly legacyCheckUnsupported = false,
  ) {}

  async connectionStatus() { return 'online' as const }
  async isPackageInstalled() { return true }
  async run(args: string[]): Promise<ProcessResult> {
    const command = args.join(' ')
    if (command.includes('check-permission') && this.legacyCheckUnsupported) {
      throw new TaskExecutionError('Unknown command: check-permission', 'RUNTIME_PERMISSION_NOT_GRANTED')
    }
    if (command.startsWith('shell dumpsys package ')) {
      return {
        code: 0,
        stdout: `
          runtime permissions:
            android.permission.CAMERA: granted=${this.permissionResult === 'granted'}
            android.permission.RECORD_AUDIO: granted=${this.permissionResult === 'granted'}
        `,
        stderr: '',
      }
    }
    return { code: 0, stdout: this.permissionResult, stderr: '' }
  }
}

class GrantFailureDevice extends PermissionFakeDevice {
  constructor(private readonly grantError: TaskExecutionError) {
    super('denied')
  }

  override async run(args: string[]): Promise<ProcessResult> {
    if (args.join(' ').startsWith('shell pm grant ')) throw this.grantError
    return super.run(args)
  }
}

describe('Android permission safety', () => {
  it('does not accept a permission until dumpsys reports granted=true', async () => {
    const manager = new RuntimePermissionManager(new PermissionFakeDevice('denied'))
    await expect(manager.grantAndVerify(
      'com.morphoinc.videopostprocessor',
      ['android.permission.CAMERA'],
      new AbortController().signal,
      () => undefined,
    )).rejects.toMatchObject({ code: 'RUNTIME_PERMISSION_NOT_GRANTED' })
  })

  it('uses dumpsys instead of the unsupported Honor check-permission command', async () => {
    const manager = new RuntimePermissionManager(new PermissionFakeDevice('granted', true))

    await expect(manager.grantAndVerify(
      'com.morphoinc.videopostprocessor',
      ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'],
      new AbortController().signal,
      () => undefined,
    )).resolves.toEqual({
      mode: 'adb',
      grantedPermissions: [
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
      ],
      pendingPermissions: [],
    })
  })

  it('uses UI fallback only for the explicit OEM GRANT_RUNTIME_PERMISSIONS restriction', async () => {
    const manager = new RuntimePermissionManager(new GrantFailureDevice(new TaskExecutionError(
      'java.lang.SecurityException: grantRuntimePermission: Neither user 2000 nor current process has android.permission.GRANT_RUNTIME_PERMISSIONS',
      'RUNTIME_PERMISSION_GRANT_FAILED',
    )))

    await expect(manager.grantAndVerify(
      'com.morphoinc.videopostprocessor',
      ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'],
      new AbortController().signal,
      () => undefined,
    )).resolves.toMatchObject({
      mode: 'ui-required',
      grantedPermissions: [],
      pendingPermissions: [
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
      ],
    })
  })

  it('does not downgrade an ordinary pm grant failure to UI automation', async () => {
    const manager = new RuntimePermissionManager(new GrantFailureDevice(new TaskExecutionError(
      '设备连接中断，pm grant 未执行完成',
      'RUNTIME_PERMISSION_GRANT_FAILED',
    )))

    await expect(manager.grantAndVerify(
      'com.morphoinc.videopostprocessor',
      ['android.permission.CAMERA'],
      new AbortController().signal,
      () => undefined,
    )).rejects.toMatchObject({
      code: 'RUNTIME_PERMISSION_GRANT_FAILED',
      message: '设备连接中断，pm grant 未执行完成',
    })
  })
})
