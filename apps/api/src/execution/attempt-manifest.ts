import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { sha256File } from './file-utils.js'

const execFileAsync = promisify(execFile)

export const ANDROID_DIALOG_PROFILE_VERSION = 'android-dialog-profiles@1'

export interface SourceIdentity {
  commitSha: string
  dirty: boolean
}

export interface AttemptManifest {
  attemptId: string
  commitSha: string
  dirty: boolean
  startedAt: string
  device: {
    serial: string
    manufacturer: string
    model: string
    androidVersion: string
    buildFingerprint: string
  }
  protocolId: string
  profileVersion: string
  inputFingerprint: string
  evidenceDirectory: string
}

export interface AndroidDeviceSnapshot {
  connectionStatus: 'online' | 'offline' | 'unauthorized' | 'unknown'
  manufacturer: string
  model: string
  androidVersion: string
  buildFingerprint: string
  powerSummary?: string
  currentWindow?: string
  controllerPackages: string[]
  inputAutomationCommandAvailable: boolean
  observationFailures: string[]
}

interface AttemptManifestInput {
  attemptId: string
  deviceSerial: string
  deviceName: string
  protocolId: string
  profileVersion: string
  inputPath: string
  evidenceDirectory: string
}

interface AttemptManifestDependencies {
  now?: () => Date
  readSourceIdentity?: () => Promise<SourceIdentity>
}

interface CommandObservation {
  code: number | null
  stdout: string
  stderr: string
}

export type ReadAndroidCommand = (args: string[]) => Promise<CommandObservation>

export async function readSourceIdentity(rootDir: string): Promise<SourceIdentity> {
  try {
    const [{ stdout: commitOutput }, status] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }),
      execFileAsync('git', ['status', '--porcelain=v1'], { cwd: rootDir, encoding: 'utf8' }),
    ])
    return {
      commitSha: commitOutput.trim() || 'unknown',
      dirty: status.stdout.trim().length > 0,
    }
  } catch {
    // A packaged runner may not include .git metadata. Such executions remain
    // diagnostic-only because their source identity cannot be confirmed.
    return { commitSha: 'unknown', dirty: true }
  }
}

export async function buildAttemptManifest(
  input: AttemptManifestInput,
  dependencies: AttemptManifestDependencies = {},
): Promise<AttemptManifest> {
  const sourceIdentity = await (dependencies.readSourceIdentity?.()
    ?? readSourceIdentity(process.cwd()))
  const inputFingerprint = await sha256File(input.inputPath).catch(() => 'unavailable')
  return {
    attemptId: input.attemptId,
    commitSha: sourceIdentity.commitSha,
    dirty: sourceIdentity.dirty,
    startedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    device: {
      serial: input.deviceSerial,
      manufacturer: 'unknown',
      model: input.deviceName || 'unknown',
      androidVersion: 'unknown',
      buildFingerprint: 'unknown',
    },
    protocolId: input.protocolId,
    profileVersion: input.profileVersion,
    inputFingerprint,
    evidenceDirectory: input.evidenceDirectory,
  }
}

export async function writeAttemptManifest(targetPath: string, manifest: AttemptManifest) {
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function summarizePower(output: string) {
  const lines = output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /wakefulness|interactive/i.test(line))
    .slice(0, 4)
  return lines.length > 0 ? lines.join('; ') : undefined
}

function extractCurrentWindow(output: string) {
  const currentFocus = output.match(/mCurrentFocus=Window\{[^}]*?\s(?:u\d+\s+)?([^\s}]+\/[^\s}]+)\}/i)?.[1]
  if (currentFocus) return currentFocus
  return output.match(/mFocusedApp=.*?\s(?:u\d+\s+)?([^\s}]+\/[^\s}]+)/i)?.[1]
}

async function observe(
  label: string,
  args: string[],
  readCommand: ReadAndroidCommand,
  failures: string[],
) {
  try {
    const result = await readCommand(args)
    if (result.code === 0) return result.stdout.trim()
    failures.push(`${label}: code=${result.code ?? 'null'} ${result.stderr.trim() || 'command failed'}`)
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return undefined
}

export async function captureAndroidDeviceSnapshot(
  connectionStatus: AndroidDeviceSnapshot['connectionStatus'],
  readCommand: ReadAndroidCommand,
): Promise<AndroidDeviceSnapshot> {
  const observationFailures: string[] = []
  if (connectionStatus !== 'online') {
    return {
      connectionStatus,
      manufacturer: 'unknown',
      model: 'unknown',
      androidVersion: 'unknown',
      buildFingerprint: 'unknown',
      controllerPackages: [],
      inputAutomationCommandAvailable: false,
      observationFailures: [`device connection is ${connectionStatus}`],
    }
  }

  const [manufacturer, model, androidVersion, buildFingerprint, power, windows, packages, inputHelp] = await Promise.all([
    observe('getprop ro.product.manufacturer', ['shell', 'getprop', 'ro.product.manufacturer'], readCommand, observationFailures),
    observe('getprop ro.product.model', ['shell', 'getprop', 'ro.product.model'], readCommand, observationFailures),
    observe('getprop ro.build.version.release', ['shell', 'getprop', 'ro.build.version.release'], readCommand, observationFailures),
    observe('getprop ro.build.fingerprint', ['shell', 'getprop', 'ro.build.fingerprint'], readCommand, observationFailures),
    observe('dumpsys power', ['shell', 'dumpsys', 'power'], readCommand, observationFailures),
    observe('dumpsys window windows', ['shell', 'dumpsys', 'window', 'windows'], readCommand, observationFailures),
    observe('pm list packages', ['shell', 'pm', 'list', 'packages'], readCommand, observationFailures),
    observe('input help', ['shell', 'input', 'help'], readCommand, observationFailures),
  ])

  const knownControllerPackages = [
    'com.android.packageinstaller',
    'com.google.android.packageinstaller',
    'com.android.permissioncontroller',
    'com.oplus.appdetail',
    'com.oplus.permissioncontroller',
    'com.oppo.permissioncontroller',
  ]

  return {
    connectionStatus,
    manufacturer: manufacturer || 'unknown',
    model: model || 'unknown',
    androidVersion: androidVersion || 'unknown',
    buildFingerprint: buildFingerprint || 'unknown',
    powerSummary: power ? summarizePower(power) : undefined,
    currentWindow: windows ? extractCurrentWindow(windows) : undefined,
    controllerPackages: knownControllerPackages.filter((packageName) => packages?.includes(`package:${packageName}`)),
    inputAutomationCommandAvailable: Boolean(inputHelp),
    observationFailures,
  }
}
