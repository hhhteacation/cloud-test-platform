import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { evaluateDialogProfiles, matchDialogAction, matchDialogBlock } from './dialog-profiles.js'
import {
  extractFocusedWindowComponent,
  extractFocusedWindowPackage,
  parseUiNodes,
} from './ui-xml.js'

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
      phase: 'install',
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
      phase: 'install',
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
      focusedWindowComponent: 'com.oplus.appdetail/com.oplus.appdetail.model.guide.ui.InstallGuideActivity',
      phase: 'install',
      nodes: parseUiNodes(fixture('oplus-coloros-real-install-risk.xml')),
    })

    expect(match?.profileId).toBe('oplus-package-installer-v1')
    expect(match?.action).toBe('continue-install')
    expect(match?.node.resourceId).toBe('com.oplus.appdetail:id/btn_left')
    expect(match?.node.text).toBe('继续安装')
  })


  it('matches the captured OnePlus PKR110 ColorOS 15 install guide through the same strict OPlus profile', () => {
    const match = matchDialogAction(['oplus-package-installer-v1'], {
      manufacturer: 'OnePlus',
      deviceModel: 'PKR110',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.oplus.appdetail',
      focusedWindowComponent: 'com.oplus.appdetail/com.oplus.appdetail.model.guide.ui.InstallGuideActivity',
      phase: 'install',
      nodes: parseUiNodes(fixture('pkr110-oplus-install-guide.xml')),
    })

    expect(match?.profileId).toBe('oplus-package-installer-v1')
    expect(match?.action).toBe('continue-install')
    expect(match?.node.resourceId).toBe('com.oplus.appdetail:id/btn_left')
    expect(match?.node.text).toBe('继续安装')
  })

  it('matches the real OPPO PJV110 ColorOS scan-result page that has no tv_risk nodes', () => {
    const match = matchDialogAction(['oplus-package-installer-v1'], {
      manufacturer: 'OPPO',
      deviceModel: 'PJV110',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.oplus.appdetail',
      focusedWindowComponent: 'com.oplus.appdetail/com.oplus.appdetail.model.guide.ui.InstallGuideActivity',
      phase: 'install',
      nodes: parseUiNodes(fixture('pjv110-oplus-install-guide.xml')),
    })

    expect(match?.profileId).toBe('oplus-package-installer-v1')
    expect(match?.action).toBe('continue-install')
    expect(match?.node.resourceId).toBe('com.oplus.appdetail:id/btn_left')
    expect(match?.node.text).toBe('继续安装')
  })

  it('still rejects the PJV110 scan-result page when its own verified nodes are missing', () => {
    const incompleteXml = fixture('pjv110-oplus-install-guide.xml')
      .replaceAll('com.oplus.appdetail:id/tv_result_title', 'com.oplus.appdetail:id/unknown_result_title')
    const match = matchDialogAction(['oplus-package-installer-v1'], {
      manufacturer: 'OPPO',
      deviceModel: 'PJV110',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.oplus.appdetail',
      focusedWindowComponent: 'com.oplus.appdetail/com.oplus.appdetail.model.guide.ui.InstallGuideActivity',
      phase: 'install',
      nodes: parseUiNodes(incompleteXml),
    })

    expect(match).toBeUndefined()
  })

  it('does not reuse the OPlus install action on another com.oplus.appdetail activity', () => {
    const match = matchDialogAction(['oplus-package-installer-v1'], {
      manufacturer: 'OnePlus',
      deviceModel: 'PKR110',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.oplus.appdetail',
      focusedWindowComponent: 'com.oplus.appdetail/com.oplus.appdetail.model.cancel.CancelInstallActivity',
      phase: 'install',
      nodes: parseUiNodes(fixture('pkr110-oplus-install-guide.xml')),
    })

    expect(match).toBeUndefined()
  })

  it('requires the verified OPlus resource-id set instead of matching generic risk text alone', () => {
    const incompleteXml = fixture('pkr110-oplus-install-guide.xml')
      .replaceAll('com.oplus.appdetail:id/tv_result_desc', 'com.oplus.appdetail:id/unknown_result_desc')
    const match = matchDialogAction(['oplus-package-installer-v1'], {
      manufacturer: 'OnePlus',
      deviceModel: 'PKR110',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.oplus.appdetail',
      focusedWindowComponent: 'com.oplus.appdetail/com.oplus.appdetail.model.guide.ui.InstallGuideActivity',
      phase: 'install',
      nodes: parseUiNodes(incompleteXml),
    })

    expect(match).toBeUndefined()
  })

  it('matches the real Xiaomi HyperOS ADB install confirmation without toggling its opt-out checkbox', () => {
    const match = matchDialogAction(['xiaomi-hyperos-package-installer-v1'], {
      manufacturer: 'Xiaomi',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.miui.securitycenter',
      focusedWindowComponent: 'com.miui.securitycenter/com.miui.permcenter.install.AdbInstallActivity',
      phase: 'install',
      nodes: parseUiNodes(fixture('xiaomi-hyperos-adb-install-confirmation.xml')),
    })

    expect(match?.profileId).toBe('xiaomi-hyperos-package-installer-v1')
    expect(match?.action).toBe('continue-install')
    expect(match?.node.resourceId).toBe('android:id/button2')
    expect(match?.node.text).toBe('继续安装')
    expect(match?.node.resourceId).not.toBe('com.miui.securitycenter:id/do_not_ask_checkbox')
  })

  it('refuses the Xiaomi HyperOS install action when a strict identity or page guard is missing', () => {
    const xml = fixture('xiaomi-hyperos-adb-install-confirmation.xml')
    const base = {
      manufacturer: 'Xiaomi',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.miui.securitycenter',
      focusedWindowComponent: 'com.miui.securitycenter/com.miui.permcenter.install.AdbInstallActivity',
      phase: 'install',
      nodes: parseUiNodes(xml),
    }
    const guardedContexts = [
      { ...base, manufacturer: 'OPPO' },
      { ...base, packageName: 'com.example.unreviewed' },
      { ...base, focusedWindowPackage: 'com.example.browser' },
      { ...base, focusedWindowComponent: 'com.miui.securitycenter/.UnrelatedActivity' },
      { ...base, nodes: parseUiNodes(xml.replace('Morpho VideoStabilizer', 'Unknown application')) },
      { ...base, nodes: parseUiNodes(xml.replace('USB安装提示', '安装提示')) },
      { ...base, nodes: parseUiNodes(xml.replace('正在通过USB安装此应用，是否继续？', '是否继续？')) },
      { ...base, nodes: parseUiNodes(xml.replace(
        'resource-id="com.miui.securitycenter:id/do_not_ask_checkbox"',
        'resource-id="com.miui.securitycenter:id/unknown_checkbox"',
      )) },
      { ...base, nodes: parseUiNodes(xml.replace('resource-id="android:id/button2"', 'resource-id="android:id/unknown"')) },
      { ...base, nodes: parseUiNodes(xml.replace('text="继续安装"', 'text="安装"')) },
    ]

    for (const context of guardedContexts) {
      expect(matchDialogAction(['xiaomi-hyperos-package-installer-v1'], context)).toBeUndefined()
    }
  })

  it('matches the real OPPO combined camera and microphone permission dialog', () => {
    const match = matchDialogAction(['android-runtime-permission-v1'], {
      manufacturer: 'OPPO',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.permissioncontroller',
      phase: 'runtime-permission',
      nodes: parseUiNodes(fixture('oplus-coloros-runtime-permissions.xml')),
    })

    expect(match?.profileId).toBe('android-runtime-permission-v1')
    expect(match?.action).toBe('allow-permission')
    expect(match?.node.resourceId).toBe(
      'com.android.permissioncontroller:id/permission_allow_button',
    )
    expect(match?.node.text).toBe('确定')
  })

  it('matches the real Xiaomi 15 Pro Android 16 permission dialog without resource-id buttons', () => {
    const match = matchDialogAction(['android-runtime-permission-v1'], {
      manufacturer: 'Xiaomi',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.permissioncontroller',
      focusedWindowComponent: 'com.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity',
      phase: 'runtime-permission',
      nodes: parseUiNodes(fixture('xiaomi-15pro-android16-runtime-permission.xml')),
    })

    expect(match?.profileId).toBe('android-runtime-permission-v1')
    expect(match?.action).toBe('allow-permission')
    expect(match?.node.text).toBe('仅在使用中允许')
  })

  it('refuses the Android 16 permission dialog when its wording does not match the whitelist', () => {
    const xml = fixture('xiaomi-15pro-android16-runtime-permission.xml')
      .replace('text="仅在使用中允许"', 'text="短期内允许"')
      .replace('拍摄照片或录制视频', '访问媒体文件')
    const match = matchDialogAction(['android-runtime-permission-v1'], {
      manufacturer: 'Xiaomi',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.permissioncontroller',
      focusedWindowComponent: 'com.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity',
      phase: 'runtime-permission',
      nodes: parseUiNodes(xml),
    })

    expect(match).toBeUndefined()
  })

  it('matches the real OPPO storage compatibility warning only through its dedicated profile', () => {
    const match = matchDialogAction(['oplus-storage-compatibility-warning-v1'], {
      manufacturer: 'OPPO',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.permissioncontroller',
      focusedWindowComponent: 'com.android.permissioncontroller/com.oplusos.permissioncontroller.permission.ui.OplusCompatibilityAlertActivity',
      phase: 'post-launch',
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
      phase: 'post-launch',
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
      phase: 'post-launch',
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
      phase: 'install',
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
      phase: 'install',
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
      phase: 'install',
      nodes: parseUiNodes(xml),
    })
    const continueButton = matchDialogAction(['honor-package-installer-v1'], {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      phase: 'install',
      nodes: parseUiNodes(xml.replace('checkable="true" checked="false" clickable="true"', 'checkable="true" checked="true" clickable="true"')),
    })

    expect(checkbox?.action).toBe('confirm-checkbox')
    expect(checkbox?.node.text).toContain('未经安全检测')
    expect(continueButton?.action).toBe('continue-install')
    expect(continueButton?.node.text).toBe('继续安装')
  })

  it('uses the exact Honor X50 profile for the unknown-source warning before the generic Honor profile', () => {
    const window = fixture('honor-x50-package-installer-unknown-source-warning.window.txt')
    const decision = evaluateDialogProfiles([
      'honor-package-installer-v1',
      'honor-x50-unknown-source-warning-v1',
      'honor-x50-icp-notice-v1',
      'honor-x50-magic-os-unreviewed-app-install-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], {
      manufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: extractFocusedWindowPackage(window),
      focusedWindowComponent: extractFocusedWindowComponent(window),
      phase: 'install',
      nodes: parseUiNodes(fixture('honor-x50-package-installer-unknown-source-warning.xml')),
    })

    expect(decision).toMatchObject({
      kind: 'action',
      action: {
        profileId: 'honor-x50-unknown-source-warning-v1',
        action: 'continue-install',
        node: { resourceId: 'android:id/button1', text: '继续', enabled: true },
      },
    })
  })

  it('acknowledges only the exact Honor X50 ICP notice node', () => {
    const window = fixture('honor-x50-package-installer-icp-notice.window.txt')
    const decision = evaluateDialogProfiles([
      'honor-package-installer-v1',
      'honor-x50-unknown-source-warning-v1',
      'honor-x50-icp-notice-v1',
      'honor-x50-magic-os-unreviewed-app-install-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], {
      manufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: extractFocusedWindowPackage(window),
      focusedWindowComponent: extractFocusedWindowComponent(window),
      phase: 'install',
      nodes: parseUiNodes(fixture('honor-x50-package-installer-icp-notice.xml')),
    })

    expect(decision).toMatchObject({
      kind: 'action',
      action: {
        profileId: 'honor-x50-icp-notice-v1',
        action: 'acknowledge-install-notice',
        node: { resourceId: 'android:id/button1', text: '知道了', enabled: true },
      },
    })
  })

  it('does not fall back to the generic Honor profile inside the X50 Morpho installer scope', () => {
    const window = fixture('honor-x50-package-installer-unknown-source-warning.window.txt')
    const decision = evaluateDialogProfiles(['honor-package-installer-v1'], {
      manufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: extractFocusedWindowPackage(window),
      focusedWindowComponent: extractFocusedWindowComponent(window),
      phase: 'install',
      nodes: parseUiNodes(fixture('honor-x50-package-installer-unknown-source-warning.xml')),
    })

    expect(decision).toEqual({ kind: 'none' })
  })

  it('refuses each X50 preflight action when its exact page evidence is incomplete', () => {
    const unknownSourceWindow = fixture('honor-x50-package-installer-unknown-source-warning.window.txt')
    const icpWindow = fixture('honor-x50-package-installer-icp-notice.window.txt')
    const base = {
      manufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      phase: 'install',
    }
    const cases = [
      {
        profileIds: ['honor-x50-unknown-source-warning-v1'],
        context: {
          ...base,
          focusedWindowPackage: extractFocusedWindowPackage(unknownSourceWindow),
          focusedWindowComponent: extractFocusedWindowComponent(unknownSourceWindow),
          nodes: parseUiNodes(fixture('honor-x50-package-installer-unknown-source-warning.xml')
            .replace('resource-id="android:id/message"', 'resource-id="android:id/unknown"')),
        },
      },
      {
        profileIds: ['honor-x50-icp-notice-v1'],
        context: {
          ...base,
          focusedWindowPackage: extractFocusedWindowPackage(icpWindow),
          focusedWindowComponent: extractFocusedWindowComponent(icpWindow),
          nodes: parseUiNodes(fixture('honor-x50-package-installer-icp-notice.xml')
            .replace('text="知道了"', 'text="继续"')),
        },
      },
      {
        profileIds: ['honor-x50-unknown-source-warning-v1'],
        context: {
          ...base,
          deviceModel: 'FCP-AN10',
          focusedWindowPackage: extractFocusedWindowPackage(unknownSourceWindow),
          focusedWindowComponent: extractFocusedWindowComponent(unknownSourceWindow),
          nodes: parseUiNodes(fixture('honor-x50-package-installer-unknown-source-warning.xml')),
        },
      },
    ]

    for (const testCase of cases) {
      expect(evaluateDialogProfiles(testCase.profileIds, testCase.context).kind).not.toBe('action')
    }
  })

  it('automates the exact Honor X50 risk checkbox before the manual block fallback', () => {
    const decision = evaluateDialogProfiles([
      'honor-x50-magic-os-unreviewed-app-install-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], {
      manufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'install',
      nodes: parseUiNodes(fixture(
        'honor-x50-magic-os-9-package-installer-recommendations-install.xml',
      )),
    })

    expect(decision).toMatchObject({
      kind: 'action',
      action: {
        profileId: 'honor-x50-magic-os-unreviewed-app-install-v1',
        action: 'confirm-checkbox',
        node: { resourceId: 'com.android.packageinstaller:id/checkbox', checked: false },
      },
    })
  })


  it('only enables the exact Honor X50 continue button after the current XML reports the risk checkbox checked', () => {
    const xml = fixture('honor-x50-magic-os-9-package-installer-recommendations-install.xml')
      .replace(
        'resource-id="com.android.packageinstaller:id/checkbox" class="android.widget.CheckBox" package="com.android.packageinstaller" content-desc="" checkable="true" checked="false"',
        'resource-id="com.android.packageinstaller:id/checkbox" class="android.widget.CheckBox" package="com.android.packageinstaller" content-desc="" checkable="true" checked="true"',
      )
    const decision = evaluateDialogProfiles([
      'honor-x50-magic-os-unreviewed-app-install-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], {
      manufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'install',
      nodes: parseUiNodes(xml),
    })

    expect(decision).toMatchObject({
      kind: 'action',
      action: {
        profileId: 'honor-x50-magic-os-unreviewed-app-install-v1',
        action: 'continue-install',
        node: {
          resourceId: 'android:id/button1',
          text: '继续安装',
          enabled: true,
        },
      },
    })
    if (decision.kind === 'action') {
      expect(decision.action.node.resourceId).not.toBe('com.android.packageinstaller:id/btn_download')
      expect(decision.action.node.resourceId).not.toBe('com.android.packageinstaller:id/btn_offical_install')
    }
  })

  it('keeps the Honor risk page blocked when the exact X50 model identity is missing or different', () => {
    const base = {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'install',
      nodes: parseUiNodes(fixture(
        'honor-x50-magic-os-9-package-installer-recommendations-install.xml',
      )),
    }

    for (const context of [base, { ...base, deviceModel: 'FCP-AN10' }]) {
      expect(evaluateDialogProfiles([
        'honor-x50-magic-os-unreviewed-app-install-v1',
        'honor-magic-os-unreviewed-app-block-v1',
      ], context)).toMatchObject({
        kind: 'block',
        block: { profileId: 'honor-magic-os-unreviewed-app-block-v1' },
      })
    }
  })

  it('never returns an Honor X50 action when a required page identity or verified target guard is missing', () => {
    const sourceXml = fixture('honor-x50-magic-os-9-package-installer-recommendations-install.xml')
    const base = {
      manufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'install',
    }
    const guardedContexts = [
      { ...base, manufacturer: 'Xiaomi', nodes: parseUiNodes(sourceXml) },
      { ...base, packageName: 'com.example.unreviewed', nodes: parseUiNodes(sourceXml) },
      { ...base, phase: 'post-launch', nodes: parseUiNodes(sourceXml) },
      { ...base, focusedWindowComponent: 'com.android.packageinstaller/.OtherActivity', nodes: parseUiNodes(sourceXml) },
      { ...base, nodes: parseUiNodes(sourceXml.replaceAll('未经荣耀安全审核', '风险未知')) },
      { ...base, nodes: parseUiNodes(sourceXml.replaceAll('该应用未上架', '来源未知')) },
      { ...base, nodes: parseUiNodes(sourceXml.replace('id/risk_desc_tv_error', 'id/other_desc')) },
      { ...base, nodes: parseUiNodes(sourceXml.replace('id/checkbox', 'id/other_checkbox')) },
      { ...base, nodes: parseUiNodes(sourceXml.replace('android:id/button1', 'android:id/other_button')) },
      { ...base, nodes: parseUiNodes(sourceXml.replace('enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[78,2098][1122,2288]"', 'enabled="false" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[78,2098][1122,2288]"')) },
    ]

    for (const [index, context] of guardedContexts.entries()) {
      expect(
        evaluateDialogProfiles([
          'honor-x50-magic-os-unreviewed-app-install-v1',
          'honor-magic-os-unreviewed-app-block-v1',
        ], context).kind,
        `X50 action guard ${index}`,
      ).not.toBe('action')
    }
  })

  it('blocks the real Honor X50 risk page with recommendation buttons before any action match', () => {
    const xml = fixture('honor-x50-magic-os-9-package-installer-recommendations.xml')
    const context = {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'install',
      nodes: parseUiNodes(xml),
    }

    expect(matchDialogBlock([
      'honor-package-installer-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], context)).toEqual({
      profileId: 'honor-magic-os-unreviewed-app-block-v1',
      reason: 'honor-install-authorization-required',
      summary: expect.stringContaining('需要人工确认安装授权'),
    })
    expect(matchDialogAction([
      'honor-package-installer-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], context)).toBeUndefined()
  })

  it('blocks the latest Honor X50 recommendation variant from the failed task', () => {
    const window = fixture('honor-x50-magic-os-9-package-installer-recommendations-install.window.txt')
    const context = {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: extractFocusedWindowPackage(window),
      focusedWindowComponent: extractFocusedWindowComponent(window),
      phase: 'install',
      nodes: parseUiNodes(fixture(
        'honor-x50-magic-os-9-package-installer-recommendations-install.xml',
      )),
    }

    expect(matchDialogBlock([
      'honor-package-installer-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], context)).toMatchObject({
      profileId: 'honor-magic-os-unreviewed-app-block-v1',
      reason: 'honor-install-authorization-required',
    })
    expect(matchDialogAction([
      'honor-package-installer-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], context)).toBeUndefined()
  })

  it('never chooses Honor recommendation buttons after the risk checkbox is checked', () => {
    const xml = fixture('honor-x50-magic-os-9-package-installer-recommendations.xml')
      .replace('checkable="true" checked="false" clickable="true"', 'checkable="true" checked="true" clickable="true"')
    const context = {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'install',
      nodes: parseUiNodes(xml),
    }

    expect(matchDialogAction(['honor-package-installer-v1'], context)).toBeUndefined()
  })

  it('does not apply the Honor recommendation block to another manufacturer', () => {
    const context = {
      manufacturer: 'Xiaomi',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'install',
      nodes: parseUiNodes(fixture('honor-x50-magic-os-9-package-installer-recommendations.xml')),
    }

    expect(matchDialogBlock(['honor-magic-os-unreviewed-app-block-v1'], context)).toBeUndefined()
  })

  it('requires every identity and page-structure guard for the Honor recommendation block', () => {
    const xml = fixture('honor-x50-magic-os-9-package-installer-recommendations.xml')
    const base = {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'install',
      nodes: parseUiNodes(xml),
    }
    const guardedContexts = [
      { ...base, packageName: 'com.example.unreviewed' },
      { ...base, focusedWindowPackage: 'com.android.permissioncontroller' },
      { ...base, focusedWindowComponent: 'com.android.packageinstaller/.OtherActivity' },
      { ...base, nodes: parseUiNodes(xml.replaceAll('Morpho VideoStabilizer', 'Unknown App')) },
      { ...base, nodes: parseUiNodes(xml.replaceAll('未经荣耀安全审核', '风险未知')) },
      { ...base, nodes: parseUiNodes(xml.replaceAll('该应用未上架', '来源未知')) },
      { ...base, nodes: parseUiNodes(xml.replaceAll('已了解此应用未经荣耀应用市场检测，可能存在风险。', '风险提示')) },
      { ...base, nodes: parseUiNodes(xml.replace('id/risk_desc_tv_error', 'id/other_risk')) },
      { ...base, nodes: parseUiNodes(xml.replace('id/checkbox', 'id/other_checkbox')) },
      { ...base, nodes: parseUiNodes(xml.replace('android:id/button1', 'android:id/other_button')) },
      { ...base, nodes: parseUiNodes(xml.replace('android:id/button2', 'android:id/other_button')) },
    ]

    for (const [index, context] of guardedContexts.entries()) {
      expect(
        matchDialogBlock(['honor-magic-os-unreviewed-app-block-v1'], context),
        `recommendation-page guard ${index}`,
      ).toBeUndefined()
    }
  })

  it('matches the Honor X50 safe-mode one-time install link with a bounded relative tap', () => {
    const match = matchDialogAction(['honor-safe-mode-install-sheet-v1'], {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.hihonor.packageinstaller.hncust.safemode.sheet.SafeModeBottomSheetActivity',
      phase: 'install',
      nodes: parseUiNodes(fixture('honor-x50-safe-mode-install-sheet.xml')),
    })

    expect(match?.profileId).toBe('honor-safe-mode-install-sheet-v1')
    expect(match?.action).toBe('allow-one-time-install')
    expect(match?.node.resourceId).not.toMatch(/button_cancel|button_ok/)
    expect(match?.tapTarget).toMatchObject({
      kind: 'bounded-relative-point',
      xRatio: 0.85,
      yRatio: 0.5,
      node: {
        resourceId: 'com.android.packageinstaller:id/risk_desc',
        text: expect.stringContaining('允许本次安装'),
      },
    })
  })

  it('refuses the Honor safe-mode tap when any strict identity or page guard is missing', () => {
    const xml = fixture('honor-x50-safe-mode-install-sheet.xml')
    const base = {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.hihonor.packageinstaller.hncust.safemode.sheet.SafeModeBottomSheetActivity',
      phase: 'install',
      nodes: parseUiNodes(xml),
    }
    const guardedContexts = [
      { ...base, manufacturer: 'Xiaomi' },
      { ...base, packageName: 'com.example.unreviewed' },
      { ...base, focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity' },
      { ...base, nodes: parseUiNodes(xml.replaceAll('安全模式提醒您', '风险提醒')) },
      { ...base, nodes: parseUiNodes(xml.replace('允许本次安装', '查看详情')) },
      { ...base, nodes: parseUiNodes(xml.replaceAll('安全模式提醒您', '风险提醒')) },
      { ...base, nodes: parseUiNodes(xml.replaceAll('未经荣耀安全审核', '风险未知')) },
      { ...base, nodes: parseUiNodes(xml.replaceAll('该应用未上架', '来源未知')) },
      { ...base, nodes: parseUiNodes(xml.replace('id/risk_desc', 'id/other_desc')) },
      { ...base, nodes: parseUiNodes(xml.replace('id/button_cancel', 'id/other_cancel')) },
      { ...base, nodes: parseUiNodes(xml.replace('id/button_ok', 'id/other_ok')) },
    ]

    for (const context of guardedContexts) {
      expect(matchDialogAction(['honor-safe-mode-install-sheet-v1'], context)).toBeUndefined()
    }
  })

  it('does not use coordinator identity evidence outside an active install', () => {
    const match = matchDialogAction(['honor-package-installer-v1'], {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      phase: 'post-launch',
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
      phase: 'runtime-permission',
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
      phase: 'install',
      nodes: parseUiNodes(fixture('unrelated-dialog.xml')),
    })
    expect(match).toBeUndefined()
  })
  it('handles the real Honor X50 recommendation risk page without selecting any recommendation install button', () => {
    const xml = fixture('honor-x50-package-installer-recommendations-risk.xml')
    const base = {
      manufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'install',
    }

    const unchecked = matchDialogAction([
      'honor-package-installer-v1',
      'honor-x50-magic-os-unreviewed-app-install-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], { ...base, nodes: parseUiNodes(xml) })
    expect(unchecked?.profileId).toBe('honor-x50-magic-os-unreviewed-app-install-v1')
    expect(unchecked?.action).toBe('confirm-checkbox')
    expect(unchecked?.node.resourceId).toBe('com.android.packageinstaller:id/checkbox')
    expect(unchecked?.node.resourceId).not.toBe('com.android.packageinstaller:id/btn_download')
    expect(unchecked?.node.resourceId).not.toBe('com.android.packageinstaller:id/btn_offical_install')

    const checkedXml = xml.replace(
      'resource-id="com.android.packageinstaller:id/checkbox" class="android.widget.CheckBox"',
      'resource-id="com.android.packageinstaller:id/checkbox" class="android.widget.CheckBox"',
    ).replace(
      'resource-id="com.android.packageinstaller:id/checkbox" class="android.widget.CheckBox" package="com.android.packageinstaller" content-desc="" checkable="true" checked="false"',
      'resource-id="com.android.packageinstaller:id/checkbox" class="android.widget.CheckBox" package="com.android.packageinstaller" content-desc="" checkable="true" checked="true"',
    )
    const checked = matchDialogAction([
      'honor-package-installer-v1',
      'honor-x50-magic-os-unreviewed-app-install-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], { ...base, nodes: parseUiNodes(checkedXml) })
    expect(checked?.profileId).toBe('honor-x50-magic-os-unreviewed-app-install-v1')
    expect(checked?.action).toBe('continue-install')
    expect(checked?.node.resourceId).toBe('android:id/button1')
    expect(checked?.node.text).toBe('继续安装')
    expect(checked?.node.resourceId).not.toBe('com.android.packageinstaller:id/btn_download')
    expect(checked?.node.resourceId).not.toBe('com.android.packageinstaller:id/btn_offical_install')
  })

  it('classifies the real Honor X50 MagicOS 9 risk page as a manual block without a tap target', () => {
    const context = {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'install',
      nodes: parseUiNodes(fixture('honor-x50-magic-os-9-package-installer.xml')),
    }

    expect(matchDialogAction([
      'honor-package-installer-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], context)).toBeUndefined()
    expect(matchDialogBlock(['honor-magic-os-unreviewed-app-block-v1'], context)).toEqual({
      profileId: 'honor-magic-os-unreviewed-app-block-v1',
      reason: 'honor-install-authorization-required',
      summary: expect.stringContaining('需要人工确认安装授权'),
    })
  })

  it('keeps known block classification across phases without enabling install actions', () => {
    const context = {
      manufacturer: 'HONOR',
      deviceModel: 'ALI-AN00',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'post-launch' as const,
      nodes: parseUiNodes(fixture(
        'honor-x50-magic-os-9-package-installer-recommendations-install.xml',
      )),
    }

    const decision = evaluateDialogProfiles([
      'honor-x50-magic-os-unreviewed-app-install-v1',
      'honor-magic-os-unreviewed-app-block-v1',
    ], context)

    expect(decision).toMatchObject({
      kind: 'block',
      block: {
        profileId: 'honor-magic-os-unreviewed-app-block-v1',
        reason: 'honor-install-authorization-required',
      },
    })
    expect(matchDialogAction([
      'honor-x50-magic-os-unreviewed-app-install-v1',
    ], context)).toBeUndefined()
  })

  it('does not classify the Honor X50 block unless every strict identity guard is present', () => {
    const xml = fixture('honor-x50-magic-os-9-package-installer.xml')
    const base = {
      manufacturer: 'HONOR',
      packageName: 'com.morphoinc.videopostprocessor',
      applicationLabel: 'Morpho VideoStabilizer',
      focusedWindowPackage: 'com.android.packageinstaller',
      focusedWindowComponent: 'com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity',
      phase: 'install',
      nodes: parseUiNodes(xml),
    }
    const guardedContexts = [
      { ...base, manufacturer: 'Xiaomi' },
      { ...base, packageName: 'com.example.unreviewed' },
      { ...base, focusedWindowPackage: 'com.android.permissioncontroller' },
      { ...base, focusedWindowComponent: 'com.android.packageinstaller/.OtherActivity' },
      { ...base, nodes: parseUiNodes(xml.replaceAll('安全模式提醒您', '风险提醒')) },
      { ...base, nodes: parseUiNodes(xml.replaceAll('未经荣耀安全审核', '风险未知')) },
      { ...base, nodes: parseUiNodes(xml.replaceAll('该应用未上架', '来源未知')) },
      { ...base, nodes: parseUiNodes(xml.replaceAll('ICP 核准信息', '备案信息')) },
      { ...base, nodes: parseUiNodes(xml.replace('android:id/button1', 'android:id/other_button')) },
      { ...base, nodes: parseUiNodes(xml.replace('android:id/button2', 'android:id/other_button')) },
      { ...base, nodes: parseUiNodes(xml.replace('id/btn_offical_install', 'id/other_install')) },
    ]

    for (const [index, context] of guardedContexts.entries()) {
      expect(
        matchDialogBlock(['honor-magic-os-unreviewed-app-block-v1'], context),
        `guarded context ${index}`,
      ).toBeUndefined()
    }
  })

})
