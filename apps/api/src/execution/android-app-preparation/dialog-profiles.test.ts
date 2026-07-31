import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { matchDialogAction } from './dialog-profiles.js'
import { parseUiNodes } from './ui-xml.js'

const fixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
  'utf8',
)

describe('strict Android system dialog profiles', () => {
  it('matches a vivo installer warning only with the complete identity and features', () => {
    const match = matchDialogAction(['vivo-package-installer-v1'], {
      manufacturer: 'vivo',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.vivo.packageinstaller',
      activeInstall: true,
      nodes: parseUiNodes(fixture('vivo-install-warning.xml')),
    })
    expect(match?.profileId).toBe('vivo-package-installer-v1')
    expect(match?.action).toBe('continue-install')
    expect(match?.node.text).toBe('继续')
  })


  it('matches the real vivo OriginOS continue-install button after risk confirmation', () => {
    const xml = fixture('vivo-originos-real-install-warning.xml')
      .replace('checkable="true" checked="false" clickable="true"', 'checkable="true" checked="true" clickable="true"')
    const match = matchDialogAction(['vivo-package-installer-v1'], {
      manufacturer: 'vivo',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      activeInstall: true,
      nodes: parseUiNodes(xml),
    })

    expect(match?.profileId).toBe('vivo-package-installer-v1')
    expect(match?.action).toBe('continue-install')
    expect(match?.node.contentDescription || match?.node.text).toBe('继续安装')
  })

  it('matches the real OPPO ColorOS sensitive-permission install guide', () => {
    const match = matchDialogAction(['oplus-package-installer-v1'], {
      manufacturer: 'OPPO',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.oplus.appdetail',
      activeInstall: true,
      nodes: parseUiNodes(fixture('oplus-coloros-real-install-risk.xml')),
    })

    expect(match?.profileId).toBe('oplus-package-installer-v1')
    expect(match?.action).toBe('continue-install')
    expect(match?.node.resourceId).toBe('com.oplus.appdetail:id/btn_left')
    expect(match?.node.text).toBe('继续安装')
  })

  it('matches the real OPPO combined camera and microphone permission dialog', () => {
    const match = matchDialogAction(['android-runtime-permission-v1'], {
      manufacturer: 'OPPO',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.permissioncontroller',
      activeInstall: false,
      nodes: parseUiNodes(fixture('oplus-coloros-runtime-permissions.xml')),
    })

    expect(match?.profileId).toBe('android-runtime-permission-v1')
    expect(match?.action).toBe('allow-permission')
    expect(match?.node.resourceId).toBe(
      'com.android.permissioncontroller:id/permission_allow_button',
    )
    expect(match?.node.text).toBe('确定')
  })

  it('matches the real OPPO storage compatibility warning only through its dedicated profile', () => {
    const match = matchDialogAction(['oplus-storage-compatibility-warning-v1'], {
      manufacturer: 'OPPO',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.permissioncontroller',
      focusedWindowComponent: 'com.android.permissioncontroller/com.oplusos.permissioncontroller.permission.ui.OplusCompatibilityAlertActivity',
      activeInstall: false,
      nodes: parseUiNodes(fixture('oplus-coloros-storage-compatibility-warning.xml')),
    })

    expect(match?.profileId).toBe('oplus-storage-compatibility-warning-v1')
    expect(match?.action).toBe('dismiss-compatibility-warning')
    expect(match?.node.resourceId).toBe('android:id/button1')
    expect(match?.node.text).toBe('确定')
  })

  it('does not dismiss the storage warning when the focused activity is not the verified ColorOS compatibility controller', () => {
    const match = matchDialogAction(['oplus-storage-compatibility-warning-v1'], {
      manufacturer: 'OPPO',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.permissioncontroller',
      focusedWindowComponent: 'com.android.permissioncontroller/.UnrelatedActivity',
      activeInstall: false,
      nodes: parseUiNodes(fixture('oplus-coloros-storage-compatibility-warning.xml')),
    })

    expect(match).toBeUndefined()
  })

  it('never treats a generic permission-controller confirm button as permission approval', () => {
    const xml = fixture('oplus-coloros-runtime-permissions.xml')
      .replace('“Morpho VideoStabilizer”需要使用以下权限', '系统设置')
      .replace('摄像头', '通知')
      .replace('麦克风', '后台活动')
    const match = matchDialogAction(['android-runtime-permission-v1'], {
      manufacturer: 'OPPO',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.permissioncontroller',
      activeInstall: false,
      nodes: parseUiNodes(xml),
    })

    expect(match).toBeUndefined()
  })

  it('clicks the confirmation checkbox before the Honor continue button', () => {
    const match = matchDialogAction(['honor-package-installer-v1'], {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.hihonor.systemmanager',
      activeInstall: true,
      nodes: parseUiNodes(fixture('honor-install-warning.xml')),
    })
    expect(match?.action).toBe('confirm-checkbox')
    expect(match?.node.resourceId).toContain('confirm')
  })


  it('matches the real Honor MagicOS warning using the verified active install request', () => {
    const match = matchDialogAction(['honor-package-installer-v1'], {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      activeInstall: true,
      nodes: parseUiNodes(fixture('honor-magic-os-real-install-warning.xml')),
    })

    expect(match?.profileId).toBe('honor-package-installer-v1')
    expect(match?.action).toBe('continue-install')
    expect(match?.node.text).toBe('继续')
  })


  it('handles the second real Honor MagicOS risk confirmation screen', () => {
    const xml = fixture('honor-magic-os-real-install-confirmation.xml')
    const checkbox = matchDialogAction(['honor-package-installer-v1'], {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      activeInstall: true,
      nodes: parseUiNodes(xml),
    })
    const continueButton = matchDialogAction(['honor-package-installer-v1'], {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      activeInstall: true,
      nodes: parseUiNodes(xml.replace('checkable="true" checked="false" clickable="true"', 'checkable="true" checked="true" clickable="true"')),
    })

    expect(checkbox?.action).toBe('confirm-checkbox')
    expect(checkbox?.node.text).toContain('未经安全检测')
    expect(continueButton?.action).toBe('continue-install')
    expect(continueButton?.node.text).toBe('继续安装')
  })

  it('does not use coordinator identity evidence outside an active install', () => {
    const match = matchDialogAction(['honor-package-installer-v1'], {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      activeInstall: false,
      nodes: parseUiNodes(fixture('honor-magic-os-real-install-warning.xml')),
    })

    expect(match).toBeUndefined()
  })

  it('matches an Android runtime permission dialog', () => {
    const match = matchDialogAction(['android-runtime-permission-v1'], {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.permissioncontroller',
      activeInstall: true,
      nodes: parseUiNodes(fixture('android-camera-permission.xml')),
    })
    expect(match?.action).toBe('allow-permission')
  })

  it('never matches a generic continue button without Morpho identity and two features', () => {
    const match = matchDialogAction(['vivo-package-installer-v1'], {
      manufacturer: 'vivo',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.vivo.packageinstaller',
      activeInstall: true,
      nodes: parseUiNodes(fixture('unrelated-dialog.xml')),
    })
    expect(match).toBeUndefined()
  })
})
