import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { TaskExecutionError } from '../execution-errors.js'
import type {
  AndroidPreparationDevice,
  DiagnosticScreenshotCapture,
  DialogInteractionState,
} from './contracts.js'
import {
  evaluateDialogProfiles,
  KNOWN_DIALOG_WINDOW_PACKAGES,
  type DialogBusinessPhase,
  type DialogTapTarget,
} from './dialog-profiles.js'
import type { DialogInspectionResult, InstallProgressSignature } from './dialog-state.js'

export type { DialogInspectionResult } from './dialog-state.js'
import {
  createInputAutomationDeniedError,
  isInputInjectionDenied,
} from './input-automation-compatibility.js'
import {
  boundsCenter,
  extractFocusedWindowComponent,
  extractFocusedWindowPackage,
  extractUiXml,
  parseUiNodes,
  type UiNode,
} from './ui-xml.js'

export interface DialogInspectionOptions {
  manufacturer: string
  deviceModel?: string
  packageName: string
  applicationLabel: string
  profileIds: readonly string[]
  diagnosticsDirectory: string
  maxActions: number
  signal: AbortSignal
  phase: DialogBusinessPhase
}

interface WindowSnapshot {
  focusedWindowPackage?: string
  focusedWindowComponent?: string
  diagnosticsText: string
}

const TRUSTED_SYSTEM_PREFIXES = [
  '/system/',
  '/product/',
  '/system_ext/',
  '/vendor/',
  '/apex/',
  '/odm/',
]

const UI_DUMP_REMOTE_PATH = '/data/local/tmp/sdk-compat-window.xml'

function resolveTapPoint(target: DialogTapTarget) {
  const bounds = target.node.bounds!
  if (target.kind === 'node-center') return boundsCenter(bounds)

  return {
    x: Math.round(bounds.left + (bounds.right - bounds.left) * target.xRatio),
    y: Math.round(bounds.top + (bounds.bottom - bounds.top) * target.yRatio),
  }
}

function buildDialogObservationFingerprint(
  focusedWindowPackage: string,
  focusedWindowComponent: string | undefined,
  nodes: readonly UiNode[],
) {
  const nodeSignature = nodes.map((node) => [
    node.index,
    node.packageName,
    node.resourceId,
    node.className,
    node.text,
    node.contentDescription,
    node.clickable,
    node.enabled,
    node.checkable,
    node.checked,
    node.bounds ? `${node.bounds.left},${node.bounds.top},${node.bounds.right},${node.bounds.bottom}` : '',
  ].join('=')).join('|')
  return [focusedWindowPackage, focusedWindowComponent ?? '', nodeSignature || 'no-nodes'].join(':')
}

function buildPageSignature(
  pageKind: InstallProgressSignature['pageKind'],
  focusedWindowPackage: string,
  focusedWindowComponent: string | undefined,
  pageFingerprint: string,
): InstallProgressSignature {
  return {
    pageKind,
    windowPackage: focusedWindowPackage,
    windowComponent: focusedWindowComponent,
    pageFingerprint,
  }
}

function buildUnrecognizedSignature(
  focusedWindowPackage: string,
  focusedWindowComponent: string | undefined,
  pageFingerprint: string,
): InstallProgressSignature {
  return buildPageSignature(
    'unrecognized-page',
    focusedWindowPackage,
    focusedWindowComponent,
    pageFingerprint,
  )
}

function buildManualActionSignature(
  focusedWindowPackage: string,
  focusedWindowComponent: string | undefined,
  pageFingerprint: string,
): InstallProgressSignature {
  return buildPageSignature(
    'manual-action-required',
    focusedWindowPackage,
    focusedWindowComponent,
    pageFingerprint,
  )
}

/**
 * Strict UI Automator controller. It only clicks a node selected by a registered
 * profile and derives coordinates from that node's XML bounds.
 *
 * OEM note: some Android builds omit mCurrentFocus from `dumpsys window windows`.
 * Window discovery and UI hierarchy collection therefore use conservative
 * fallbacks, while profile matching remains the only path that can click.
 */
export class SystemDialogController {
  private readonly trustedPackageCache = new Map<string, boolean>()

  constructor(
    private readonly device: AndroidPreparationDevice,
    private readonly captureScreenshot: DiagnosticScreenshotCapture,
  ) {}

  async inspectAndHandle(
    options: DialogInspectionOptions,
    interactionState: DialogInteractionState,
  ): Promise<DialogInspectionResult> {
    const window = await this.readWindowSnapshot(options.signal, 'INSTALL_DIALOG_UNRECOGNIZED')
    const focusedWindowPackage = window.focusedWindowPackage
    if (!focusedWindowPackage || !KNOWN_DIALOG_WINDOW_PACKAGES.has(focusedWindowPackage)) {
      return { kind: 'none' }
    }

    const xml = await this.readUiXml(options.signal, 'INSTALL_DIALOG_UNRECOGNIZED')
    const nodes = parseUiNodes(xml)
    if (!xml || !nodes.length) {
      return {
        kind: 'unrecognized',
        signature: buildUnrecognizedSignature(
          focusedWindowPackage,
          window.focusedWindowComponent,
          `${focusedWindowPackage}:ui-hierarchy-unavailable`,
        ),
      }
    }

    const trustedSystemPackage = await this.isTrustedSystemPackage(focusedWindowPackage, options.signal)
    if (!trustedSystemPackage) {
      await this.saveDiagnostics(options.diagnosticsDirectory, window.diagnosticsText, xml, options.signal)
      throw new TaskExecutionError(
        `当前窗口 ${focusedWindowPackage} 不是可信系统安装器或权限控制器，平台拒绝自动点击`,
        'INSTALL_DIALOG_UNRECOGNIZED',
      )
    }

    const matchContext = {
      manufacturer: options.manufacturer,
      deviceModel: options.deviceModel,
      packageName: options.packageName,
      applicationLabel: options.applicationLabel,
      focusedWindowPackage,
      focusedWindowComponent: window.focusedWindowComponent,
      phase: options.phase,
      nodes,
    }

    const pageFingerprint = buildDialogObservationFingerprint(
      focusedWindowPackage,
      window.focusedWindowComponent,
      nodes,
    )
    const decision = evaluateDialogProfiles(options.profileIds, matchContext)
    if (decision.kind === 'block') {
      await this.saveDiagnostics(options.diagnosticsDirectory, window.diagnosticsText, xml, options.signal)
      return {
        kind: 'manual-action-required',
        block: decision.block,
        signature: buildManualActionSignature(
          focusedWindowPackage,
          window.focusedWindowComponent,
          pageFingerprint,
        ),
      }
    }

    if (decision.kind === 'none') {
      return {
        kind: 'unrecognized',
        signature: buildUnrecognizedSignature(
          focusedWindowPackage,
          window.focusedWindowComponent,
          pageFingerprint,
        ),
      }
    }

    const match = decision.action

    const tapPoint = resolveTapPoint(match.tapTarget)
    const fingerprint = [
      focusedWindowPackage,
      match.profileId,
      match.action,
      match.node.resourceId,
      match.node.text,
      match.node.contentDescription,
      `enabled=${match.node.enabled}`,
      `checkable=${match.node.checkable}`,
      `checked=${match.node.checked}`,
      JSON.stringify(match.node.bounds),
      match.tapTarget.kind,
      tapPoint.x,
      tapPoint.y,
    ].join(':')
    const progressSignature: InstallProgressSignature = {
      pageKind: 'recognized-action',
      windowPackage: focusedWindowPackage,
      windowComponent: window.focusedWindowComponent,
      profileId: match.profileId,
      action: match.action,
      pageFingerprint,
      target: {
        resourceId: match.node.resourceId,
        text: match.node.text,
        contentDescription: match.node.contentDescription,
        enabled: match.node.enabled,
        checkable: match.node.checkable,
        checked: match.node.checked,
        bounds: match.node.bounds
          ? `${match.node.bounds.left},${match.node.bounds.top},${match.node.bounds.right},${match.node.bounds.bottom}`
          : undefined,
        tapX: tapPoint.x,
        tapY: tapPoint.y,
      },
    }
    if (interactionState.hasSeenAction(fingerprint)) {
      // A repeated action target means that the previous tap has not yet been
      // verified as a state transition. It is not, by itself, an unknown
      // page or a terminal installation failure. The coordinator owns the
      // grace/timeout decision; this module must not preempt it.
      return {
        kind: 'waiting',
        signature: progressSignature,
        reason: 'action-awaiting-transition',
      }
    }

    if (!interactionState.canPerformAction(options.maxActions)) {
      await this.saveDiagnostics(options.diagnosticsDirectory, window.diagnosticsText, xml, options.signal)
      throw new TaskExecutionError(
        `安装弹窗自动操作已达到上限 ${options.maxActions} 次`,
        'INSTALL_DIALOG_UNRECOGNIZED',
      )
    }

    try {
      await this.device.run(
        ['shell', 'input', 'tap', String(tapPoint.x), String(tapPoint.y)],
        options.signal,
        10_000,
        'INSTALL_DIALOG_UNRECOGNIZED',
      )
    } catch (error) {
      if (!isInputInjectionDenied(error)) throw error

      await this.saveDiagnostics(
        options.diagnosticsDirectory,
        window.diagnosticsText,
        xml,
        options.signal,
      )
      throw createInputAutomationDeniedError(options.manufacturer)
    }
    interactionState.recordAction(fingerprint)

    return {
      kind: 'handled',
      signature: progressSignature,
      dialog: {
        profileId: match.profileId,
        action: match.action,
        timestamp: new Date().toISOString(),
      },
    }
  }

  async saveTimeoutDiagnostics(options: DialogInspectionOptions) {
    const window = await this.readWindowSnapshot(options.signal, 'INSTALL_DIALOG_TIMEOUT')
      .catch((): WindowSnapshot => ({ diagnosticsText: '' }))
    const xml = await this.readUiXml(options.signal, 'INSTALL_DIALOG_TIMEOUT').catch(() => '')
    await this.saveDiagnostics(
      options.diagnosticsDirectory,
      window.diagnosticsText,
      xml,
      options.signal,
    )
  }

  private async readWindowSnapshot(
    signal: AbortSignal,
    code: 'INSTALL_DIALOG_UNRECOGNIZED' | 'INSTALL_DIALOG_TIMEOUT',
  ): Promise<WindowSnapshot> {
    const windowsResult = await this.device.run(
      ['shell', 'dumpsys', 'window', 'windows'],
      signal,
      10_000,
      code,
    )
    const windowsFocus = extractFocusedWindowPackage(windowsResult.stdout)
    if (windowsFocus) {
      return {
        focusedWindowPackage: windowsFocus,
        focusedWindowComponent: extractFocusedWindowComponent(windowsResult.stdout),
        diagnosticsText: windowsResult.stdout,
      }
    }

    const fullResult = await this.device.run(
      ['shell', 'dumpsys', 'window'],
      signal,
      10_000,
      code,
    ).catch(() => undefined)

    return {
      focusedWindowPackage: extractFocusedWindowPackage(fullResult?.stdout ?? ''),
      focusedWindowComponent: extractFocusedWindowComponent(fullResult?.stdout ?? ''),
      diagnosticsText: [
        '===== dumpsys window windows =====',
        windowsResult.stdout,
        '===== dumpsys window =====',
        fullResult?.stdout ?? '',
      ].join('\n'),
    }
  }

  private async readUiXml(
    signal: AbortSignal,
    code: 'INSTALL_DIALOG_UNRECOGNIZED' | 'INSTALL_DIALOG_TIMEOUT',
  ) {
    const directResult = await this.device.run(
      ['exec-out', 'uiautomator', 'dump', '/dev/tty'],
      signal,
      15_000,
      code,
    ).catch(() => undefined)
    const directXml = extractUiXml(directResult?.stdout ?? '')
    if (directXml) return directXml

    await this.device.run(
      ['shell', 'uiautomator', 'dump', '--compressed', UI_DUMP_REMOTE_PATH],
      signal,
      15_000,
      code,
    ).catch(() => undefined)
    const fileResult = await this.device.run(
      ['exec-out', 'cat', UI_DUMP_REMOTE_PATH],
      signal,
      10_000,
      code,
    ).catch(() => undefined)
    await this.device.run(
      ['shell', 'rm', '-f', UI_DUMP_REMOTE_PATH],
      signal,
      10_000,
      code,
    ).catch(() => undefined)
    return extractUiXml(fileResult?.stdout ?? '')
  }

  private async isTrustedSystemPackage(packageName: string, signal: AbortSignal) {
    const cached = this.trustedPackageCache.get(packageName)
    if (cached != null) return cached

    const result = await this.device.run(
      ['shell', 'pm', 'path', packageName],
      signal,
      10_000,
      'INSTALL_DIALOG_UNRECOGNIZED',
    ).catch(() => undefined)
    const trustedPath = Boolean(result?.stdout.split(/\r?\n/).some((line) => {
      const packagePath = line.replace(/^package:/, '').trim()
      return TRUSTED_SYSTEM_PREFIXES.some((prefix) => packagePath.startsWith(prefix))
    }))
    const trusted = trustedPath || await this.isPrivilegedUpdatedSystemPackage(packageName, signal)
    this.trustedPackageCache.set(packageName, trusted)
    return trusted
  }


  private async isPrivilegedUpdatedSystemPackage(packageName: string, signal: AbortSignal) {
    const result = await this.device.run(
      ['shell', 'dumpsys', 'package', packageName],
      signal,
      10_000,
      'INSTALL_DIALOG_UNRECOGNIZED',
    ).catch(() => undefined)
    const packageDump = result?.stdout ?? ''
    const hasSystemFlag = /pkgFlags=\[[^\]]*\b(?:SYSTEM|UPDATED_SYSTEM_APP)\b[^\]]*\]/i.test(packageDump)
    const hasPrivilegedFlag = /privateFlags=\[[^\]]*\bPRIVILEGED\b[^\]]*\]/i.test(packageDump)
    return hasSystemFlag && hasPrivilegedFlag
  }

  private async saveDiagnostics(
    diagnosticsDirectory: string,
    currentWindow: string,
    xml: string,
    signal: AbortSignal,
  ) {
    await mkdir(diagnosticsDirectory, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    await Promise.all([
      writeFile(path.join(diagnosticsDirectory, `current-window-${timestamp}.txt`), currentWindow, 'utf8'),
      writeFile(path.join(diagnosticsDirectory, `install-dialog-${timestamp}.xml`), xml, 'utf8'),
      this.captureScreenshot(
        path.join(diagnosticsDirectory, `install-dialog-${timestamp}.png`),
        signal,
      ).catch(() => undefined),
    ])
  }
}
