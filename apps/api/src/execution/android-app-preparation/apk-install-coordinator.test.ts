import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { ProcessResult } from '../../process.js'
import { ApkInstallCoordinator } from './apk-install-coordinator.js'
import type { AndroidPreparationDevice } from './contracts.js'
import { SystemDialogController } from './system-dialog-controller.js'

const vivoXml = readFileSync(
  fileURLToPath(new URL('./__fixtures__/vivo-install-warning.xml', import.meta.url)),
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

class CancelledInstallDevice extends BlockingInstallDevice {
  override async run(args: string[], signal: AbortSignal): Promise<ProcessResult> {
    if (args.join(' ') === 'shell dumpsys window windows') {
      this.calls.push(args)
      return { code: 0, stdout: 'mCurrentFocus=Window{123 u0 com.android.launcher/.Launcher}', stderr: '' }
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
