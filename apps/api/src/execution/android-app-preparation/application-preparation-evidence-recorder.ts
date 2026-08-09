import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ProcessResult } from '../../process.js'
import type { DiagnosticScreenshotCapture } from './contracts.js'
import type { DialogPhaseObservation } from './dialog-phase-state-machine.js'
import type { DialogBusinessPhase } from './dialog-profiles.js'
import type { DialogInspectionResult } from './dialog-state.js'

interface CommandEvidenceInput {
  phase: DialogBusinessPhase
  operation: 'install' | 'uninstall'
  args: readonly string[]
  startedAt: Date
  finishedAt: Date
  result?: ProcessResult
  error?: unknown
}

interface DialogObservationEvidenceInput {
  phase: DialogBusinessPhase
  focusedWindowPackage: string
  focusedWindowComponent?: string
  currentWindow: string
  uiXml: string
  inspection: DialogInspectionResult
  signal: AbortSignal
}

interface TransitionEvidenceInput {
  phase: DialogBusinessPhase
  inspection: DialogInspectionResult
  observation: DialogPhaseObservation
}

interface ApplicationPreparationEvidenceRecorderOptions {
  diagnosticsDirectory: string
  captureScreenshot: DiagnosticScreenshotCapture
  now?: () => Date
}

interface TransitionEvidenceFile {
  phase: DialogBusinessPhase
  history: Array<{
    observedAt: string
    inspectionKind: DialogInspectionResult['kind']
    state: DialogPhaseObservation['state']
    enteredStates: DialogPhaseObservation['enteredStates']
    signatureChanged: boolean
    elapsedMs: number
    stable: boolean
    transitionVerified: boolean
  }>
}

function errorDetails(error: unknown) {
  if (!error || typeof error !== 'object') {
    return { message: String(error) }
  }
  const candidate = error as {
    name?: unknown
    code?: unknown
    message?: unknown
    processResult?: ProcessResult
  }
  return {
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
    code: typeof candidate.code === 'string' ? candidate.code : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : String(error),
    processResult: candidate.processResult,
  }
}

function processSummary(result?: ProcessResult) {
  if (!result) return undefined
  return {
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout),
    stderrBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr),
    stdoutTruncated: result.stdoutTruncated ?? false,
    stderrTruncated: result.stderrTruncated ?? false,
  }
}

function inspectionActionResult(inspection: DialogInspectionResult) {
  if (inspection.kind === 'handled') {
    return {
      outcome: 'handled' as const,
      profileId: inspection.dialog.profileId,
      action: inspection.dialog.action,
      signature: inspection.signature,
    }
  }
  if (inspection.kind === 'manual-action-required') {
    return {
      outcome: 'rejected' as const,
      profileId: inspection.block.profileId,
      reason: inspection.block.reason,
      summary: inspection.block.summary,
      signature: inspection.signature,
    }
  }
  if (inspection.kind === 'waiting') {
    return {
      outcome: 'not_applicable' as const,
      reason: inspection.reason,
      signature: inspection.signature,
    }
  }
  if (inspection.kind === 'unrecognized') {
    return {
      outcome: 'not_applicable' as const,
      reason: 'unrecognized-page',
      signature: inspection.signature,
    }
  }
  return {
    outcome: 'not_applicable' as const,
    reason: 'no-known-dialog-window',
  }
}

function safeSegment(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'event'
}

/**
 * Owns preparation-phase Evidence layout and correlation. It deliberately
 * treats all file and screenshot failures as auxiliary failures: Evidence
 * capture must never replace the installation or permission business result.
 */
export class ApplicationPreparationEvidenceRecorder {
  private readonly now: () => Date
  private sequence = 0
  private readonly observationDirectories = new Map<string, string>()
  private readonly transitionHistory = new Map<string, TransitionEvidenceFile>()

  constructor(private readonly options: ApplicationPreparationEvidenceRecorderOptions) {
    this.now = options.now ?? (() => new Date())
  }

  async recordCommand(input: CommandEvidenceInput): Promise<string | undefined> {
    return this.bestEffort(async () => {
      const directory = await this.createEventDirectory(input.phase, `adb-${input.operation}`)
      const error = input.error ? errorDetails(input.error) : undefined
      const result = input.result ?? error?.processResult
      await this.writeJson(path.join(directory.absolutePath, 'adb-command.json'), {
        phase: input.phase,
        operation: input.operation,
        args: input.args,
        startedAt: input.startedAt.toISOString(),
        finishedAt: input.finishedAt.toISOString(),
        durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
        status: input.error ? 'failed' : 'succeeded',
        result: processSummary(result),
        error: error
          ? { name: error.name, code: error.code, message: error.message }
          : undefined,
      })
      return `${directory.relativePath}/adb-command.json`
    })
  }

  async recordDialogObservation(
    input: DialogObservationEvidenceInput,
  ): Promise<string | undefined> {
    const signature = input.inspection.kind === 'none'
      ? `${input.phase}:${input.focusedWindowPackage}:${input.focusedWindowComponent ?? ''}:none`
      : `${input.phase}:${input.inspection.signature.pageFingerprint
        ?? JSON.stringify(input.inspection.signature)}`
    const existing = this.observationDirectories.get(signature)
    if (existing) return existing

    return this.bestEffort(async () => {
      const directory = await this.createEventDirectory(input.phase, 'dialog-frame')
      this.observationDirectories.set(signature, directory.relativePath)
      await Promise.all([
        writeFile(path.join(directory.absolutePath, 'window.txt'), input.currentWindow, 'utf8'),
        writeFile(path.join(directory.absolutePath, 'ui.xml'), input.uiXml, 'utf8'),
        this.writeJson(path.join(directory.absolutePath, 'action-result.json'), {
          observedAt: this.now().toISOString(),
          phase: input.phase,
          focusedWindowPackage: input.focusedWindowPackage,
          focusedWindowComponent: input.focusedWindowComponent,
          inspectionKind: input.inspection.kind,
          ...inspectionActionResult(input.inspection),
          screenshot: input.signal.aborted
            ? { status: 'skipped', reason: 'attempt-cancelled' }
            : { status: 'pending' },
        }),
      ])

      let screenshot: { status: 'captured' | 'failed' | 'skipped'; reason?: string }
      if (input.signal.aborted) {
        screenshot = { status: 'skipped', reason: 'attempt-cancelled' }
      } else {
        try {
          await this.options.captureScreenshot(
            path.join(directory.absolutePath, 'screenshot.png'),
            input.signal,
          )
          screenshot = { status: 'captured' }
        } catch (error) {
          screenshot = {
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          }
        }
      }

      await this.writeJson(path.join(directory.absolutePath, 'action-result.json'), {
        observedAt: this.now().toISOString(),
        phase: input.phase,
        focusedWindowPackage: input.focusedWindowPackage,
        focusedWindowComponent: input.focusedWindowComponent,
        inspectionKind: input.inspection.kind,
        ...inspectionActionResult(input.inspection),
        screenshot,
      })
      return directory.relativePath
    })
  }

  async recordTransition(
    evidenceDirectory: string | undefined,
    input: TransitionEvidenceInput,
  ): Promise<string | undefined> {
    if (!evidenceDirectory) return undefined
    return this.bestEffort(async () => {
      const current = this.transitionHistory.get(evidenceDirectory) ?? {
        phase: input.phase,
        history: [],
      }
      current.history.push({
        observedAt: this.now().toISOString(),
        inspectionKind: input.inspection.kind,
        state: input.observation.state,
        enteredStates: input.observation.enteredStates,
        signatureChanged: input.observation.signatureChanged,
        elapsedMs: input.observation.elapsedMs,
        stable: input.observation.stable,
        transitionVerified: input.observation.transitionVerified,
      })
      this.transitionHistory.set(evidenceDirectory, current)
      const targetPath = path.join(
        this.options.diagnosticsDirectory,
        evidenceDirectory,
        'transition-result.json',
      )
      await this.writeJson(targetPath, current)
      return `${evidenceDirectory}/transition-result.json`
    })
  }

  private async createEventDirectory(phase: DialogBusinessPhase, kind: string) {
    this.sequence += 1
    const relativePath = path.join(
      'application-preparation',
      safeSegment(phase),
      `${String(this.sequence).padStart(4, '0')}-${safeSegment(kind)}`,
    )
    const absolutePath = path.join(this.options.diagnosticsDirectory, relativePath)
    await mkdir(absolutePath, { recursive: true })
    return { relativePath, absolutePath }
  }

  private async writeJson(targetPath: string, value: unknown) {
    await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }

  private async bestEffort<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await operation()
    } catch {
      return undefined
    }
  }
}

