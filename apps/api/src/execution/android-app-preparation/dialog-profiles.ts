import type { UiNode } from './ui-xml.js'
import { nodeSearchText } from './ui-xml.js'

export type DialogActionKind =
  | 'confirm-checkbox'
  | 'continue-install'
  | 'allow-permission'
  | 'dismiss-compatibility-warning'

export interface DialogActionMatch {
  profileId: string
  action: DialogActionKind
  node: UiNode
}

export interface DialogMatchContext {
  manufacturer: string
  packageName: string
  applicationLabel: string
  focusedWindowPackage?: string
  focusedWindowComponent?: string
  nodes: UiNode[]
  activeInstall: boolean
}

interface DialogProfileDefinition {
  id: string
  manufacturers?: RegExp
  allowedWindowPackages: string[]
  allowedWindowComponents?: RegExp[]
  featurePatterns: RegExp[]
  targets: DialogTargetDefinition[]
  action: Exclude<DialogActionKind, 'confirm-checkbox'>
  allowActiveInstallIdentity?: boolean
}

interface DialogTargetDefinition {
  textPatterns: RegExp[]
  resourceIds?: string[]
  requiredFeaturePatterns?: RegExp[]
}

const VIVO_PROFILE: DialogProfileDefinition = {
  id: 'vivo-package-installer-v1',
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
  targets: [{ textPatterns: [/^继续$/, /^继续安装$/, /^仍要安装$/, /^安装$/] }],
  action: 'continue-install',
  allowActiveInstallIdentity: true,
}

/**
 * OPPO/OnePlus/realme ColorOS package risk guide.
 *
 * Observed on OPPO PJV110: adb install is paused in the privileged
 * `com.oplus.appdetail` InstallGuideActivity until the user explicitly chooses
 * “继续安装”. Identity, manufacturer, system-window trust and at least two risk
 * features are still required before the controller may click.
 */
const OPLUS_PROFILE: DialogProfileDefinition = {
  id: 'oplus-package-installer-v1',
  manufacturers: /oppo|oneplus|realme|oplus|一加|真我/i,
  allowedWindowPackages: [
    'com.oplus.appdetail',
  ],
  featurePatterns: [
    /检测结果[:：]?\s*涉及敏感权限/i,
    /请谨慎安装使用/i,
    /可能使用\s*\d+\s*项敏感权限/i,
    /权限授予和隐私管控/i,
    /未查询到此应用的\s*ICP\s*备案信息/i,
  ],
  targets: [{ textPatterns: [/^继续安装$/] }],
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
  allowedWindowPackages: [
    'com.android.permissioncontroller',
    'com.google.android.permissioncontroller',
    'com.android.packageinstaller',
  ],
  featurePatterns: [
    /拍摄照片和录制视频/i,
    /录制音频/i,
    /相机/i,
    /摄像头/i,
    /麦克风/i,
    /仅使用期间允许/i,
    /本次使用允许/i,
    /使用应用时允许/i,
    /使用时允许/i,
  ],
  targets: [
    {
      textPatterns: [
        /^仅使用期间允许$/,
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

export const DIALOG_PROFILES: readonly DialogProfileDefinition[] = [
  VIVO_PROFILE,
  HONOR_PROFILE,
  OPLUS_PROFILE,
  OPLUS_STORAGE_COMPATIBILITY_PROFILE,
  ANDROID_PERMISSION_PROFILE,
]

export const KNOWN_DIALOG_WINDOW_PACKAGES = new Set(
  DIALOG_PROFILES.flatMap((profile) => profile.allowedWindowPackages),
)

function hasApplicationIdentity(
  profile: DialogProfileDefinition,
  context: DialogMatchContext,
) {
  const allText = context.nodes.map(nodeSearchText).join('\n')
  const identityVisibleInUi = allText.includes(context.applicationLabel)
    || allText.includes(context.packageName)
  return identityVisibleInUi || Boolean(profile.allowActiveInstallIdentity && context.activeInstall)
}

function profileMatches(profile: DialogProfileDefinition, context: DialogMatchContext) {
  if (profile.manufacturers && !profile.manufacturers.test(context.manufacturer)) return false
  if (!context.focusedWindowPackage || !profile.allowedWindowPackages.includes(context.focusedWindowPackage)) return false
  const focusedWindowComponent = context.focusedWindowComponent
  if (profile.allowedWindowComponents
    && (!focusedWindowComponent
      || !profile.allowedWindowComponents.some((pattern) => pattern.test(focusedWindowComponent)))) return false
  if (!hasApplicationIdentity(profile, context)) return false

  const allText = context.nodes.map(nodeSearchText).join('\n')
  const matchedFeatures = profile.featurePatterns.filter((pattern) => pattern.test(allText))
  return matchedFeatures.length >= 2
}

function belongsToFocusedWindow(node: UiNode, focusedWindowPackage: string | undefined) {
  return Boolean(focusedWindowPackage) && node.packageName === focusedWindowPackage
}

function findTargetNode(
  profile: DialogProfileDefinition,
  nodes: UiNode[],
  focusedWindowPackage: string | undefined,
) {
  return nodes.find((node) => {
    if (!node.clickable || !node.bounds || !belongsToFocusedWindow(node, focusedWindowPackage)) return false
    const text = node.text.trim() || node.contentDescription.trim()
    const allText = nodes.map(nodeSearchText).join('\n')
    return profile.targets.some((target) => {
      if (target.resourceIds && !target.resourceIds.includes(node.resourceId)) return false
      if (target.requiredFeaturePatterns
        && !target.requiredFeaturePatterns.every((pattern) => pattern.test(allText))) return false
      return target.textPatterns.some((pattern) => pattern.test(text))
    })
  })
}

export function matchDialogAction(
  enabledProfileIds: readonly string[],
  context: DialogMatchContext,
): DialogActionMatch | undefined {
  for (const profile of DIALOG_PROFILES) {
    if (!enabledProfileIds.includes(profile.id) || !profileMatches(profile, context)) continue

    const uncheckedConfirmation = context.nodes.find(
      (node) => node.checkable
        && !node.checked
        && Boolean(node.bounds)
        && belongsToFocusedWindow(node, context.focusedWindowPackage),
    )
    if (uncheckedConfirmation) {
      return { profileId: profile.id, action: 'confirm-checkbox', node: uncheckedConfirmation }
    }

    const target = findTargetNode(profile, context.nodes, context.focusedWindowPackage)
    if (target) return { profileId: profile.id, action: profile.action, node: target }
  }
  return undefined
}


export function hasDialogProfileForManufacturer(
  enabledProfileIds: readonly string[],
  manufacturer: string,
) {
  return DIALOG_PROFILES.some((profile) => enabledProfileIds.includes(profile.id)
    && (!profile.manufacturers || profile.manufacturers.test(manufacturer)))
}
