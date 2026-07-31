import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { ProcessResult } from '../../process.js'
import type { AndroidPreparationDevice } from './contracts.js'
import { SystemDialogController } from './system-dialog-controller.js'

const fixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
  'utf8',
)

class DialogFakeDevice implements AndroidPreparationDevice {
  readonly calls: string[][] = []

  constructor(
    private readonly xml: string,
    private readonly windowsDump = 'mCurrentFocus=Window{123 u0 com.vivo.packageinstaller/.InstallActivity}',
    private readonly fullWindowDump = windowsDump,
    private readonly androidInstallerPath = 'package:/system/priv-app/PackageInstaller/PackageInstaller.apk',
    private readonly androidInstallerDump = '',
  ) {}

  async connectionStatus() { return 'online' as const }
  async isPackageInstalled() { return true }

  async run(args: string[]): Promise<ProcessResult> {
    this.calls.push(args)
    const command = args.join(' ')
    if (command === 'shell dumpsys window windows') return this.result(this.windowsDump)
    if (command === 'shell dumpsys window') return this.result(this.fullWindowDump)
    if (command === 'exec-out uiautomator dump /dev/tty') return this.result(this.xml)
    if (command === 'shell pm path com.vivo.packageinstaller') {
      return this.result('package:/system/priv-app/VivoPackageInstaller/base.apk')
    }
    if (command === 'shell pm path com.android.packageinstaller') {
      return this.result(this.androidInstallerPath)
    }
    if (command === 'shell dumpsys package com.android.packageinstaller') {
      return this.result(this.androidInstallerDump)
    }
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
    const result = await controller.inspectAndHandle({
      manufacturer: 'vivo',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
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
    const result = await controller.inspectAndHandle({
      manufacturer: 'vivo',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
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
    const result = await controller.inspectAndHandle({
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      profileIds: ['honor-package-installer-v1'],
      diagnosticsDirectory: '/tmp/not-used',
      maxActions: 4,
      signal: new AbortController().signal,
      activeInstall: true,
    })

    expect(result.kind).toBe('handled')
    expect(device.calls).toContainEqual(['shell', 'dumpsys', 'package', 'com.android.packageinstaller'])
    expect(device.calls).toContainEqual(['shell', 'input', 'tap', '852', '2464'])
  })

  it('does not click a generic unrelated continue dialog', async () => {
    const device = new DialogFakeDevice(fixture('unrelated-dialog.xml'))
    const controller = new SystemDialogController(device, async () => undefined)
    const result = await controller.inspectAndHandle({
      manufacturer: 'vivo',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      profileIds: ['vivo-package-installer-v1'],
      diagnosticsDirectory: '/tmp/not-used',
      maxActions: 4,
      signal: new AbortController().signal,
    })

    expect(result.kind).toBe('unrecognized')
    expect(device.calls.some((args) => args.slice(0, 3).join(' ') === 'shell input tap')).toBe(false)
  })
})
