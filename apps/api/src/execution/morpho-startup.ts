import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  classifyDeviceReadinessSnapshot,
  type DeviceReadinessObservation,
} from './android-app-preparation/device-readiness.js'
import { TaskExecutionError } from './execution-errors.js'
import { delay as abortableDelay } from './file-utils.js'

export type MorphoStartupEvidence = 'MORPHO_LOG' | 'BATCH_SERVICE'

export interface MorphoStartupProbeResult {
  code: number
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  stdoutBytes?: number
  stderrBytes?: number
}

export interface MorphoStartupProbeCapture {
  services: MorphoStartupProbeResult
  process: MorphoStartupProbeResult
  power: MorphoStartupProbeResult
  windowPolicy: MorphoStartupProbeResult
}

export type MorphoStartupProbeSection = 'services' | 'process' | 'power' | 'windowPolicy'

export interface MorphoStartupProbeCapturePaths {
  stdoutPath: string
  stderrPath: string
}

export interface MorphoStartupProbeRunner {
  run(
    args: string[],
    signal: AbortSignal,
    timeoutMs: number,
    capture: MorphoStartupProbeCapturePaths,
  ): Promise<MorphoStartupProbeResult>
}

export interface CollectMorphoStartupProbeOptions {
  packageName: string
  diagnosticsDirectory: string
  attempt: number
  remainingMs: number
  signal: AbortSignal
  runner: MorphoStartupProbeRunner
}

export interface MorphoStartupState {
  processRunning: boolean
  serviceRunning: boolean
  readiness: DeviceReadinessObservation
}

export type MorphoStartupInspection =
  | ({ kind: 'complete' } & MorphoStartupState)
  | {
      kind: 'incomplete'
      reason: 'truncated' | 'command_failed' | 'empty_output'
      missingSections: readonly MorphoStartupProbeSection[]
      /** Positive evidence may remain trustworthy even when another section is incomplete. */
      serviceRunning?: true
      processRunning?: true
      summary: string
    }

function resultBytes(result: MorphoStartupProbeResult) {
  return {
    stdout: result.stdoutBytes ?? Buffer.byteLength(result.stdout),
    stderr: result.stderrBytes ?? Buffer.byteLength(result.stderr),
  }
}

function resultWasTruncated(result: MorphoStartupProbeResult) {
  return Boolean(result.stdoutTruncated || result.stderrTruncated)
}

function commandFailed(section: MorphoStartupProbeSection, result: MorphoStartupProbeResult) {
  // Android's pidof returns 1 when the process is simply absent. That is a valid
  // negative observation, not a probe/infrastructure failure.
  return section === 'process'
    ? result.code !== 0 && result.code !== 1
    : result.code !== 0
}

export function isMorphoBatchServiceRunning(dumpsys: string) {
  return [
    'com.morphoinc.videopostprocessor/.BatchProcessService',
    'com.morphoinc.videopostprocessor/com.morphoinc.videopostprocessor.BatchProcessService',
  ].some((component) => dumpsys.includes(component))
}

export function inspectMorphoStartupProbe(
  capture: MorphoStartupProbeCapture,
): MorphoStartupInspection {
  const entries = Object.entries(capture) as Array<[
    MorphoStartupProbeSection,
    MorphoStartupProbeResult,
  ]>
  const missingSections: MorphoStartupProbeSection[] = []
  let hasTruncation = false
  let hasCommandFailure = false
  let hasEmptyOutput = false

  for (const [section, result] of entries) {
    const truncated = resultWasTruncated(result)
    const failed = commandFailed(section, result)
    // Empty output is a valid negative result for the scoped service query and
    // for pidof. Readiness cannot be classified without power/policy output.
    const empty = (section === 'power' || section === 'windowPolicy') && !result.stdout.trim()
    if (truncated || failed || empty) missingSections.push(section)
    hasTruncation ||= truncated
    hasCommandFailure ||= failed
    hasEmptyOutput ||= empty
  }

  const serviceDetected = isMorphoBatchServiceRunning(capture.services.stdout)
  const processDetected = /(?:^|\s)\d+(?:\s|$)/.test(capture.process.stdout)

  if (missingSections.length > 0) {
    const reason = hasTruncation
      ? 'truncated'
      : hasCommandFailure
        ? 'command_failed'
        : 'empty_output'
    const byteSummary = entries.map(([section, result]) => {
      const bytes = resultBytes(result)
      return `${section}(code=${result.code},stdout=${bytes.stdout},stderr=${bytes.stderr},truncated=${resultWasTruncated(result)})`
    }).join('; ')
    return {
      kind: 'incomplete',
      reason,
      missingSections,
      ...(serviceDetected ? { serviceRunning: true as const } : {}),
      ...(processDetected ? { processRunning: true as const } : {}),
      summary: `reason=${reason}; missing=${missingSections.join(',')}; ${byteSummary}`,
    }
  }

  return {
    kind: 'complete',
    processRunning: processDetected,
    serviceRunning: serviceDetected,
    readiness: classifyDeviceReadinessSnapshot({
      power: capture.power.stdout,
      windowPolicy: capture.windowPolicy.stdout,
    }),
  }
}

export function buildMorphoStartupProbeCommands(packageName: string) {
  return [
    {
      section: 'services' as const,
      args: [
        'shell',
        'dumpsys',
        'activity',
        'services',
        `${packageName}/.BatchProcessService`,
      ],
    },
    { section: 'process' as const, args: ['shell', 'pidof', packageName] },
    { section: 'power' as const, args: ['shell', 'dumpsys', 'power'] },
    { section: 'windowPolicy' as const, args: ['shell', 'dumpsys', 'window', 'policy'] },
  ]
}

export async function collectMorphoStartupInspection(
  options: CollectMorphoStartupProbeOptions,
): Promise<MorphoStartupInspection> {
  const directory = path.join(options.diagnosticsDirectory, 'morpho-startup')
  await mkdir(directory, { recursive: true })
  const prefix = `probe-${String(options.attempt).padStart(2, '0')}`
  const deadline = Date.now() + options.remainingMs
  const remainingMs = () => Math.max(1, deadline - Date.now())

  const commands = [] as Array<{
    section: MorphoStartupProbeSection
    args: string[]
    capture: MorphoStartupProbeCapturePaths
    result: MorphoStartupProbeResult
    durationMs: number
  }>
  for (const command of buildMorphoStartupProbeCommands(options.packageName)) {
    const fileStem = command.section === 'windowPolicy' ? 'window-policy' : command.section
    const capture = {
      stdoutPath: path.join(directory, `${prefix}-${fileStem}.stdout.txt`),
      stderrPath: path.join(directory, `${prefix}-${fileStem}.stderr.txt`),
    }
    const commandStartedAt = Date.now()
    const result = await options.runner.run(
      command.args,
      options.signal,
      remainingMs(),
      capture,
    )
    commands.push({
      ...command,
      capture,
      result,
      durationMs: Date.now() - commandStartedAt,
    })
  }

  const bySection = Object.fromEntries(
    commands.map((command) => [command.section, command.result]),
  ) as unknown as MorphoStartupProbeCapture
  const inspection = inspectMorphoStartupProbe(bySection)
  const metadataPath = path.join(directory, `${prefix}-metadata.json`)
  await writeFile(metadataPath, JSON.stringify({
    capturedAt: new Date().toISOString(),
    packageName: options.packageName,
    attempt: options.attempt,
    inspection,
    commands: commands.map(({ section, args, capture, result, durationMs }) => ({
      section,
      args,
      exitCode: result.code,
      durationMs,
      stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout),
      stderrBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr),
      stdoutTruncated: Boolean(result.stdoutTruncated),
      stderrTruncated: Boolean(result.stderrTruncated),
      stdoutFile: path.basename(capture.stdoutPath),
      stderrFile: path.basename(capture.stderrPath),
    })),
  }, null, 2), 'utf8')
  return inspection
}

export interface MorphoStartupOptions {
  signal: AbortSignal
  hasBusinessLog: () => boolean
  getLogcatFailure: () => TaskExecutionError | undefined
  inspect: (remainingMs: number) => Promise<MorphoStartupInspection>
  now?: () => number
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
  diagnosticAfterMs?: number
  timeoutMs?: number
  pollIntervalMs?: number
  onIncompleteObservation?: (
    observation: Extract<MorphoStartupInspection, { kind: 'incomplete' }>,
  ) => void
}

export async function waitForMorphoStartup(
  options: MorphoStartupOptions,
): Promise<MorphoStartupEvidence> {
  const now = options.now ?? Date.now
  const wait = options.delay ?? abortableDelay
  const diagnosticAfterMs = options.diagnosticAfterMs ?? 3_000
  const timeoutMs = options.timeoutMs ?? 15_000
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const startedAt = now()
  let nextInspectionAt = diagnosticAfterMs
  let lastReadiness: DeviceReadinessObservation = {
    condition: 'unknown',
    summary: 'startup probe not yet collected',
  }
  let lastIncompleteObservation: Extract<MorphoStartupInspection, { kind: 'incomplete' }> | undefined

  while (true) {
    if (options.signal.aborted) throw new DOMException('任务已取消', 'AbortError')
    if (options.hasBusinessLog()) return 'MORPHO_LOG'

    const elapsed = now() - startedAt
    if (elapsed < nextInspectionAt) {
      await wait(Math.min(nextInspectionAt - elapsed, pollIntervalMs), options.signal)
      continue
    }

    if (elapsed >= timeoutMs) {
      const logcatFailure = options.getLogcatFailure()
      if (logcatFailure) throw logcatFailure
      if (lastIncompleteObservation) {
        throw new TaskExecutionError(
          `Morpho 启动证据在 ${Math.round(timeoutMs / 1000)} 秒内始终不完整：${lastIncompleteObservation.summary}`,
          'STARTUP_OBSERVATION_INCOMPLETE',
        )
      }
      throw new TaskExecutionError(
        `Morpho 未在 ${Math.round(timeoutMs / 1000)} 秒内产生启动证据；最后设备状态=${lastReadiness.condition}；${lastReadiness.summary}`,
        'SDK_START_FAILED',
      )
    }

    const state = await options.inspect(Math.max(1, timeoutMs - elapsed))
    // A positive business-service observation is conclusive even when an
    // unrelated readiness section was truncated or unavailable.
    if (state.serviceRunning) return 'BATCH_SERVICE'
    if (state.kind === 'incomplete') {
      lastIncompleteObservation = state
      options.onIncompleteObservation?.(state)
      nextInspectionAt = Math.min(timeoutMs, elapsed + pollIntervalMs)
      continue
    }

    // A later complete observation supersedes an earlier partial one.
    lastIncompleteObservation = undefined
    lastReadiness = state.readiness
    if (!state.processRunning) {
      throw new TaskExecutionError('Morpho 应用进程在启动握手期间退出', 'APP_CRASHED')
    }
    if (state.readiness.condition === 'secure_locked') {
      throw new TaskExecutionError('设备进入安全锁屏，Morpho 批处理服务未启动', 'DEVICE_LOCKED')
    }
    if (state.readiness.condition === 'sleeping') {
      throw new TaskExecutionError('设备重新休眠，Morpho 批处理服务未启动', 'DEVICE_WAKE_FAILED')
    }
    const logcatFailure = options.getLogcatFailure()
    if (logcatFailure) throw logcatFailure
    nextInspectionAt = Math.min(timeoutMs, elapsed + pollIntervalMs)
  }
}
