import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { TaskExecutionError } from '../execution-errors.js'
import type {
  AndroidPreparationDevice,
  DiagnosticScreenshotCapture,
  HandledDialog,
} from './contracts.js'
import {
  KNOWN_DIALOG_WINDOW_PACKAGES,
  matchDialogAction,
} from './dialog-profiles.js'
import {
  boundsCenter,
  extractFocusedWindowComponent,
  extractFocusedWindowPackage,
  extractUiXml,
  nodeSearchText,
  parseUiNodes,
} from './ui-xml.js'

export interface DialogInspectionOptions {
  manufacturer: string
  packageName: string
  applicationLabel: string
  profileIds: readonly string[]
  diagnosticsDirectory: string
  maxActions: number
  signal: AbortSignal
  activeInstall?: boolean
}

export type DialogInspectionResult =
  | { kind: 'none' }
  | { kind: 'handled'; dialog: HandledDialog }
  | { kind: 'unrecognized'; fingerprint: string }

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

/**
 * Strict UI Automator controller. It only clicks a node selected by a registered
 * profile and derives coordinates from that node's XML bounds.
 *
 * OEM note: some Android builds omit mCurrentFocus from `dumpsys window windows`.
 * Window discovery and UI hierarchy collection therefore use conservative
 * fallbacks, while profile matching remains the only path that can click.
 */
export class SystemDialogController {
  private readonly clickedNodeFingerprints = new Set<string>()
  private readonly trustedPackageCache = new Map<string, boolean>()
  private actionCount = 0

  constructor(
    private readonly device: AndroidPreparationDevice,
    private readonly captureScreenshot: DiagnosticScreenshotCapture,
  ) {}

  async inspectAndHandle(options: DialogInspectionOptions): Promise<DialogInspectionResult> {
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
        fingerprint: `${focusedWindowPackage}:ui-hierarchy-unavailable`,
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

    const match = matchDialogAction(options.profileIds, {
      manufacturer: options.manufacturer,
      packageName: options.packageName,
      applicationLabel: options.applicationLabel,
      focusedWindowPackage,
      focusedWindowComponent: window.focusedWindowComponent,
      activeInstall: options.activeInstall ?? false,
      nodes,
    })

    if (!match) {
      const actionableText = nodes
        .filter((node) => node.clickable)
        .map(nodeSearchText)
        .join('|')
      return {
        kind: 'unrecognized',
        fingerprint: `${focusedWindowPackage}:${actionableText || 'no-actionable-node'}`,
      }
    }

    if (this.actionCount >= options.maxActions) {
      await this.saveDiagnostics(options.diagnosticsDirectory, window.diagnosticsText, xml, options.signal)
      throw new TaskExecutionError(
        `安装弹窗自动操作已达到上限 ${options.maxActions} 次`,
        'INSTALL_DIALOG_UNRECOGNIZED',
      )
    }

    const fingerprint = [
      focusedWindowPackage,
      match.profileId,
      match.action,
      match.node.resourceId,
      match.node.text,
      match.node.contentDescription,
      JSON.stringify(match.node.bounds),
    ].join(':')
    if (this.clickedNodeFingerprints.has(fingerprint)) {
      await this.saveDiagnostics(options.diagnosticsDirectory, window.diagnosticsText, xml, options.signal)
      throw new TaskExecutionError(
        `同一个安装弹窗节点重复出现，平台已停止自动点击：${match.profileId}`,
        'INSTALL_DIALOG_UNRECOGNIZED',
      )
    }

    const center = boundsCenter(match.node.bounds!)
    await this.device.run(
      ['shell', 'input', 'tap', String(center.x), String(center.y)],
      options.signal,
      10_000,
      'INSTALL_DIALOG_UNRECOGNIZED',
    )
    this.clickedNodeFingerprints.add(fingerprint)
    this.actionCount += 1

    return {
      kind: 'handled',
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
