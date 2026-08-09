import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ProcessResult } from '../process.js'
import type { DeviceRunPhase } from '../types.js'
import type { ProtocolExecutionDevice, ProtocolExecutionStreams } from './protocol-executor.js'

interface ScreenshotCapture {
  (targetPath: string, signal: AbortSignal): Promise<void>
}

export interface AttemptFailureEvidenceInput {
  phase: DeviceRunPhase
  error: unknown
  cancelled: boolean
}

interface AttemptEvidenceRecorderOptions {
  executionKey: string
  runDirectory: string
  maxLogcatBytes: number
  device: ProtocolExecutionDevice
  streams: ProtocolExecutionStreams
  captureScreenshot: ScreenshotCapture
  now?: () => Date
}

interface EvidenceCaptureRecord {
  evidenceRef: string
  status: 'captured' | 'failed' | 'skipped'
  error?: string
  command?: string[]
  result?: {
    exitCode: number
    stdoutBytes: number
    stderrBytes: number
    stdoutTruncated?: boolean
    stderrTruncated?: boolean
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function errorIdentity(error: unknown) {
  if (!error || typeof error !== 'object') return {}
  const candidate = error as { name?: unknown; code?: unknown }
  return {
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
    code: typeof candidate.code === 'string' ? candidate.code : undefined,
  }
}

function resultSummary(result: ProcessResult): EvidenceCaptureRecord['result'] {
  return {
    exitCode: result.code,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  }
}

/**
 * Deep attempt-evidence module. Callers report one terminal failure; this module
 * owns the best-effort Android snapshot, full Logcat snapshot, screenshot,
 * capture metadata, stable paths, and cancellation-safe policy.
 */
export class AttemptEvidenceRecorder {
  private readonly now: () => Date

  constructor(private readonly options: AttemptEvidenceRecorderOptions) {
    this.now = options.now ?? (() => new Date())
  }

  async captureFailure(input: AttemptFailureEvidenceInput): Promise<string[]> {
    const directory = path.join(this.options.runDirectory, 'diagnostics', 'failure')
    await mkdir(directory, { recursive: true })

    const contextRef = 'diagnostics/failure/failure-context.json'
    const captureResultRef = 'diagnostics/failure/evidence-capture-result.json'
    const records: EvidenceCaptureRecord[] = []
    const capturedRefs = [contextRef]
    const identity = errorIdentity(input.error)

    await writeFile(path.join(this.options.runDirectory, contextRef), `${JSON.stringify({
      capturedAt: this.now().toISOString(),
      phase: input.phase,
      cancelled: input.cancelled,
      error: {
        ...identity,
        message: errorMessage(input.error),
      },
    }, null, 2)}\n`)

    if (input.cancelled) {
      for (const evidenceRef of [
        'diagnostics/failure/window.txt',
        'diagnostics/failure/ui.xml',
        'diagnostics/failure/screenshot.png',
        'diagnostics/failure/logcat-full.txt',
      ]) {
        records.push({ evidenceRef, status: 'skipped', error: 'cancelled-attempt-does-not-observe-device' })
      }
    } else {
      const signal = new AbortController().signal
      await this.captureObservation(
        ['shell', 'dumpsys', 'window', 'windows'],
        'diagnostics/failure/window.txt',
        signal,
        records,
        capturedRefs,
      )
      await this.captureObservation(
        ['exec-out', 'uiautomator', 'dump', '/dev/tty'],
        'diagnostics/failure/ui.xml',
        signal,
        records,
        capturedRefs,
      )
      await this.captureBinary(
        'diagnostics/failure/screenshot.png',
        () => this.options.captureScreenshot(
          path.join(this.options.runDirectory, 'diagnostics/failure/screenshot.png'),
          signal,
        ),
        records,
        capturedRefs,
      )
      await this.captureBinary(
        'diagnostics/failure/logcat-full.txt',
        () => this.options.streams.captureLogcatSnapshot(
          this.options.executionKey,
          path.join(this.options.runDirectory, 'diagnostics/failure/logcat-full.txt'),
          signal,
          this.options.maxLogcatBytes,
        ),
        records,
        capturedRefs,
      )
    }

    await writeFile(path.join(this.options.runDirectory, captureResultRef), `${JSON.stringify({
      capturedAt: this.now().toISOString(),
      records,
    }, null, 2)}\n`)
    capturedRefs.push(captureResultRef)
    return capturedRefs
  }

  private async captureObservation(
    command: string[],
    evidenceRef: string,
    signal: AbortSignal,
    records: EvidenceCaptureRecord[],
    capturedRefs: string[],
  ) {
    try {
      const result = await this.options.device.observe(command, signal, 15_000)
      await writeFile(
        path.join(this.options.runDirectory, evidenceRef),
        result.stdout || result.stderr,
        'utf8',
      )
      records.push({ evidenceRef, status: 'captured', command, result: resultSummary(result) })
      capturedRefs.push(evidenceRef)
    } catch (error) {
      records.push({ evidenceRef, status: 'failed', command, error: errorMessage(error) })
    }
  }

  private async captureBinary(
    evidenceRef: string,
    capture: () => Promise<void>,
    records: EvidenceCaptureRecord[],
    capturedRefs: string[],
  ) {
    try {
      await capture()
      records.push({ evidenceRef, status: 'captured' })
      capturedRefs.push(evidenceRef)
    } catch (error) {
      records.push({ evidenceRef, status: 'failed', error: errorMessage(error) })
    }
  }
}
