import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { ProcessResult } from '../../process.js'
import { ApkInstallCoordinator } from './apk-install-coordinator.js'
import type { AndroidPreparationDevice } from './contracts.js'
import { TaskExecutionError } from '../execution-errors.js'
import { SystemDialogController } from './system-dialog-controller.js'

const vivoXml = readFileSync(
  fileURLToPath(new URL('./__fixtures__/vivo-install-warning.xml', import.meta.url)),
  'utf8',
)

const xiaomiXml = readFileSync(
  fileURLToPath(new URL('./__fixtures__/xiaomi-hyperos-adb-install-confirmation.xml', import.meta.url)),
  'utf8',
)

const honorRiskXml = readFileSync(
  fileURLToPath(new URL('./__fixtures__/honor-x50-magic-os-9-package-installer-recommendations-install.xml', import.meta.url)),
  'utf8',
)

class BlockingInstallDevice implements AndroidPreparationDevice {
  readonly calls: string[][] = []
  private completeInstall?: () => void

  async connectionStatus() { return 'online' as const }
  async isPackageInstalled() { return false }

  async run(args: string[], signal: AbortSignal): Promise<ProcessResult> {
    this.calls.push(args)
    const command = args.join(' ')
    if (command.startsWith('install ')) {
      return new Promise<ProcessResult>((resolve, reject) => {
        this.completeInstall = () => resolve(this.result('Success'))
        const abort = () => reject(new DOMException('cancelled', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    if (command === 'shell dumpsys window windows') {
      return this.result('mCurrentFocus=Window{123 u0 com.vivo.packageinstaller/.InstallActivity}')
    }
    if (command === 'exec-out uiautomator dump /dev/tty') return this.result(vivoXml)
    if (command === 'shell pm path com.vivo.packageinstaller') {
      return this.result('package:/system/priv-app/VivoPackageInstaller/base.apk')
    }
    if (command.startsWith('shell input tap ')) {
      this.completeInstall?.()
      return this.result('')
    }
    return this.result('')
  }

  private result(stdout: string): ProcessResult {
    return { code: 0, stdout, stderr: '' }
  }
}

class StuckAfterTapInstallDevice extends BlockingInstallDevice {
  tapCount = 0

  override async run(args: string[], signal: AbortSignal): Promise<ProcessResult> {
    if (args.slice(0, 3).join(' ') === 'shell input tap') {
      this.calls.push(args)
      this.tapCount += 1
      return { code: 0, stdout: '', stderr: '' }
    }
    return super.run(args, signal)
  }
}

class CancelledInstallDevice extends BlockingInstallDevice {
  override async run(args: string[], signal: AbortSignal): Promise<ProcessResult> {
    if (args.join(' ') === 'shell dumpsys window windows') {
      this.calls.push(args)
      return { code: 0, stdout: 'mCurrentFocus=Window{123 u0 com.android.launcher/.Launcher}', stderr: '' }
    }
    return super.run(args, signal)
  }
}

class HonorManualBlockInstallDevice extends BlockingInstallDevice {
  override async run(args: string[], signal: AbortSignal): Promise<ProcessResult> {
    const command = args.join(' ')
    if (command === 'shell dumpsys window windows') {
      this.calls.push(args)
      return {
        code: 0,
        stdout: 'mCurrentFocus=Window{907a4a6 u0 com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity}',
        stderr: '',
      }
    }
    if (command === 'exec-out uiautomator dump /dev/tty') {
      this.calls.push(args)
      return {
        code: 0,
        stdout: honorRiskXml,
        stderr: '',
      }
    }
    if (command === 'shell pm path com.android.packageinstaller') {
      this.calls.push(args)
      return {
        code: 0,
        stdout: 'package:/system/priv-app/PackageInstaller/PackageInstaller.apk',
        stderr: '',
      }
    }
    return super.run(args, signal)
  }
}


const honorRiskCheckedXml = honorRiskXml
  .replace(
    'resource-id="com.android.packageinstaller:id/checkbox" class="android.widget.CheckBox" package="com.android.packageinstaller" content-desc="" checkable="true" checked="false"',
    'resource-id="com.android.packageinstaller:id/checkbox" class="android.widget.CheckBox" package="com.android.packageinstaller" content-desc="" checkable="true" checked="true"',
  )
  .replace(
    'resource-id="android:id/button1" class="android.widget.Button" package="com.android.packageinstaller" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[613,2457][1122,2574]"',
    'resource-id="android:id/button1" class="android.widget.Button" package="com.android.packageinstaller" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[700,2300][1100,2400]"',
  )

class HonorX50TwoStepInstallDevice implements AndroidPreparationDevice {
  readonly calls: string[][] = []
  private stage: 'checkbox' | 'continue' | 'complete' = 'checkbox'
  private completeInstall?: () => void

  async connectionStatus() { return 'online' as const }
  async isPackageInstalled() { return false }

  async run(args: string[], signal: AbortSignal): Promise<ProcessResult> {
    this.calls.push(args)
    const command = args.join(' ')
    if (command.startsWith('install ')) {
      return new Promise<ProcessResult>((resolve, reject) => {
        this.completeInstall = () => resolve(this.result('Success'))
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        )
      })
    }
    if (command === 'shell dumpsys window windows') {
      return this.result(
        'mCurrentFocus=Window{907a4a6 u0 com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity}',
      )
    }
    if (command === 'exec-out uiautomator dump /dev/tty') {
      return this.result(this.stage === 'checkbox' ? honorRiskXml : honorRiskCheckedXml)
    }
    if (command === 'shell pm path com.android.packageinstaller') {
      return this.result('package:/system/priv-app/PackageInstaller/PackageInstaller.apk')
    }
    if (command.startsWith('shell input tap ')) {
      if (this.stage === 'checkbox') {
        this.stage = 'continue'
      } else if (this.stage === 'continue') {
        this.stage = 'complete'
        this.completeInstall?.()
      }
      return this.result('')
    }
    return this.result('')
  }

  private result(stdout: string): ProcessResult {
    return { code: 0, stdout, stderr: '' }
  }
}

class HonorRiskPageStabilizesAtTimeoutDevice extends HonorManualBlockInstallDevice {
  private uiReadCount = 0

  override async run(args: string[], signal: AbortSignal): Promise<ProcessResult> {
    if (args.join(' ') === 'exec-out uiautomator dump /dev/tty') {
      this.calls.push(args)
      this.uiReadCount += 1
      return {
        code: 0,
        stdout: this.uiReadCount === 1 ? scanningXml : honorRiskXml,
        stderr: '',
      }
    }
    return super.run(args, signal)
  }
}

class XiaomiBlockingInstallDevice extends BlockingInstallDevice {
  override async run(args: string[], signal: AbortSignal): Promise<ProcessResult> {
    const command = args.join(' ')
    if (command === 'shell dumpsys window windows') {
      this.calls.push(args)
      return {
        code: 0,
        stdout: 'mCurrentFocus=Window{b9eb1bc u0 com.miui.securitycenter/com.miui.permcenter.install.AdbInstallActivity}',
        stderr: '',
      }
    }
    if (command === 'exec-out uiautomator dump /dev/tty') {
      this.calls.push(args)
      return { code: 0, stdout: xiaomiXml, stderr: '' }
    }
    if (command === 'shell pm path com.miui.securitycenter') {
      this.calls.push(args)
      return {
        code: 0,
        stdout: 'package:/data/app/updated-miui-securitycenter/base.apk',
        stderr: '',
      }
    }
    if (command === 'shell dumpsys package com.miui.securitycenter') {
      this.calls.push(args)
      return {
        code: 0,
        stdout: 'privateFlags=[ PRIVILEGED ]\npkgFlags=[ SYSTEM UPDATED_SYSTEM_APP HAS_CODE ]',
        stderr: '',
      }
    }
    return super.run(args, signal)
  }
}

class XiaomiInputDeniedInstallDevice extends XiaomiBlockingInstallDevice {
  override async run(args: string[], signal: AbortSignal): Promise<ProcessResult> {
    if (args.slice(0, 3).join(' ') === 'shell input tap') {
      this.calls.push(args)
      throw new TaskExecutionError(
        "Exception occurred while executing 'tap': java.lang.SecurityException: Injecting input events requires the caller to have the INJECT_EVENTS permission",
        'INSTALL_DIALOG_UNRECOGNIZED',
      )
    }
    return super.run(args, signal)
  }
}

const scanningXml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="Morpho VideoStabilizer" resource-id="com.vivo.packageinstaller:id/app_name" class="android.widget.TextView" package="com.vivo.packageinstaller" clickable="false" checkable="false" checked="false" bounds="[80,200][1000,300]" />
  <node index="1" text="正在进行安全检测" resource-id="com.vivo.packageinstaller:id/scanning" class="android.widget.TextView" package="com.vivo.packageinstaller" clickable="false" checkable="false" checked="false" bounds="[80,320][1000,420]" />
</hierarchy>`

class DelayedInstallerUiDevice extends BlockingInstallDevice {
  private uiReadCount = 0

  override async run(args: string[], signal: AbortSignal): Promise<ProcessResult> {
    if (args.join(' ') === 'exec-out uiautomator dump /dev/tty') {
      this.calls.push(args)
      this.uiReadCount += 1
      return { code: 0, stdout: this.uiReadCount <= 2 ? scanningXml : vivoXml, stderr: '' }
    }
    return super.run(args, signal)
  }
}

describe('ApkInstallCoordinator', () => {
  it('monitors the OEM dialog while adb install is blocked', async () => {
    const device = new BlockingInstallDevice()
    const dialogs = new SystemDialogController(device, async () => undefined)
    const coordinator = new ApkInstallCoordinator(device, dialogs)
    const events: string[] = []

    const handled = await coordinator.install({
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      apkPath: '/tmp/morpho.apk',
      installMode: 'clean',
      manufacturer: 'vivo',
      diagnosticsDirectory: '/tmp/not-used',
      automation: {
        mode: 'strict-whitelist',
        profileIds: ['vivo-package-installer-v1'],
        timeoutMs: 500,
        pollIntervalMs: 1,
        maxActions: 4,
      },
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event.message),
    })

    expect(handled).toHaveLength(1)
    expect(handled[0]).toMatchObject({
      profileId: 'vivo-package-installer-v1',
      action: 'continue-install',
    })
    expect(device.calls).toContainEqual(['shell', 'input', 'tap', '850', '1760'])
    expect(events.some((message) => message.includes('严格白名单'))).toBe(true)
  })


  it('completes the exact Honor X50 install with a fresh checkbox frame followed by the verified continue button', async () => {
    const device = new HonorX50TwoStepInstallDevice()
    const dialogs = new SystemDialogController(device, async () => undefined)
    const coordinator = new ApkInstallCoordinator(device, dialogs)

    const handled = await coordinator.install({
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      apkPath: '/tmp/morpho.apk',
      installMode: 'clean',
      manufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      diagnosticsDirectory: '/tmp/not-used',
      automation: {
        mode: 'strict-whitelist',
        profileIds: [
          'honor-x50-magic-os-unreviewed-app-install-v1',
          'honor-magic-os-unreviewed-app-block-v1',
        ],
        timeoutMs: 500,
        pollIntervalMs: 1,
        maxActions: 5,
      },
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })

    expect(handled).toEqual([
      expect.objectContaining({
        profileId: 'honor-x50-magic-os-unreviewed-app-install-v1',
        action: 'confirm-checkbox',
      }),
      expect.objectContaining({
        profileId: 'honor-x50-magic-os-unreviewed-app-install-v1',
        action: 'continue-install',
      }),
    ])
    expect(device.calls.filter((args) => args[0] === 'install')).toHaveLength(1)
    expect(device.calls.filter(
      (args) => args.slice(0, 3).join(' ') === 'shell input tap',
    )).toEqual([
      ['shell', 'input', 'tap', '600', '2193'],
      ['shell', 'input', 'tap', '900', '2350'],
    ])
  })

  it('returns a dedicated manual-action error immediately for the real Honor X50 risk page', async () => {
    const diagnosticsDirectory = await mkdtemp(path.join(tmpdir(), 'honor-x50-install-block-coordinator-'))
    const screenshots: string[] = []
    const events: string[] = []
    try {
      const device = new HonorManualBlockInstallDevice()
      const dialogs = new SystemDialogController(device, async (targetPath) => {
        screenshots.push(targetPath)
      })
      const coordinator = new ApkInstallCoordinator(device, dialogs)

      const startedAt = Date.now()
      await expect(coordinator.install({
        packageName: 'com.morphoinc.videopostprocessor',
        applicationLabel: 'Morpho VideoStabilizer',
        apkPath: '/tmp/morpho.apk',
        installMode: 'clean',
        manufacturer: 'HONOR',
        diagnosticsDirectory,
        automation: {
          mode: 'strict-whitelist',
          profileIds: [
            'honor-package-installer-v1',
            'honor-magic-os-unreviewed-app-block-v1',
          ],
          timeoutMs: 20_000,
          pollIntervalMs: 1,
          maxActions: 5,
          unrecognizedGraceMs: 20_000,
        },
        signal: new AbortController().signal,
        onEvent: (event) => events.push(event.message),
      })).rejects.toMatchObject({
        code: 'INSTALL_USER_ACTION_REQUIRED',
        message: expect.stringContaining('需要人工确认安装授权'),
      })

      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(device.calls.filter((args) => args[0] === 'install')).toHaveLength(1)
      expect(device.calls.some((args) => args.slice(0, 3).join(' ') === 'shell input tap')).toBe(false)
      expect(events.some((message) => message.includes('需要人工确认安装授权'))).toBe(true)
      const files = await readdir(diagnosticsDirectory)
      expect(files.some((name) => name.startsWith('current-window-') && name.endsWith('.txt'))).toBe(true)
      expect(files.some((name) => name.startsWith('install-dialog-') && name.endsWith('.xml'))).toBe(true)
      expect(screenshots).toHaveLength(1)
    } finally {
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  })

  it('reclassifies the final Honor frame before reporting an unrecognized timeout', async () => {
    const diagnosticsDirectory = await mkdtemp(path.join(tmpdir(), 'honor-x50-final-frame-'))
    try {
      const device = new HonorRiskPageStabilizesAtTimeoutDevice()
      const dialogs = new SystemDialogController(device, async () => undefined)
      const coordinator = new ApkInstallCoordinator(device, dialogs)

      await expect(coordinator.install({
        packageName: 'com.morphoinc.videopostprocessor',
        applicationLabel: 'Morpho VideoStabilizer',
        apkPath: '/tmp/morpho.apk',
        installMode: 'clean',
        manufacturer: 'HONOR',
        diagnosticsDirectory,
        automation: {
          mode: 'strict-whitelist',
          profileIds: [
            'honor-package-installer-v1',
            'honor-magic-os-unreviewed-app-block-v1',
          ],
          timeoutMs: 500,
          pollIntervalMs: 1,
          maxActions: 5,
          unrecognizedGraceMs: 0,
        },
        signal: new AbortController().signal,
        onEvent: () => undefined,
      })).rejects.toMatchObject({
        code: 'INSTALL_USER_ACTION_REQUIRED',
        message: expect.stringContaining('需要人工确认安装授权'),
      })

      expect(device.calls.some(
        (args) => args.slice(0, 3).join(' ') === 'shell input tap',
      )).toBe(false)
    } finally {
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  })

  it('completes a blocked Xiaomi HyperOS install with one strict continue action', async () => {
    const device = new XiaomiBlockingInstallDevice()
    const dialogs = new SystemDialogController(device, async () => undefined)
    const coordinator = new ApkInstallCoordinator(device, dialogs)

    const handled = await coordinator.install({
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      apkPath: '/tmp/morpho.apk',
      installMode: 'clean',
      manufacturer: 'Xiaomi',
      diagnosticsDirectory: '/tmp/not-used',
      automation: {
        mode: 'strict-whitelist',
        profileIds: ['xiaomi-hyperos-package-installer-v1'],
        timeoutMs: 500,
        pollIntervalMs: 1,
        maxActions: 5,
      },
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })

    expect(handled).toEqual([expect.objectContaining({
      profileId: 'xiaomi-hyperos-package-installer-v1',
      action: 'continue-install',
    })])
    expect(device.calls.filter((args) => args[0] === 'install')).toHaveLength(1)
    expect(device.calls).toContainEqual(['shell', 'input', 'tap', '311', '2187'])
    expect(device.calls).not.toContainEqual(['shell', 'input', 'tap', '540', '2066'])
  })

  it('stops a Xiaomi install immediately with diagnostics when HyperOS denies touch injection', async () => {
    const diagnosticsDirectory = await mkdtemp(path.join(tmpdir(), 'xiaomi-install-denied-'))
    const screenshots: string[] = []
    try {
      const device = new XiaomiInputDeniedInstallDevice()
      const dialogs = new SystemDialogController(device, async (targetPath) => {
        screenshots.push(targetPath)
      })
      const coordinator = new ApkInstallCoordinator(device, dialogs)

      await expect(coordinator.install({
        packageName: 'com.morphoinc.videopostprocessor',
        applicationLabel: 'Morpho VideoStabilizer',
        apkPath: '/tmp/morpho.apk',
        installMode: 'clean',
        manufacturer: 'Xiaomi',
        diagnosticsDirectory,
        automation: {
          mode: 'strict-whitelist',
          profileIds: ['xiaomi-hyperos-package-installer-v1'],
          timeoutMs: 500,
          pollIntervalMs: 1,
          maxActions: 5,
        },
        signal: new AbortController().signal,
        onEvent: () => undefined,
      })).rejects.toMatchObject({
        code: 'DEVICE_INPUT_AUTOMATION_DENIED',
        message: expect.stringMatching(/USB 调试（安全设置）.*网络 ADB/),
      })

      expect(device.calls.filter((args) => args[0] === 'install')).toHaveLength(1)
      expect(device.calls.filter(
        (args) => args.slice(0, 3).join(' ') === 'shell input tap',
      )).toHaveLength(1)
      const files = await readdir(diagnosticsDirectory)
      expect(files.some((name) => name.startsWith('current-window-') && name.endsWith('.txt'))).toBe(true)
      expect(files.some((name) => name.startsWith('install-dialog-') && name.endsWith('.xml'))).toBe(true)
      expect(screenshots).toHaveLength(1)
    } finally {
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  })

  it('reports a recognized action with no visible transition as an install timeout, not an unknown page', async () => {
    const device = new StuckAfterTapInstallDevice()
    const dialogs = new SystemDialogController(device, async () => undefined)
    const coordinator = new ApkInstallCoordinator(device, dialogs)

    await expect(coordinator.install({
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      apkPath: '/tmp/morpho.apk',
      installMode: 'clean',
      manufacturer: 'vivo',
      diagnosticsDirectory: '/tmp/not-used',
      automation: {
        mode: 'strict-whitelist',
        profileIds: ['vivo-package-installer-v1'],
        timeoutMs: 120,
        pollIntervalMs: 1,
        maxActions: 4,
        unrecognizedGraceMs: 20,
      },
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })).rejects.toMatchObject({
      code: 'INSTALL_DIALOG_TIMEOUT',
    })

    expect(device.tapCount).toBe(1)
  })

  it('stops monitoring and never clicks after task cancellation', async () => {
    const device = new CancelledInstallDevice()
    const dialogs = new SystemDialogController(device, async () => undefined)
    const coordinator = new ApkInstallCoordinator(device, dialogs)
    const controller = new AbortController()

    const installing = coordinator.install({
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      apkPath: '/tmp/morpho.apk',
      installMode: 'clean',
      manufacturer: 'vivo',
      diagnosticsDirectory: '/tmp/not-used',
      automation: {
        mode: 'strict-whitelist',
        profileIds: ['vivo-package-installer-v1'],
        timeoutMs: 500,
        pollIntervalMs: 1,
        maxActions: 4,
      },
      signal: controller.signal,
      onEvent: () => undefined,
    })
    setTimeout(() => controller.abort(), 5)

    await expect(installing).rejects.toMatchObject({ name: 'AbortError' })
    expect(device.calls.some((args) => args.slice(0, 3).join(' ') === 'shell input tap')).toBe(false)
  })

  it('allows a known installer UI to finish rendering before classifying it as unknown', async () => {
    const device = new DelayedInstallerUiDevice()
    const dialogs = new SystemDialogController(device, async () => undefined)
    const coordinator = new ApkInstallCoordinator(device, dialogs)

    const handled = await coordinator.install({
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      apkPath: '/tmp/morpho.apk',
      installMode: 'clean',
      manufacturer: 'vivo',
      diagnosticsDirectory: '/tmp/not-used',
      automation: {
        mode: 'strict-whitelist',
        profileIds: ['vivo-package-installer-v1'],
        timeoutMs: 500,
        pollIntervalMs: 1,
        maxActions: 4,
        unrecognizedGraceMs: 50,
      },
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })

    expect(handled).toHaveLength(1)
    expect(handled[0]?.profileId).toBe('vivo-package-installer-v1')
  })
})
