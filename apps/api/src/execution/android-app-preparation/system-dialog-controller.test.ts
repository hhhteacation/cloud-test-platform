import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { ProcessResult } from '../../process.js'
import { TaskExecutionError } from '../execution-errors.js'
import { createDialogInteractionState } from './contracts.js'
import type { AndroidPreparationDevice } from './contracts.js'
import { SystemDialogController } from './system-dialog-controller.js'

const fixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
  'utf8',
)

function inspect(
  controller: SystemDialogController,
  options: Parameters<SystemDialogController['inspectAndHandle']>[0],
  interactionState = createDialogInteractionState(),
) {
  return controller.inspectAndHandle(options, interactionState)
}

class DialogFakeDevice implements AndroidPreparationDevice {
  readonly calls: string[][] = []

  constructor(
    private readonly xml: string | (() => string),
    private readonly windowsDump = 'mCurrentFocus=Window{123 u0 com.vivo.packageinstaller/.InstallActivity}',
    private readonly fullWindowDump = windowsDump,
    private readonly androidInstallerPath = 'package:/system/priv-app/PackageInstaller/PackageInstaller.apk',
    private readonly androidInstallerDump = '',
    private readonly tapError?: TaskExecutionError,
  ) {}

  async connectionStatus() { return 'online' as const }
  async isPackageInstalled() { return true }

  async run(args: string[]): Promise<ProcessResult> {
    this.calls.push(args)
    const command = args.join(' ')
    if (command === 'shell dumpsys window windows') return this.result(this.windowsDump)
    if (command === 'shell dumpsys window') return this.result(this.fullWindowDump)
    if (command === 'exec-out uiautomator dump /dev/tty') {
      return this.result(typeof this.xml === 'function' ? this.xml() : this.xml)
    }
    if (command === 'shell pm path com.vivo.packageinstaller') {
      return this.result('package:/system/priv-app/VivoPackageInstaller/base.apk')
    }
    if (command === 'shell pm path com.android.packageinstaller') {
      return this.result(this.androidInstallerPath)
    }
    if (command === 'shell pm path com.android.permissioncontroller') {
      return this.result('package:/system/priv-app/PermissionController/PermissionController.apk')
    }
    if (command === 'shell pm path com.miui.securitycenter') {
      return this.result('package:/data/app/updated-miui-securitycenter/base.apk')
    }
    if (command === 'shell dumpsys package com.android.packageinstaller') {
      return this.result(this.androidInstallerDump)
    }
    if (command === 'shell dumpsys package com.miui.securitycenter') {
      return this.result(
        'privateFlags=[ DIRECT_BOOT_AWARE PRIVILEGED ]\npkgFlags=[ SYSTEM UPDATED_SYSTEM_APP HAS_CODE ]',
      )
    }
    if (command.startsWith('shell input tap ') && this.tapError) throw this.tapError
    return this.result('')
  }

  private result(stdout: string): ProcessResult {
    return { code: 0, stdout, stderr: '' }
  }
}

describe('SystemDialogController', () => {
  it('uses the matched XML node bounds instead of fixed coordinates', async () => {
    const device = new DialogFakeDevice(fixture('vivo-install-warning.xml'))
    const controller = new SystemDialogController(device, async () => undefined)
    const result = await inspect(controller, {
      manufacturer: 'vivo',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      phase: 'install',
      profileIds: ['vivo-package-installer-v1'],
      diagnosticsDirectory: '/tmp/not-used',
      maxActions: 4,
      signal: new AbortController().signal,
    })

    expect(result.kind).toBe('handled')
    expect(device.calls).toContainEqual(['shell', 'input', 'tap', '850', '1760'])
  })


  it('falls back to full dumpsys window when the OEM windows subcommand omits current focus', async () => {
    const device = new DialogFakeDevice(
      fixture('vivo-originos-real-install-warning.xml'),
      'WINDOW MANAGER WINDOWS (dumpsys window windows)\n  Window #0 Window{launcher}',
      'mCurrentFocus=Window{b382e47 u0 com.android.packageinstaller/com.android.packageinstaller.PackageInterceptActivity type=1 }',
    )
    const controller = new SystemDialogController(device, async () => undefined)
    const result = await inspect(controller, {
      manufacturer: 'vivo',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      phase: 'install',
      profileIds: ['vivo-package-installer-v1'],
      diagnosticsDirectory: '/tmp/not-used',
      maxActions: 4,
      signal: new AbortController().signal,
    })

    expect(result.kind).toBe('handled')
    expect(device.calls).toContainEqual(['shell', 'dumpsys', 'window'])
    expect(device.calls).toContainEqual(['shell', 'input', 'tap', '630', '2450'])
  })


  it('trusts a privileged updated system installer even when its active APK is under data/app', async () => {
    const device = new DialogFakeDevice(
      fixture('honor-magic-os-real-install-warning.xml'),
      'mCurrentFocus=Window{54230bb u0 com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity}',
      undefined,
      'package:/data/app/updated-system-package/base.apk',
      'privateFlags=[ DIRECT_BOOT_AWARE PRIVILEGED ]\npkgFlags=[ SYSTEM UPDATED_SYSTEM_APP HAS_CODE ]',
    )
    const controller = new SystemDialogController(device, async () => undefined)
    const result = await inspect(controller, {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      phase: 'install',
      profileIds: ['honor-package-installer-v1'],
      diagnosticsDirectory: '/tmp/not-used',
      maxActions: 4,
      signal: new AbortController().signal,
    })

    expect(result.kind).toBe('handled')
    expect(device.calls).toContainEqual(['shell', 'dumpsys', 'package', 'com.android.packageinstaller'])
    expect(device.calls).toContainEqual(['shell', 'input', 'tap', '852', '2464'])
  })

  it('taps the allow-one-time-install span inside the Honor X50 risk description bounds', async () => {
    const device = new DialogFakeDevice(
      fixture('honor-x50-safe-mode-install-sheet.xml'),
      'mCurrentFocus=Window{5d0186f u0 com.android.packageinstaller/com.hihonor.packageinstaller.hncust.safemode.sheet.SafeModeBottomSheetActivity}',
    )
    const controller = new SystemDialogController(device, async () => undefined)
    const result = await inspect(controller, {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      phase: 'install',
      profileIds: ['honor-safe-mode-install-sheet-v1'],
      diagnosticsDirectory: '/tmp/not-used',
      maxActions: 5,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      kind: 'handled',
      dialog: {
        profileId: 'honor-safe-mode-install-sheet-v1',
        action: 'allow-one-time-install',
      },
    })
    expect(device.calls).toContainEqual(['shell', 'input', 'tap', '958', '1993'])
    expect(device.calls).not.toContainEqual(['shell', 'input', 'tap', '600', '1993'])
  })

  it('classifies the real Honor X50 MagicOS risk page as manual action required without tapping', async () => {
    const diagnosticsDirectory = await mkdtemp(path.join(tmpdir(), 'honor-x50-install-block-'))
    const screenshots: string[] = []
    try {
      const device = new DialogFakeDevice(
        fixture('honor-x50-magic-os-9-package-installer-recommendations.xml'),
        'mCurrentFocus=Window{907a4a6 u0 com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity}',
      )
      const controller = new SystemDialogController(device, async (targetPath) => {
        screenshots.push(targetPath)
      })

      const result = await inspect(controller, {
        manufacturer: 'HONOR',
        packageName: 'com.morphoinc.videopostprocessor',
        applicationLabel: 'Morpho VideoStabilizer',
        phase: 'install',
        profileIds: [
          'honor-package-installer-v1',
          'honor-magic-os-unreviewed-app-block-v1',
        ],
        diagnosticsDirectory,
        maxActions: 5,
        signal: new AbortController().signal,
      })

      expect(result).toMatchObject({
        kind: 'manual-action-required',
        block: {
          profileId: 'honor-magic-os-unreviewed-app-block-v1',
          reason: 'honor-install-authorization-required',
        },
      })
      expect(device.calls.some((args) => args.slice(0, 3).join(' ') === 'shell input tap')).toBe(false)
      const files = await readdir(diagnosticsDirectory)
      expect(files.some((name) => name.startsWith('current-window-') && name.endsWith('.txt'))).toBe(true)
      expect(files.some((name) => name.startsWith('install-dialog-') && name.endsWith('.xml'))).toBe(true)
      expect(screenshots).toHaveLength(1)
    } finally {
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  })


  it('handles the exact Honor X50 risk page in two independently inspected actions using fresh XML bounds', async () => {
    const originalXml = fixture(
      'honor-x50-magic-os-9-package-installer-recommendations-install.xml',
    )
    let currentXml = originalXml
    const device = new DialogFakeDevice(
      () => currentXml,
      'mCurrentFocus=Window{907a4a6 u0 com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity}',
    )
    const controller = new SystemDialogController(device, async () => undefined)
    const options = {
      manufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      phase: 'install',
      profileIds: [
        'honor-x50-magic-os-unreviewed-app-install-v1',
        'honor-magic-os-unreviewed-app-block-v1',
      ],
      diagnosticsDirectory: '/tmp/not-used',
      maxActions: 5,
      signal: new AbortController().signal,
    }

    const checkboxResult = await inspect(controller, options)
    expect(checkboxResult).toMatchObject({
      kind: 'handled',
      dialog: {
        profileId: 'honor-x50-magic-os-unreviewed-app-install-v1',
        action: 'confirm-checkbox',
      },
    })
    expect(device.calls).toContainEqual(['shell', 'input', 'tap', '600', '2193'])

    currentXml = originalXml
      .replace(
        'resource-id="com.android.packageinstaller:id/checkbox" class="android.widget.CheckBox" package="com.android.packageinstaller" content-desc="" checkable="true" checked="false"',
        'resource-id="com.android.packageinstaller:id/checkbox" class="android.widget.CheckBox" package="com.android.packageinstaller" content-desc="" checkable="true" checked="true"',
      )
      .replace(
        'resource-id="android:id/button1" class="android.widget.Button" package="com.android.packageinstaller" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[613,2457][1122,2574]"',
        'resource-id="android:id/button1" class="android.widget.Button" package="com.android.packageinstaller" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[700,2300][1100,2400]"',
      )

    const continueResult = await inspect(controller, options)
    expect(continueResult).toMatchObject({
      kind: 'handled',
      dialog: {
        profileId: 'honor-x50-magic-os-unreviewed-app-install-v1',
        action: 'continue-install',
      },
    })
    expect(device.calls).toContainEqual(['shell', 'input', 'tap', '900', '2350'])
    expect(device.calls.filter(
      (args) => args.slice(0, 3).join(' ') === 'shell input tap',
    )).toEqual([
      ['shell', 'input', 'tap', '600', '2193'],
      ['shell', 'input', 'tap', '900', '2350'],
    ])
  })

  it('clicks the Xiaomi continue button without toggling the opt-out checkbox', async () => {
    const device = new DialogFakeDevice(
      fixture('xiaomi-hyperos-adb-install-confirmation.xml'),
      'mCurrentFocus=Window{b9eb1bc u0 com.miui.securitycenter/com.miui.permcenter.install.AdbInstallActivity}',
    )
    const controller = new SystemDialogController(device, async () => undefined)
    const result = await inspect(controller, {
      manufacturer: 'Xiaomi',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      phase: 'install',
      profileIds: ['xiaomi-hyperos-package-installer-v1'],
      diagnosticsDirectory: '/tmp/not-used',
      maxActions: 5,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      kind: 'handled',
      dialog: {
        profileId: 'xiaomi-hyperos-package-installer-v1',
        action: 'continue-install',
      },
    })
    expect(device.calls).toContainEqual(['shell', 'input', 'tap', '311', '2187'])
    expect(device.calls).not.toContainEqual(['shell', 'input', 'tap', '540', '2066'])
  })

  it('does not carry action history into a new business phase when the adapter is reused', async () => {
    const device = new DialogFakeDevice(
      fixture('vivo-install-warning.xml'),
      'mCurrentFocus=Window{123 u0 com.vivo.packageinstaller/.InstallActivity}',
    )
    const controller = new SystemDialogController(device, async () => undefined)
    const options = {
      manufacturer: 'vivo',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      phase: 'install',
      profileIds: ['vivo-package-installer-v1'],
      diagnosticsDirectory: '/tmp/not-used',
      maxActions: 1,
      signal: new AbortController().signal,
    }

    const installPhase = createDialogInteractionState()
    const postLaunchPhase = createDialogInteractionState()
    expect((await inspect(controller, options, installPhase)).kind).toBe('handled')
    expect((await inspect(controller, options, installPhase)).kind).toBe('waiting')
    expect((await inspect(controller, options, postLaunchPhase)).kind).toBe('handled')
    expect(device.calls.filter(
      (args) => args.slice(0, 3).join(' ') === 'shell input tap',
    )).toHaveLength(2)
  })

  it('handles consecutive camera and microphone permission dialogs as independent actions', async () => {
    // 真机回归（2026-09-10 PJV110→HyperOS Android 16）：相机弹窗点击后麦克风弹窗
    // 接连出现。两个弹窗的按钮文案/resource-id/bounds 完全相同，只有标题不同；
    // 动作指纹若不含页面上下文，第二个弹窗会被误判为"上一次点击仍在等待迁移"
    // 而永不点击，最终 RUNTIME_PERMISSION_DIALOG_TIMEOUT。
    const diagnosticsDirectory = await mkdtemp(path.join(tmpdir(), 'xiaomi-sequence-permission-'))
    try {
      let currentXml = fixture('xiaomi-15pro-android16-runtime-permission.xml')
      const device = new DialogFakeDevice(
        () => currentXml,
        'mCurrentFocus=Window{a1b2c3 u0 com.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity}',
      )
      const controller = new SystemDialogController(device, async () => undefined)
      const options = {
        manufacturer: 'Xiaomi',
        packageName: 'com.morphoinc.videopostprocessor',
        applicationLabel: 'Morpho VideoStabilizer',
        phase: 'runtime-permission',
        profileIds: ['android-runtime-permission-v1'],
        diagnosticsDirectory,
        maxActions: 5,
        signal: new AbortController().signal,
      }
      const interactionState = createDialogInteractionState()

      const cameraResult = await controller.inspectAndHandle(options, interactionState)
      expect(cameraResult).toMatchObject({
        kind: 'handled',
        dialog: { profileId: 'android-runtime-permission-v1', action: 'allow-permission' },
      })

      currentXml = fixture('xiaomi-15pro-android16-microphone-permission.xml')
      const micResult = await controller.inspectAndHandle(options, interactionState)
      expect(micResult).toMatchObject({
        kind: 'handled',
        dialog: { profileId: 'android-runtime-permission-v1', action: 'allow-permission' },
      })

      const taps = device.calls.filter(
        (args) => args.slice(0, 3).join(' ') === 'shell input tap',
      )
      expect(taps).toHaveLength(2)
    } finally {
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  })

  it('stops instead of tapping the same Honor safe-mode span twice when the page does not change', async () => {
    const diagnosticsDirectory = await mkdtemp(path.join(tmpdir(), 'honor-safe-mode-dialog-'))
    try {
      const device = new DialogFakeDevice(
        fixture('honor-x50-safe-mode-install-sheet.xml'),
        'mCurrentFocus=Window{5d0186f u0 com.android.packageinstaller/com.hihonor.packageinstaller.hncust.safemode.sheet.SafeModeBottomSheetActivity}',
      )
      const controller = new SystemDialogController(device, async () => undefined)
      const options = {
        manufacturer: 'HONOR',
        packageName: 'com.morphoinc.videopostprocessor',
        applicationLabel: 'Morpho VideoStabilizer',
        phase: 'install',
        profileIds: ['honor-safe-mode-install-sheet-v1'],
        diagnosticsDirectory,
        maxActions: 5,
        signal: new AbortController().signal,
      }
      const interactionState = createDialogInteractionState()

      const firstResult = await controller.inspectAndHandle(options, interactionState)
      const secondResult = await controller.inspectAndHandle(options, interactionState)
      expect(firstResult.kind).toBe('handled')
      expect(secondResult).toMatchObject({
        kind: 'waiting',
        reason: 'action-awaiting-transition',
      })
      expect(device.calls.filter(
        (args) => args.slice(0, 3).join(' ') === 'shell input tap',
      )).toEqual([['shell', 'input', 'tap', '958', '1993']])
    } finally {
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  })

  it('saves diagnostics and reports Xiaomi input automation guidance when a matched tap is denied', async () => {
    const diagnosticsDirectory = await mkdtemp(path.join(tmpdir(), 'xiaomi-input-denied-'))
    const screenshots: string[] = []
    try {
      const device = new DialogFakeDevice(
        fixture('xiaomi-hyperos-adb-install-confirmation.xml'),
        'mCurrentFocus=Window{b9eb1bc u0 com.miui.securitycenter/com.miui.permcenter.install.AdbInstallActivity}',
        undefined,
        undefined,
        undefined,
        new TaskExecutionError(
          "Exception occurred while executing 'tap': java.lang.SecurityException: Injecting input events requires the caller to have the INJECT_EVENTS permission at com.android.server.input.InputManagerService.injectInputEventToTarget(InputManagerService.java:1103)",
          'INSTALL_DIALOG_UNRECOGNIZED',
        ),
      )
      const controller = new SystemDialogController(device, async (targetPath) => {
        screenshots.push(targetPath)
      })

      await expect(inspect(controller, {
        manufacturer: 'Xiaomi',
        packageName: 'com.morphoinc.videopostprocessor',
        applicationLabel: 'Morpho VideoStabilizer',
        phase: 'install',
        profileIds: ['xiaomi-hyperos-package-installer-v1'],
        diagnosticsDirectory,
        maxActions: 4,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code: 'DEVICE_INPUT_AUTOMATION_DENIED',
        message: expect.stringMatching(/小米\/HyperOS 拒绝 ADB 控制触摸事件.*USB 调试（安全设置）.*网络 ADB/),
      })

      const files = await readdir(diagnosticsDirectory)
      expect(files.some((name) => name.startsWith('current-window-') && name.endsWith('.txt'))).toBe(true)
      expect(files.some((name) => name.startsWith('install-dialog-') && name.endsWith('.xml'))).toBe(true)
      expect(screenshots).toHaveLength(1)
      expect(screenshots[0]).toMatch(/install-dialog-.*\.png$/)
      expect(device.calls.filter(
        (args) => args.slice(0, 3).join(' ') === 'shell input tap',
      )).toHaveLength(1)
    } finally {
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  })

  it('preserves ordinary ADB tap failures without reclassifying them as input permission errors', async () => {
    const tapError = new TaskExecutionError('网络 ADB 连接已断开', 'DEVICE_OFFLINE')
    const device = new DialogFakeDevice(
      fixture('android-camera-permission.xml'),
      'mCurrentFocus=Window{123 u0 com.android.permissioncontroller/.permission.ui.GrantPermissionsActivity}',
      undefined,
      undefined,
      undefined,
      tapError,
    )
    const controller = new SystemDialogController(device, async () => undefined)

    await expect(inspect(controller, {
      manufacturer: 'Xiaomi',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      phase: 'runtime-permission',
      profileIds: ['android-runtime-permission-v1'],
      diagnosticsDirectory: '/tmp/not-used',
      maxActions: 4,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'DEVICE_OFFLINE',
      message: '网络 ADB 连接已断开',
    })
  })

  it('does not click a generic unrelated continue dialog', async () => {
    const device = new DialogFakeDevice(fixture('unrelated-dialog.xml'))
    const controller = new SystemDialogController(device, async () => undefined)
    const result = await inspect(controller, {
      manufacturer: 'vivo',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      phase: 'install',
      profileIds: ['vivo-package-installer-v1'],
      diagnosticsDirectory: '/tmp/not-used',
      maxActions: 4,
      signal: new AbortController().signal,
    })

    expect(result.kind).toBe('unrecognized')
    expect(device.calls.some((args) => args.slice(0, 3).join(' ') === 'shell input tap')).toBe(false)
  })
})
