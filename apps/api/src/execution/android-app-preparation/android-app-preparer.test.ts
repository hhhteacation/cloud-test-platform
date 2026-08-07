import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { findApkExecutionProtocol, type ApkExecutionProtocol } from '../../apk-protocols.js'
import type { ProcessResult } from '../../process.js'
import { TaskExecutionError } from '../execution-errors.js'
import { DefaultAndroidAppPreparer } from './android-app-preparer.js'
import type { AndroidPreparationDevice } from './contracts.js'

const fixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
  'utf8',
)

class PreparationFakeDevice implements AndroidPreparationDevice {
  readonly calls: string[][] = []
  private installedChecks = 0
  protected awake = true

  async connectionStatus() { return 'online' as const }

  async isPackageInstalled() {
    this.installedChecks += 1
    return this.installedChecks > 1
  }

  async run(args: string[]): Promise<ProcessResult> {
    this.calls.push(args)
    const command = args.join(' ')
    if (command === 'shell dumpsys power') {
      return this.result(this.awake
        ? 'mWakefulness=Awake\nmInteractive=true'
        : 'mWakefulness=Asleep\nmInteractive=false')
    }
    if (command === 'shell input keyevent KEYCODE_WAKEUP'
      || command === 'shell cmd power wakeup 0') {
      this.awake = true
      return this.result('')
    }
    if (command === 'shell dumpsys window policy') return this.result('mKeyguardShowing=false')
    if (command.startsWith('shell dumpsys package ')) {
      return this.result(`
        runtime permissions:
          android.permission.CAMERA: granted=true
          android.permission.RECORD_AUDIO: granted=true
      `)
    }
    return this.result('Success')
  }

  private result(stdout: string): ProcessResult {
    return { code: 0, stdout, stderr: '' }
  }
}

class ResidualUnknownRuntimeDialogDevice extends PreparationFakeDevice {
  private activityStarted = false

  override async run(args: string[]): Promise<ProcessResult> {
    const command = args.join(' ')
    if (command.startsWith('shell pm grant ')) {
      this.calls.push(args)
      return { code: 0, stdout: 'Success', stderr: '' }
    }
    if (command === 'shell dumpsys package com.morphoinc.videopostprocessor') {
      this.calls.push(args)
      return {
        code: 0,
        stdout: '\n          runtime permissions:\n            android.permission.CAMERA: granted=true\n            android.permission.RECORD_AUDIO: granted=true\n        ',
        stderr: '',
      }
    }
    if (command === 'shell am start com.morphoinc.videopostprocessor/.MainActivity') {
      this.activityStarted = true
      this.calls.push(args)
      return { code: 0, stdout: 'Starting: Intent', stderr: '' }
    }
    if (command === 'shell dumpsys window windows' && this.activityStarted) {
      this.calls.push(args)
      return {
        code: 0,
        stdout: 'mCurrentFocus=Window{abc u0 com.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity}',
        stderr: '',
      }
    }
    if (command === 'exec-out uiautomator dump /dev/tty' && this.activityStarted) {
      this.calls.push(args)
      return {
        code: 0,
        stdout: '<hierarchy><node index=\"0\" text=\"Unexpected permission screen\" resource-id=\"unknown:id/root\" class=\"android.widget.FrameLayout\" package=\"com.android.permissioncontroller\" clickable=\"false\" enabled=\"true\" bounds=\"[0,0][1080,2400]\" /></hierarchy>',
        stderr: '',
      }
    }
    if (command === 'shell pm path com.android.permissioncontroller') {
      this.calls.push(args)
      return { code: 0, stdout: 'package:/system/priv-app/PermissionController/PermissionController.apk', stderr: '' }
    }
    return super.run(args)
  }
}

class XiaomiInputDeniedPreparationDevice extends PreparationFakeDevice {
  constructor() {
    super()
    this.awake = false
  }

  override async run(args: string[]): Promise<ProcessResult> {
    if (args.join(' ') === 'shell input keyevent KEYCODE_WAKEUP') {
      this.calls.push(args)
      throw new TaskExecutionError(
        "Exception occurred while executing 'keyevent': java.lang.SecurityException: Injecting input events requires the caller to have the INJECT_EVENTS permission",
        'DEVICE_LOCKED',
      )
    }
    return super.run(args)
  }
}

class OplusPermissionFallbackDevice implements AndroidPreparationDevice {
  readonly calls: string[][] = []
  private installedChecks = 0
  private activityStarted = false
  private permissionsGranted = false
  private dialogStage: 'runtime-permission' | 'storage-warning' | 'main' = 'runtime-permission'

  async connectionStatus() { return 'online' as const }

  async isPackageInstalled() {
    this.installedChecks += 1
    return this.installedChecks > 1
  }

  async run(args: string[]): Promise<ProcessResult> {
    this.calls.push(args)
    const command = args.join(' ')
    if (command === 'shell dumpsys power') return this.result('mWakefulness=Awake\nmInteractive=true')
    if (command === 'shell dumpsys window policy') return this.result('mKeyguardShowing=false')
    if (command.startsWith('shell pm grant ')) {
      throw new TaskExecutionError(
        'java.lang.SecurityException: grantRuntimePermission: Neither user 2000 nor current process has android.permission.GRANT_RUNTIME_PERMISSIONS',
        'RUNTIME_PERMISSION_GRANT_FAILED',
      )
    }
    if (command === 'shell am start com.morphoinc.videopostprocessor/.MainActivity') {
      this.activityStarted = true
      return this.result('Starting: Intent')
    }
    if (command === 'shell dumpsys window windows') {
      if (!this.activityStarted) return this.result('mCurrentFocus=Window{abc u0 com.android.launcher/.Launcher}')
      if (this.dialogStage === 'runtime-permission') {
        return this.result('mCurrentFocus=Window{abc u0 com.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity}')
      }
      if (this.dialogStage === 'storage-warning') {
        return this.result('mCurrentFocus=Window{abc u0 com.android.permissioncontroller/com.oplusos.permissioncontroller.permission.ui.OplusCompatibilityAlertActivity}')
      }
      return this.result('mCurrentFocus=Window{abc u0 com.morphoinc.videopostprocessor/com.morphoinc.videopostprocessor.MainActivity}')
    }
    if (command === 'exec-out uiautomator dump /dev/tty') {
      return this.result(this.dialogStage === 'storage-warning'
        ? fixture('oplus-coloros-storage-compatibility-warning.xml')
        : fixture('oplus-coloros-runtime-permissions.xml'))
    }
    if (command === 'shell pm path com.android.permissioncontroller') {
      return this.result('package:/system/priv-app/PermissionController/PermissionController.apk')
    }
    if (command.startsWith('shell input tap ')) {
      if (this.dialogStage === 'runtime-permission') {
        this.permissionsGranted = true
        this.dialogStage = 'storage-warning'
      } else if (this.dialogStage === 'storage-warning') {
        this.dialogStage = 'main'
      }
      return this.result('')
    }
    if (command === 'shell dumpsys package com.morphoinc.videopostprocessor') {
      return this.result(`
        runtime permissions:
          android.permission.CAMERA: granted=${this.permissionsGranted}
          android.permission.RECORD_AUDIO: granted=${this.permissionsGranted}
      `)
    }
    return this.result('Success')
  }

  private result(stdout: string): ProcessResult {
    return { code: 0, stdout, stderr: '' }
  }
}

class HonorPostLaunchManualActionDevice extends PreparationFakeDevice {
  private activityStarted = false

  override async isPackageInstalled() {
    return true
  }

  override async run(args: string[]): Promise<ProcessResult> {
    const command = args.join(' ')
    if (command === 'shell am start com.morphoinc.videopostprocessor/.MainActivity') {
      this.activityStarted = true
      this.calls.push(args)
      return { code: 0, stdout: 'Starting: Intent', stderr: '' }
    }
    if (command === 'shell dumpsys window windows' && this.activityStarted) {
      this.calls.push(args)
      return {
        code: 0,
        stdout: 'mCurrentFocus=Window{abc u0 com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity}',
        stderr: '',
      }
    }
    if (command === 'exec-out uiautomator dump /dev/tty' && this.activityStarted) {
      this.calls.push(args)
      return { code: 0, stdout: fixture('honor-x50-magic-os-9-package-installer-recommendations.xml'), stderr: '' }
    }
    if (command === 'shell pm path com.android.packageinstaller') {
      this.calls.push(args)
      return { code: 0, stdout: 'package:/system/priv-app/PackageInstaller/PackageInstaller.apk', stderr: '' }
    }
    return super.run(args)
  }
}

describe('DefaultAndroidAppPreparer', () => {
  it('does not reclassify an unrecognized residual permission dialog as a post-launch result', async () => {
    const base = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const protocol: ApkExecutionProtocol = {
      ...base,
      install: {
        ...base.install,
        dialogAutomation: {
          ...base.install.dialogAutomation!,
          timeoutMs: 30,
          pollIntervalMs: 1,
          unrecognizedGraceMs: 0,
        },
      },
      launch: {
        ...base.launch,
        warmupBeforeTransferMs: 1,
        postLaunchDialogAutomation: {
          mode: 'strict-whitelist',
          profileIds: ['oplus-storage-compatibility-warning-v1'],
          timeoutMs: 1,
          pollIntervalMs: 1,
          maxActions: 1,
          unrecognizedGraceMs: 0,
        },
      },
    }
    const preparer = new DefaultAndroidAppPreparer({
      createDevice: () => new ResidualUnknownRuntimeDialogDevice(),
      captureScreenshot: async () => undefined,
    })

    await expect(preparer.prepareApplication({
      deviceSerial: 'vivo-residual-runtime-dialog',
      deviceManufacturer: 'vivo',
      deviceModel: 'V2324A',
      apkPath: '/tmp/morpho.apk',
      protocol,
      diagnosticsDirectory: '/tmp/not-used',
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })).rejects.toMatchObject({ code: 'RUNTIME_PERMISSION_DIALOG_UNRECOGNIZED' })
  })

  it('falls back to PowerManager and continues installation when Xiaomi wake input is denied', async () => {
    const protocol = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const device = new XiaomiInputDeniedPreparationDevice()
    const preparer = new DefaultAndroidAppPreparer({
      createDevice: () => device,
      captureScreenshot: async () => undefined,
    })

    await expect(preparer.prepareApplication({
      deviceSerial: 'network-endpoint',
      deviceManufacturer: 'Xiaomi',
      deviceModel: 'Xiaomi device',
      apkPath: '/tmp/morpho.apk',
      protocol,
      diagnosticsDirectory: '/tmp/not-used',
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })).resolves.toMatchObject({ cleanInstalled: true })

    expect(device.calls).toContainEqual(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
    expect(device.calls).toContainEqual(['shell', 'cmd', 'power', 'wakeup', '0'])
    expect(device.calls).toContainEqual(['install', '/tmp/morpho.apk'])
  })

  it('keeps the PowerManager fallback for Xiaomi protocols without the HyperOS installer profile', async () => {
    const base = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const protocol: ApkExecutionProtocol = {
      ...base,
      install: {
        ...base.install,
        dialogAutomation: {
          ...base.install.dialogAutomation!,
          profileIds: base.install.dialogAutomation!.profileIds.filter(
            (profileId) => profileId !== 'xiaomi-hyperos-package-installer-v1',
          ),
        },
      },
    }
    const device = new XiaomiInputDeniedPreparationDevice()
    const preparer = new DefaultAndroidAppPreparer({
      createDevice: () => device,
      captureScreenshot: async () => undefined,
    })

    await expect(preparer.prepareApplication({
      deviceSerial: 'xiaomi-without-input-automation',
      deviceManufacturer: 'Xiaomi',
      deviceModel: '2410DPN6CC',
      apkPath: '/tmp/morpho.apk',
      protocol,
      diagnosticsDirectory: '/tmp/not-used',
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })).resolves.toMatchObject({ cleanInstalled: true })

    expect(device.calls).toContainEqual(['shell', 'cmd', 'power', 'wakeup', '0'])
    expect(device.calls).toContainEqual(['install', '/tmp/morpho.apk'])
  })

  it('keeps the PowerManager fallback for non-Xiaomi devices even when the profile is enabled', async () => {
    const protocol = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const device = new XiaomiInputDeniedPreparationDevice()
    const preparer = new DefaultAndroidAppPreparer({
      createDevice: () => device,
      captureScreenshot: async () => undefined,
    })

    await expect(preparer.prepareApplication({
      deviceSerial: 'honor-device',
      deviceManufacturer: 'HONOR',
      deviceModel: 'X50',
      apkPath: '/tmp/morpho.apk',
      protocol,
      diagnosticsDirectory: '/tmp/not-used',
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })).resolves.toMatchObject({ cleanInstalled: true })

    expect(device.calls).toContainEqual(['shell', 'cmd', 'power', 'wakeup', '0'])
    expect(device.calls).toContainEqual(['install', '/tmp/morpho.apk'])
  })

  it('installs before granting permissions and launches only after verification', async () => {
    const base = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const protocol: ApkExecutionProtocol = {
      ...base,
      install: {
        ...base.install,
        dialogAutomation: { ...base.install.dialogAutomation!, mode: 'none' },
      },
      launch: { ...base.launch, warmupBeforeTransferMs: 1 },
    }
    const device = new PreparationFakeDevice()
    const events: string[] = []
    const requestedSerials: string[] = []
    const preparer = new DefaultAndroidAppPreparer({
      createDevice: (serial) => {
        requestedSerials.push(serial)
        return device
      },
      captureScreenshot: async () => undefined,
    })

    const receipt = await preparer.prepareApplication({
      deviceSerial: 'serial-1',
      deviceManufacturer: 'vivo',
      deviceModel: 'V2324A',
      apkPath: '/tmp/morpho.apk',
      protocol,
      diagnosticsDirectory: '/tmp/not-used',
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event.message),
    })

    const commands = device.calls.map((args) => args.join(' '))
    const installIndex = commands.indexOf('install /tmp/morpho.apk')
    const grantIndex = commands.indexOf('shell pm grant com.morphoinc.videopostprocessor android.permission.CAMERA')
    const verifyIndex = commands.indexOf('shell dumpsys package com.morphoinc.videopostprocessor')
    const launchIndex = commands.indexOf('shell am start com.morphoinc.videopostprocessor/.MainActivity')

    expect(installIndex).toBeGreaterThan(-1)
    expect(grantIndex).toBeGreaterThan(installIndex)
    expect(verifyIndex).toBeGreaterThan(grantIndex)
    expect(launchIndex).toBeGreaterThan(verifyIndex)
    expect(receipt).toMatchObject({
      packageName: 'com.morphoinc.videopostprocessor',
      cleanInstalled: true,
      grantedPermissions: [
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
      ],
      handledDialogs: [],
      timings: {
        installMs: expect.any(Number),
        permissionMs: expect.any(Number),
      },
    })
    expect(events).toContain('相机权限验证通过')
    expect(events).toContain('录音权限验证通过')
    expect(requestedSerials).toEqual(['serial-1'])
  })

  it('does not silently continue when post-launch observes an explicit manual-action block', async () => {
    const base = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const protocol: ApkExecutionProtocol = {
      ...base,
      install: {
        ...base.install,
        dialogAutomation: {
          ...base.install.dialogAutomation!,
          profileIds: ['honor-package-installer-v1'],
          timeoutMs: 100,
          pollIntervalMs: 1,
        },
      },
      launch: {
        ...base.launch,
        warmupBeforeTransferMs: 1,
        postLaunchDialogAutomation: {
          mode: 'strict-whitelist',
          profileIds: ['honor-magic-os-unreviewed-app-block-v1'],
          timeoutMs: 100,
          pollIntervalMs: 1,
          maxActions: 1,
          unrecognizedGraceMs: 10,
        },
      },
    }
    const device = new HonorPostLaunchManualActionDevice()
    const preparer = new DefaultAndroidAppPreparer({
      createDevice: () => device,
      captureScreenshot: async () => undefined,
    })

    await expect(preparer.prepareApplication({
      deviceSerial: 'honor-post-launch-manual',
      deviceManufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      apkPath: '/tmp/morpho.apk',
      protocol,
      diagnosticsDirectory: '/tmp/not-used',
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })).rejects.toMatchObject({
      code: 'POST_LAUNCH_DIALOG_MANUAL_ACTION_REQUIRED',
    })
  })

  it('does not carry action limits from runtime permission handling into post-launch handling', async () => {
    const base = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const protocol: ApkExecutionProtocol = {
      ...base,
      install: {
        ...base.install,
        dialogAutomation: {
          ...base.install.dialogAutomation!,
          maxActions: 1,
        },
      },
      launch: {
        ...base.launch,
        postLaunchDialogAutomation: {
          ...base.launch.postLaunchDialogAutomation!,
          maxActions: 1,
        },
      },
    }
    const device = new OplusPermissionFallbackDevice()
    const preparer = new DefaultAndroidAppPreparer({
      createDevice: () => device,
      captureScreenshot: async () => undefined,
    })

    await expect(preparer.prepareApplication({
      deviceSerial: 'oplus-stage-isolation',
      deviceManufacturer: 'OPPO',
      deviceModel: 'PJV110',
      apkPath: '/tmp/morpho.apk',
      protocol,
      diagnosticsDirectory: '/tmp/not-used',
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })).resolves.toMatchObject({
      handledDialogs: expect.arrayContaining([
        expect.objectContaining({ profileId: 'android-runtime-permission-v1' }),
        expect.objectContaining({ profileId: 'oplus-storage-compatibility-warning-v1' }),
      ]),
    })
  })

  it('falls back to the strict permission dialog when ColorOS forbids shell pm grant', async () => {
    const protocol = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const device = new OplusPermissionFallbackDevice()
    const events: string[] = []
    const preparer = new DefaultAndroidAppPreparer({
      createDevice: () => device,
      captureScreenshot: async () => undefined,
    })

    const receipt = await preparer.prepareApplication({
      deviceSerial: 'DE45R8ZPSGIBQOTC',
      deviceManufacturer: 'OPPO',
      deviceModel: 'PJV110',
      apkPath: '/tmp/morpho.apk',
      protocol,
      diagnosticsDirectory: '/tmp/not-used',
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event.message),
    })

    expect(receipt.grantedPermissions).toEqual([
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
    ])
    expect(receipt.handledDialogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profileId: 'android-runtime-permission-v1',
        action: 'allow-permission',
      }),
      expect.objectContaining({
        profileId: 'oplus-storage-compatibility-warning-v1',
        action: 'dismiss-compatibility-warning',
      }),
    ]))
    expect(device.calls).toContainEqual([
      'shell', 'input', 'tap', '540', '2004',
    ])
    expect(device.calls).toContainEqual([
      'shell', 'input', 'tap', '540', '2205',
    ])
    expect(events.some((message) => message.includes('切换到严格权限弹窗兜底'))).toBe(true)
  })
})
