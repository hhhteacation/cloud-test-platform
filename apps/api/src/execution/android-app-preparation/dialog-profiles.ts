import type { UiNode } from './ui-xml.js'
import { nodeSearchText } from './ui-xml.js'

export type DialogBusinessPhase = 'install' | 'runtime-permission' | 'post-launch'

export type DialogActionKind =
  | 'confirm-checkbox'
  | 'continue-install'
  | 'acknowledge-install-notice'
  | 'allow-one-time-install'
  | 'allow-permission'
  | 'dismiss-compatibility-warning'

export type DialogTapTarget =
  | { kind: 'node-center'; node: UiNode }
  | {
      kind: 'bounded-relative-point'
      node: UiNode
      xRatio: number
      yRatio: number
    }

export interface DialogActionMatch {
  profileId: string
  action: DialogActionKind
  node: UiNode
  tapTarget: DialogTapTarget
}

export type DialogBlockReason =
  | 'honor-install-authorization-required'
  | 'vivo-super-guard-authorization-required'

export interface DialogBlockMatch {
  profileId: string
  reason: DialogBlockReason
  summary: string
}

export interface DialogMatchContext {
  manufacturer: string
  deviceModel?: string
  packageName: string
  applicationLabel: string
  focusedWindowPackage?: string
  focusedWindowComponent?: string
  nodes: UiNode[]
  phase: DialogBusinessPhase
}

interface DialogProfileDefinition {
  id: string
  manufacturers?: RegExp
  deviceModels?: RegExp
  packageNames?: string[]
  allowedWindowPackages: string[]
  allowedWindowComponents?: RegExp[]
  featurePatterns: RegExp[]
  requiredFeaturePatterns?: RegExp[]
  requiredResourceIds?: string[]
  targets: DialogTargetDefinition[]
  action: Exclude<DialogActionKind, 'confirm-checkbox'>
  allowedPhases: readonly DialogBusinessPhase[]
  allowInstallContextIdentity?: boolean
  allowUncheckedConfirmation?: boolean
  uncheckedConfirmation?: {
    resourceIds: string[]
    requiredFeaturePatterns?: RegExp[]
    requireEnabled?: boolean
  }
  forbiddenResourceIds?: string[]
  excludedScopes?: DialogProfileScope[]
  supersedesBlockProfileIds?: string[]
}

type DialogProfileScope = 'honor-x50-morpho-install'

interface DialogBlockEvidenceVariant {
  requiredFeaturePatterns: RegExp[]
  requiredResourceIds: string[]
}

interface DialogBlockProfileDefinition {
  id: string
  reason: DialogBlockReason
  summary: string
  manufacturers: RegExp
  packageNames: string[]
  allowedWindowPackages: string[]
  allowedWindowComponents: RegExp[]
  evidenceVariants: DialogBlockEvidenceVariant[]
  requireVisibleApplicationIdentity?: boolean
}

interface DialogTargetDefinition {
  textPatterns: RegExp[]
  resourceIds?: string[]
  requiredFeaturePatterns?: RegExp[]
  requiredCheckedResourceIds?: string[]
  requireEnabled?: boolean
  tap?: {
    kind: 'bounded-relative-point'
    xRatio: number
    yRatio: number
  }
}

const VIVO_PROFILE: DialogProfileDefinition = {
  id: 'vivo-package-installer-v1',
  allowedPhases: ['install'],
  manufacturers: /vivo|bbk/i,
  allowedWindowPackages: [
    'com.android.packageinstaller',
    'com.google.android.packageinstaller',
    'com.vivo.packageinstaller',
    'com.bbk.packageinstaller',
    'com.vivo.permissionmanager',
  ],
  featurePatterns: [
    /安全守护提示您/i,
    /外部来源应用/i,
    /非\s*vivo\s*官方应用商店/i,
    /开启/i,
  ],
  targets: [{ textPatterns: [/^继续$/, /^继续安装$/, /^安装$/, /^开启$/] }],
  action: 'continue-install',
}

const HONOR_PROFILE: DialogProfileDefinition = {
  id: 'honor-package-installer-v1',
  allowedPhases: ['install'],
  manufacturers: /honor|huawei|荣耀|华为/i,
  allowedWindowPackages: [
    'com.android.packageinstaller',
    'com.google.android.packageinstaller',
    'com.android.permissioncontroller',
    'com.huawei.systemmanager',
    'com.hihonor.systemmanager',
    'com.huawei.appmarket',
  ],
  featurePatterns: [
    /来历不明的应用/i,
    /可能会损害/i,
    /安装该应用/i,
    /数据丢失/i,
    /未经安全检测/i,
    /可能存在风险|存在风险/i,
    /安全模式/i,
  ],
  targets: [
    {
      textPatterns: [/^继续$/, /^继续安装$/, /^仍要安装$/],
      resourceIds: [
        'com.hihonor.systemmanager:id/continue_button',
        'android:id/button1',
      ],
    },
  ],
  action: 'continue-install',
  allowInstallContextIdentity: true,
  uncheckedConfirmation: {
    resourceIds: [
      'com.hihonor.systemmanager:id/confirm',
      'com.android.packageinstaller:id/checkbox',
    ],
    requiredFeaturePatterns: [
      /我已了解风险|已了解此应用未经安全检测|已了解此应用未经荣耀应用市场检测/i,
    ],
  },
  // A recommendation card can expose a second clickable “安装” button. If
  // it is present, the generic Honor profile must not handle the page even
  // when a future risk-page variant is not yet represented by a block profile.
  forbiddenResourceIds: ['com.android.packageinstaller:id/btn_download'],
  excludedScopes: ['honor-x50-morpho-install'],
}

/**
 * First PackageInstallerActivity page observed on Honor X50 before the
 * MagicOS recommendation/risk page. It is scoped to Morpho on ALI-AN00 and
 * only acknowledges the exact Android button1/“继续” node.
 */
const HONOR_X50_UNKNOWN_SOURCE_WARNING_PROFILE: DialogProfileDefinition = {
  id: 'honor-x50-unknown-source-warning-v1',
  allowedPhases: ['install'],
  manufacturers: /honor|荣耀/i,
  deviceModels: /^ALI-AN00$/i,
  packageNames: ['com.morphoinc.videopostprocessor'],
  allowedWindowPackages: ['com.android.packageinstaller'],
  allowedWindowComponents: [
    /^com\.android\.packageinstaller\/com\.android\.packageinstaller\.PackageInstallerActivity$/,
  ],
  featurePatterns: [
    /来历不明的应用/i,
    /可能会损害您的手机和个人数据/i,
    /安装该应用即表示/i,
    /数据丢失/i,
  ],
  requiredFeaturePatterns: [
    /来历不明的应用/i,
    /可能会损害您的手机和个人数据/i,
    /安装该应用即表示/i,
    /数据丢失/i,
  ],
  requiredResourceIds: ['android:id/message', 'android:id/button1', 'android:id/button2'],
  targets: [{
    textPatterns: [/^继续$/],
    resourceIds: ['android:id/button1'],
    requireEnabled: true,
  }],
  action: 'continue-install',
  allowInstallContextIdentity: true,
}

/**
 * Second PackageInstallerActivity page observed on Honor X50. “知道了” is
 * only an acknowledgement of the ICP notice; it is not a recommendation
 * download or an install-authorisation target.
 */
const HONOR_X50_ICP_NOTICE_PROFILE: DialogProfileDefinition = {
  id: 'honor-x50-icp-notice-v1',
  allowedPhases: ['install'],
  manufacturers: /honor|荣耀/i,
  deviceModels: /^ALI-AN00$/i,
  packageNames: ['com.morphoinc.videopostprocessor'],
  allowedWindowPackages: ['com.android.packageinstaller'],
  allowedWindowComponents: [
    /^com\.android\.packageinstaller\/com\.android\.packageinstaller\.PackageInstallerActivity$/,
  ],
  featurePatterns: [
    /未查询到此应用的\s*ICP\s*核准信息/i,
    /此应用可能为境外应用、单机应用或未履行\s*ICP\s*核准手续/i,
    /如果您是该应用的开发者/i,
  ],
  requiredFeaturePatterns: [
    /未查询到此应用的\s*ICP\s*核准信息/i,
    /此应用可能为境外应用、单机应用或未履行\s*ICP\s*核准手续/i,
    /如果您是该应用的开发者/i,
  ],
  requiredResourceIds: [
    'android:id/alertTitle',
    'com.android.packageinstaller:id/tv_des1',
    'com.android.packageinstaller:id/tv_des2',
    'android:id/button1',
    'android:id/button3',
  ],
  targets: [{
    textPatterns: [/^知道了$/],
    resourceIds: ['android:id/button1'],
    requireEnabled: true,
  }],
  action: 'acknowledge-install-notice',
  allowInstallContextIdentity: true,
}

/**
 * MagicOS safe-mode sheet observed on Honor X50 while installing Morpho.
 *
 * The one-time authorization is an Android ClickableSpan inside a non-clickable
 * TextView, so this profile is intentionally narrower than the normal Honor
 * installer profile: exact protocol package, activity, resource IDs and risk
 * copy are all required before a bounded relative tap is permitted.
 */
const HONOR_SAFE_MODE_INSTALL_SHEET_PROFILE: DialogProfileDefinition = {
  id: 'honor-safe-mode-install-sheet-v1',
  allowedPhases: ['install'],
  manufacturers: /honor|荣耀/i,
  packageNames: ['com.morphoinc.videopostprocessor'],
  allowedWindowPackages: ['com.android.packageinstaller'],
  allowedWindowComponents: [
    /^com\.android\.packageinstaller\/com\.hihonor\.packageinstaller\.hncust\.safemode\.sheet\.SafeModeBottomSheetActivity$/,
  ],
  featurePatterns: [
    /安全模式提醒您/i,
    /允许本次安装/i,
    /未经荣耀安全审核/i,
    /该应用未上架/i,
  ],
  requiredFeaturePatterns: [
    /安全模式提醒您/i,
    /允许本次安装/i,
    /未经荣耀安全审核/i,
    /该应用未上架/i,
    /com\.android\.packageinstaller:id\/risk_desc/i,
    /com\.android\.packageinstaller:id\/button_cancel/i,
    /com\.android\.packageinstaller:id\/button_ok/i,
  ],
  targets: [{
    textPatterns: [/允许本次安装/i],
    resourceIds: ['com.android.packageinstaller:id/risk_desc'],
    tap: {
      kind: 'bounded-relative-point',
      xRatio: 0.85,
      yRatio: 0.5,
    },
  }],
  action: 'allow-one-time-install',
  allowInstallContextIdentity: true,
  allowUncheckedConfirmation: false,
}

/**
 * MagicOS 9 risk page captured from Honor X50 while installing Morpho.
 *
 * The visible actions on this page are not verified install authorization
 * controls. This profile therefore only classifies the page as a known manual
 * block and can never supply a tap target.
 */
const HONOR_MAGIC_OS_UNREVIEWED_APP_BLOCK_PROFILE: DialogBlockProfileDefinition = {
  id: 'honor-magic-os-unreviewed-app-block-v1',
  reason: 'honor-install-authorization-required',
  summary: '检测到荣耀安全风险安装页面，需要人工确认安装授权；平台未自动点击任何含义不明确的按钮。',
  manufacturers: /honor|荣耀/i,
  packageNames: ['com.morphoinc.videopostprocessor'],
  allowedWindowPackages: ['com.android.packageinstaller'],
  allowedWindowComponents: [
    /^com\.android\.packageinstaller\/com\.android\.packageinstaller\.PackageInstallerActivity$/,
  ],
  requireVisibleApplicationIdentity: true,
  evidenceVariants: [
    {
      requiredFeaturePatterns: [
        /安全模式提醒您/i,
        /未经荣耀安全审核/i,
        /该应用未上架/i,
        /未查询到此应用的\s*ICP\s*核准信息/i,
      ],
      requiredResourceIds: [
        'com.android.packageinstaller:id/btn_offical_install',
        'android:id/button1',
        'android:id/button2',
      ],
    },
    {
      requiredFeaturePatterns: [
        /未经荣耀安全审核/i,
        /该应用未上架/i,
        /已了解此应用未经荣耀应用市场检测，可能存在风险/i,
        /继续安装/i,
      ],
      requiredResourceIds: [
        'com.android.packageinstaller:id/risk_desc_tv_error',
        'com.android.packageinstaller:id/checkbox',
        'android:id/button1',
        'android:id/button2',
      ],
    },
  ],
}

/**
 * Exact two-step MagicOS 9 install confirmation captured on Honor X50.
 *
 * This profile is deliberately model-bound and may only supersede the manual
 * block when it can return one of the two verified targets. Any incomplete or
 * conflicting frame therefore falls back to the block instead of a generic
 * Honor action.
 */
const HONOR_X50_MAGIC_OS_UNREVIEWED_APP_INSTALL_PROFILE: DialogProfileDefinition = {
  id: 'honor-x50-magic-os-unreviewed-app-install-v1',
  allowedPhases: ['install'],
  manufacturers: /honor|荣耀/i,
  deviceModels: /^ALI-AN00$/i,
  packageNames: ['com.morphoinc.videopostprocessor'],
  allowedWindowPackages: ['com.android.packageinstaller'],
  allowedWindowComponents: [
    /^com\.android\.packageinstaller\/com\.android\.packageinstaller\.PackageInstallerActivity$/,
  ],
  featurePatterns: [
    /未经荣耀安全审核/i,
    /该应用未上架/i,
    /已了解此应用未经荣耀应用市场检测，可能存在风险/i,
    /继续安装/i,
  ],
  requiredFeaturePatterns: [
    /未经荣耀安全审核/i,
    /该应用未上架/i,
    /已了解此应用未经荣耀应用市场检测，可能存在风险/i,
    /继续安装/i,
  ],
  requiredResourceIds: [
    'com.android.packageinstaller:id/risk_desc_tv_error',
    'com.android.packageinstaller:id/checkbox',
    'android:id/button1',
    'android:id/button2',
  ],
  uncheckedConfirmation: {
    resourceIds: ['com.android.packageinstaller:id/checkbox'],
    requiredFeaturePatterns: [
      /已了解此应用未经荣耀应用市场检测，可能存在风险/i,
    ],
    requireEnabled: true,
  },
  targets: [{
    textPatterns: [/^继续安装$/],
    resourceIds: ['android:id/button1'],
    requiredCheckedResourceIds: ['com.android.packageinstaller:id/checkbox'],
    requireEnabled: true,
  }],
  action: 'continue-install',
  supersedesBlockProfileIds: ['honor-magic-os-unreviewed-app-block-v1'],
}

/**
 * HyperOS ADB install confirmation observed on Xiaomi 15 Pro.
 *
 * The unchecked checkbox on this page means “do not ask again after rejecting”;
 * it is not an install confirmation. This profile therefore disables the generic
 * unchecked-checkbox action and only clicks the exact continue button after the
 * Morpho identity, activity, copy and resource IDs have all been verified.
 */
const XIAOMI_HYPEROS_PACKAGE_INSTALLER_PROFILE: DialogProfileDefinition = {
  id: 'xiaomi-hyperos-package-installer-v1',
  allowedPhases: ['install'],
  manufacturers: /xiaomi|redmi|poco|小米|红米/i,
  packageNames: ['com.morphoinc.videopostprocessor'],
  allowedWindowPackages: ['com.miui.securitycenter'],
  allowedWindowComponents: [
    /^com\.miui\.securitycenter\/com\.miui\.permcenter\.install\.AdbInstallActivity$/,
  ],
  featurePatterns: [
    /USB安装提示/i,
    /正在通过USB安装此应用，是否继续？/i,
    /拒绝后下次安装不再提示/i,
  ],
  requiredFeaturePatterns: [
    /USB安装提示/i,
    /正在通过USB安装此应用，是否继续？/i,
    /拒绝后下次安装不再提示/i,
    /com\.miui\.securitycenter:id\/alertTitle/i,
    /com\.miui\.securitycenter:id\/name/i,
    /com\.miui\.securitycenter:id\/desc/i,
    /com\.miui\.securitycenter:id\/do_not_ask_checkbox/i,
    /android:id\/button2/i,
  ],
  targets: [{
    textPatterns: [/^继续安装$/],
    resourceIds: ['android:id/button2'],
  }],
  action: 'continue-install',
  allowUncheckedConfirmation: false,
}

/**
 * OPPO/OnePlus/realme ColorOS package risk guide.
 *
 * Observed on OPPO PJV110: adb install is paused in the privileged
 * `com.oplus.appdetail` InstallGuideActivity until the user explicitly chooses
 * “继续安装”. Identity, manufacturer, system-window trust and at least two risk
 * features are still required before the controller may click.
 *
 * Two page variants are verified against real captures:
 * - ColorOS 14（PKR110 等）额外渲染 `tv_risk_name`/`tv_risk_desc` 风险明细节点；
 * - ColorOS 15（PJV110，Android 15）移除了这两个节点，改用 `nsv_content`/
 *   `channel_source` 呈现同一段“检测结果：涉及敏感权限”文案。
 * `tv_risk_name`/`tv_risk_desc` 因此不能作为必需节点，其余身份与风险特征约束不变。
 */
const OPLUS_PROFILE: DialogProfileDefinition = {
  id: 'oplus-package-installer-v1',
  allowedPhases: ['install'],
  manufacturers: /oppo|oneplus|realme|oplus|一加|真我/i,
  allowedWindowPackages: [
    'com.oplus.appdetail',
  ],
  allowedWindowComponents: [
    /^com\.oplus\.appdetail\/com\.oplus\.appdetail\.model\.guide\.ui\.InstallGuideActivity$/,
  ],
  requiredResourceIds: [
    'com.oplus.appdetail:id/app_name',
    'com.oplus.appdetail:id/tv_result_title',
    'com.oplus.appdetail:id/tv_result_desc',
    'com.oplus.appdetail:id/btn_left',
  ],
  featurePatterns: [
    /检测结果[:：]?\s*涉及敏感权限/i,
    /请谨慎安装使用/i,
    /可能使用\s*\d+\s*项敏感权限/i,
    /权限授予和隐私管控/i,
    /未查询到此应用的\s*ICP\s*备案信息/i,
  ],
  targets: [{
    textPatterns: [/^继续安装$/],
    resourceIds: ['com.oplus.appdetail:id/btn_left'],
  }],
  action: 'continue-install',
}

/**
 * ColorOS risk-guide variant emitted on newer builds where the legacy
 * `tv_risk_name`/`tv_risk_desc` nodes are omitted.  Keep this as a separate
 * profile so the older page remains fully guarded; the exact activity,
 * application identity, result title/description and continue resource are
 * still required before any tap is allowed.
 */
const OPLUS_INSTALL_RISK_V2_PROFILE: DialogProfileDefinition = {
  id: 'oplus-package-installer-risk-v2',
  allowedPhases: ['install'],
  manufacturers: /oppo|oneplus|realme|oplus|一加|真我/i,
  packageNames: ['com.morphoinc.videopostprocessor'],
  allowedWindowPackages: ['com.oplus.appdetail'],
  allowedWindowComponents: [
    /^com\.oplus\.appdetail\/com\.oplus\.appdetail\.model\.guide\.ui\.InstallGuideActivity$/,
  ],
  requiredResourceIds: [
    'com.oplus.appdetail:id/app_name',
    'com.oplus.appdetail:id/tv_result_title',
    'com.oplus.appdetail:id/tv_result_desc',
    'com.oplus.appdetail:id/btn_left',
  ],
  featurePatterns: [
    /检测结果[:：]?\s*涉及敏感权限/i,
    /可能申请使用了\s*\d+\s*项敏感权限/i,
  ],
  targets: [{
    textPatterns: [/^继续安装$/],
    resourceIds: ['com.oplus.appdetail:id/btn_left'],
  }],
  action: 'continue-install',
}

/**
 * ColorOS installation-success page. The ADB install process can remain
 * blocked until the user dismisses this page even though the APK is already
 * installed. This profile is intentionally narrower than the risk-guide
 * profile and only taps the exact success-page "完成" button.
 */
const OPLUS_INSTALL_FINISH_PROFILE: DialogProfileDefinition = {
  id: 'oplus-package-installer-finish-v1',
  allowedPhases: ['install'],
  manufacturers: /oppo|oneplus|realme|oplus|一加|真我/i,
  allowedWindowPackages: ['com.oplus.appdetail'],
  allowedWindowComponents: [
    /^com\.oplus\.appdetail\/com\.oplus\.appdetail\.model\.finish\.InstallFinishActivity$/,
  ],
  requiredResourceIds: [
    'com.oplus.appdetail:id/process_finish_title',
    'com.oplus.appdetail:id/launch_button',
  ],
  // The matcher requires two independent feature matches.  Use the verified
  // resource IDs here because nodeSearchText appends each node's resource ID,
  // so an anchored text-only pattern would be brittle while a generic label
  // could match an unrelated installer page.
  featurePatterns: [
    /com\.oplus\.appdetail:id\/process_finish_title/,
    /com\.oplus\.appdetail:id\/launch_button/,
  ],
  targets: [{ textPatterns: [/^完成$/], resourceIds: ['com.oplus.appdetail:id/launch_button'] }],
  action: 'continue-install',
}

/**
 * ColorOS storage-compatibility warning shown after Morpho's first launch.
 *
 * This is not a storage permission grant. The profile only dismisses the
 * compatibility notice after verifying the exact privileged controller
 * activity, Morpho identity, warning title/body and android:id/button1.
 */
const OPLUS_STORAGE_COMPATIBILITY_PROFILE: DialogProfileDefinition = {
  id: 'oplus-storage-compatibility-warning-v1',
  allowedPhases: ['post-launch'],
  manufacturers: /oppo|oneplus|realme|oplus|一加|真我/i,
  allowedWindowPackages: ['com.android.permissioncontroller'],
  allowedWindowComponents: [
    /^com\.android\.permissioncontroller\/com\.oplusos\.permissioncontroller\.permission\.ui\.OplusCompatibilityAlertActivity$/,
  ],
  featurePatterns: [
    /^权限异常提示$/im,
    /存储权限未适配当前系统版本/i,
    /可能无法读取或保存文件/i,
  ],
  targets: [{
    textPatterns: [/^确定$/],
    resourceIds: ['android:id/button1'],
    requiredFeaturePatterns: [
      /权限异常提示/i,
      /存储权限未适配当前系统版本/i,
    ],
  }],
  action: 'dismiss-compatibility-warning',
}

const ANDROID_PERMISSION_PROFILE: DialogProfileDefinition = {
  id: 'android-runtime-permission-v1',
  allowedPhases: ['runtime-permission'],
  allowedWindowPackages: [
    'com.android.permissioncontroller',
    'com.google.android.permissioncontroller',
    'com.android.packageinstaller',
  ],
  featurePatterns: [
    /拍摄照片和录制视频/i,
    /拍摄照片或录制视频/i,
    /录制音频/i,
    /相机/i,
    /摄像头/i,
    /麦克风/i,
    /仅使用期间允许/i,
    /仅在使用中允许/i,
    /本次使用允许/i,
    /使用应用时允许/i,
    /使用时允许/i,
  ],
  targets: [
    {
      textPatterns: [
        /^仅使用期间允许$/,
        /^仅在使用中允许$/,
        /^本次使用允许$/,
        /^使用应用时允许$/,
        /^允许$/,
      ],
    },
    {
      textPatterns: [/^确定$/],
      resourceIds: [
        'com.android.permissioncontroller:id/permission_allow_button',
      ],
      requiredFeaturePatterns: [/摄像头/i, /麦克风/i],
    },
  ],
  action: 'allow-permission',
}

/**
 * vivo OriginOS「超级守护」安装拦截页（PackageInterceptActivity）。
 *
 * 2026-09-10 在 V2324A 真机确认：该固件把经典的「复选框 + 继续安装」守护页
 * 换成了纯告知式拦截页——页面上没有任何可点击的授权控件（只有 返回/下载/设置
 * 三个工具栏图标）。授权入口在设备级「超级守护」设置里，且关闭需要交互式身份
 * 验证，平台不能也不应代替用户关闭安全机制。因此该页面按已知人工阻塞处理：
 * 立即以结构化原因失败，而不是耗尽 120 秒弹窗超时。
 */
const VIVO_SUPER_GUARD_BLOCK_PROFILE: DialogBlockProfileDefinition = {
  id: 'vivo-super-guard-install-block-v1',
  reason: 'vivo-super-guard-authorization-required',
  summary:
    'vivo 超级守护已管控本次安装：该固件的守护页没有可自动点击的授权控件。' +
    '请在设备上进入 安装器设置 → 超级守护，人工关闭或完成一次授权后重试任务。',
  manufacturers: /vivo|bbk/i,
  packageNames: ['com.morphoinc.videopostprocessor'],
  allowedWindowPackages: ['com.android.packageinstaller'],
  allowedWindowComponents: [
    /^com\.android\.packageinstaller\/com\.android\.packageinstaller\.PackageInterceptActivity$/,
  ],
  requireVisibleApplicationIdentity: true,
  evidenceVariants: [
    {
      requiredFeaturePatterns: [
        /超级守护提示您/i,
        /未经\s*vivo\s*人工亲测|非\s*vivo\s*官方应用商店/i,
        /您可授权本次安装/i,
      ],
      requiredResourceIds: [
        'com.android.packageinstaller:id/tv_install_guide',
      ],
    },
  ],
}

const DIALOG_BLOCK_PROFILES: readonly DialogBlockProfileDefinition[] = [
  HONOR_MAGIC_OS_UNREVIEWED_APP_BLOCK_PROFILE,
  VIVO_SUPER_GUARD_BLOCK_PROFILE,
]

export const DIALOG_PROFILES: readonly DialogProfileDefinition[] = [
  VIVO_PROFILE,
  HONOR_X50_UNKNOWN_SOURCE_WARNING_PROFILE,
  HONOR_X50_ICP_NOTICE_PROFILE,
  HONOR_X50_MAGIC_OS_UNREVIEWED_APP_INSTALL_PROFILE,
  HONOR_PROFILE,
  HONOR_SAFE_MODE_INSTALL_SHEET_PROFILE,
  XIAOMI_HYPEROS_PACKAGE_INSTALLER_PROFILE,
  OPLUS_PROFILE,
  OPLUS_INSTALL_RISK_V2_PROFILE,
  OPLUS_INSTALL_FINISH_PROFILE,
  OPLUS_STORAGE_COMPATIBILITY_PROFILE,
  ANDROID_PERMISSION_PROFILE,
]

export const KNOWN_DIALOG_WINDOW_PACKAGES = new Set([
  ...DIALOG_PROFILES.flatMap((profile) => profile.allowedWindowPackages),
  ...DIALOG_BLOCK_PROFILES.flatMap((profile) => profile.allowedWindowPackages),
])

function hasApplicationIdentity(
  profile: DialogProfileDefinition,
  context: DialogMatchContext,
) {
  const allText = context.nodes.map(nodeSearchText).join('\n')
  const identityVisibleInUi = allText.includes(context.applicationLabel)
    || allText.includes(context.packageName)
  return identityVisibleInUi || Boolean(profile.allowInstallContextIdentity && context.phase === 'install')
}

function resolveDialogScope(context: DialogMatchContext): DialogProfileScope | undefined {
  if (/honor|荣耀/i.test(context.manufacturer)
    && /^ALI-AN00$/i.test(context.deviceModel ?? '')
    && context.packageName === 'com.morphoinc.videopostprocessor'
    && context.phase === 'install'
    && context.focusedWindowPackage === 'com.android.packageinstaller'
    && context.focusedWindowComponent
    && /^com\.android\.packageinstaller\/com\.android\.packageinstaller\.PackageInstallerActivity$/
      .test(context.focusedWindowComponent)) {
    return 'honor-x50-morpho-install'
  }
  return undefined
}

function profileMatches(profile: DialogProfileDefinition, context: DialogMatchContext) {
  const scope = resolveDialogScope(context)
  if (scope && profile.excludedScopes?.includes(scope)) return false
  if (profile.manufacturers && !profile.manufacturers.test(context.manufacturer)) return false
  if (!profile.allowedPhases.includes(context.phase)) return false
  if (profile.deviceModels
    && (!context.deviceModel || !profile.deviceModels.test(context.deviceModel))) return false
  if (profile.packageNames && !profile.packageNames.includes(context.packageName)) return false
  if (!context.focusedWindowPackage || !profile.allowedWindowPackages.includes(context.focusedWindowPackage)) return false
  const focusedWindowComponent = context.focusedWindowComponent
  if (profile.allowedWindowComponents
    && (!focusedWindowComponent
      || !profile.allowedWindowComponents.some((pattern) => pattern.test(focusedWindowComponent)))) return false
  if (!hasApplicationIdentity(profile, context)) return false

  const focusedWindowNodes = context.nodes.filter(
    (node) => node.packageName === context.focusedWindowPackage,
  )
  const resourceIds = new Set(
    focusedWindowNodes.map((node) => node.resourceId).filter(Boolean),
  )
  if (profile.forbiddenResourceIds?.some((resourceId) => resourceIds.has(resourceId))) {
    return false
  }
  if (profile.requiredResourceIds?.some((resourceId) => !resourceIds.has(resourceId))) {
    return false
  }

  const allText = context.nodes.map(nodeSearchText).join('\n')
  if (profile.requiredFeaturePatterns
    && !profile.requiredFeaturePatterns.every((pattern) => pattern.test(allText))) return false
  const matchedFeatures = profile.featurePatterns.filter((pattern) => pattern.test(allText))
  return matchedFeatures.length >= 2
}

export function matchDialogBlock(
  enabledProfileIds: readonly string[],
  context: DialogMatchContext,
): DialogBlockMatch | undefined {
  const focusedWindowNodes = context.nodes.filter(
    (node) => node.packageName === context.focusedWindowPackage,
  )
  const allText = focusedWindowNodes.map(nodeSearchText).join('\n')
  const resourceIds = new Set(
    focusedWindowNodes.map((node) => node.resourceId).filter(Boolean),
  )

  for (const profile of DIALOG_BLOCK_PROFILES) {
    if (!enabledProfileIds.includes(profile.id)) continue
    if (!profile.manufacturers.test(context.manufacturer)) continue
    if (!profile.packageNames.includes(context.packageName)) continue
    if (!context.focusedWindowPackage
      || !profile.allowedWindowPackages.includes(context.focusedWindowPackage)) continue
    if (!context.focusedWindowComponent
      || !profile.allowedWindowComponents.some(
        (pattern) => pattern.test(context.focusedWindowComponent!),
      )) continue
    if (profile.requireVisibleApplicationIdentity
      && !allText.includes(context.applicationLabel)
      && !allText.includes(context.packageName)) continue
    if (!profile.evidenceVariants.some((variant) =>
      variant.requiredFeaturePatterns.every((pattern) => pattern.test(allText))
      && variant.requiredResourceIds.every((resourceId) => resourceIds.has(resourceId)))) continue

    return {
      profileId: profile.id,
      reason: profile.reason,
      summary: profile.summary,
    }
  }
  return undefined
}

function belongsToFocusedWindow(node: UiNode, focusedWindowPackage: string | undefined) {
  return Boolean(focusedWindowPackage) && node.packageName === focusedWindowPackage
}

function findTarget(
  profile: DialogProfileDefinition,
  nodes: UiNode[],
  focusedWindowPackage: string | undefined,
) {
  const allText = nodes.map(nodeSearchText).join('\n')
  for (const node of nodes) {
    if (!node.bounds || !belongsToFocusedWindow(node, focusedWindowPackage)) continue
    const text = node.text.trim() || node.contentDescription.trim()
    for (const target of profile.targets) {
      if (target.resourceIds && !target.resourceIds.includes(node.resourceId)) continue
      if (target.requiredFeaturePatterns
        && !target.requiredFeaturePatterns.every((pattern) => pattern.test(allText))) continue
      if (target.requiredCheckedResourceIds
        && !target.requiredCheckedResourceIds.every((resourceId) => nodes.some(
          (candidate) => candidate.resourceId === resourceId
            && candidate.checked
            && belongsToFocusedWindow(candidate, focusedWindowPackage),
        ))) continue
      if (target.requireEnabled && !node.enabled) continue
      if (!target.textPatterns.some((pattern) => pattern.test(text))) continue

      if (target.tap) {
        const safelyConstrained = Boolean(
          profile.allowedWindowComponents?.length
          && target.resourceIds?.length
          && target.tap.xRatio > 0
          && target.tap.xRatio < 1
          && target.tap.yRatio > 0
          && target.tap.yRatio < 1,
        )
        if (!safelyConstrained) continue
        return {
          node,
          tapTarget: {
            ...target.tap,
            node,
          } satisfies DialogTapTarget,
        }
      }

      if (node.clickable) {
        return {
          node,
          tapTarget: { kind: 'node-center', node } satisfies DialogTapTarget,
        }
      }
    }
  }
  return undefined
}

function matchDialogActionFromProfiles(
  profiles: readonly DialogProfileDefinition[],
  enabledProfileIds: readonly string[],
  context: DialogMatchContext,
): DialogActionMatch | undefined {
  for (const profile of profiles) {
    if (!enabledProfileIds.includes(profile.id) || !profileMatches(profile, context)) continue

    const uncheckedConfirmation = profile.allowUncheckedConfirmation === false
      ? undefined
      : context.nodes.find(
          (node) => node.checkable
            && !node.checked
            && node.clickable
            && (!profile.uncheckedConfirmation?.requireEnabled || node.enabled)
            && Boolean(node.bounds)
            && belongsToFocusedWindow(node, context.focusedWindowPackage)
            && (!profile.uncheckedConfirmation
              || profile.uncheckedConfirmation.resourceIds.includes(node.resourceId))
            && (!profile.uncheckedConfirmation?.requiredFeaturePatterns
              || profile.uncheckedConfirmation.requiredFeaturePatterns.every((pattern) =>
                pattern.test(context.nodes.map(nodeSearchText).join('\n')))),
        )
    if (uncheckedConfirmation) {
      return {
        profileId: profile.id,
        action: 'confirm-checkbox',
        node: uncheckedConfirmation,
        tapTarget: { kind: 'node-center', node: uncheckedConfirmation },
      }
    }

    const target = findTarget(profile, context.nodes, context.focusedWindowPackage)
    if (target) {
      return {
        profileId: profile.id,
        action: profile.action,
        node: target.node,
        tapTarget: target.tapTarget,
      }
    }
  }
  return undefined
}

export function matchDialogAction(
  enabledProfileIds: readonly string[],
  context: DialogMatchContext,
): DialogActionMatch | undefined {
  return matchDialogActionFromProfiles(DIALOG_PROFILES, enabledProfileIds, context)
}

export type DialogProfileDecision =
  | { kind: 'action'; action: DialogActionMatch }
  | { kind: 'block'; block: DialogBlockMatch }
  | { kind: 'none' }

export function evaluateDialogProfiles(
  enabledProfileIds: readonly string[],
  context: DialogMatchContext,
): DialogProfileDecision {
  const block = matchDialogBlock(enabledProfileIds, context)
  if (block) {
    const overridingProfiles = DIALOG_PROFILES.filter(
      (profile) => profile.supersedesBlockProfileIds?.includes(block.profileId),
    )
    const overridingAction = matchDialogActionFromProfiles(
      overridingProfiles,
      enabledProfileIds,
      context,
    )
    return overridingAction
      ? { kind: 'action', action: overridingAction }
      : { kind: 'block', block }
  }

  const action = matchDialogAction(enabledProfileIds, context)
  return action ? { kind: 'action', action } : { kind: 'none' }
}

export function hasDialogObservationProfileForManufacturer(
  enabledProfileIds: readonly string[],
  manufacturer: string,
  phase: DialogBusinessPhase,
) {
  const hasActionProfile = DIALOG_PROFILES.some((profile) =>
    enabledProfileIds.includes(profile.id)
    && profile.allowedPhases.includes(phase)
    && (!profile.manufacturers || profile.manufacturers.test(manufacturer)))
  if (hasActionProfile) return true

  // Block profiles classify a known unsafe/manual page. Their classification is
  // phase-independent even though every phase coordinator owns a different
  // terminal decision and must never execute an install action outside install.
  return DIALOG_BLOCK_PROFILES.some((profile) =>
    enabledProfileIds.includes(profile.id)
    && profile.manufacturers.test(manufacturer))
}
