import {
  classifyDeviceReadinessSnapshot,
  type DeviceReadinessObservation,
} from './android-app-preparation/device-readiness.js'
import { TaskExecutionError } from './execution-errors.js'
import { delay as abortableDelay } from './file-utils.js'

export type MorphoStartupEvidence = 'MORPHO_LOG' | 'BATCH_SERVICE'

const SERVICES_MARKER = '__MORPHO_SERVICES__'
const PROCESS_MARKER = '__MORPHO_PROCESS__='
const POWER_MARKER = '__MORPHO_POWER__'
const POLICY_MARKER = '__MORPHO_POLICY__'

function sectionBetween(output: string, startMarker: string, endMarker?: string) {
  const start = output.indexOf(startMarker)
  if (start < 0) return undefined
  const contentStart = start + startMarker.length
  const end = endMarker ? output.indexOf(endMarker, contentStart) : output.length
  if (end < 0) return undefined
  return output.slice(contentStart, end)
}

export function buildMorphoStartupProbeArguments(packageName: string) {
  const script = [
    `echo '${SERVICES_MARKER}'`,
    'dumpsys activity services "$1"',
    `printf '${PROCESS_MARKER}'`,
    'pidof "$1" || true',
    'echo',
    `echo '${POWER_MARKER}'`,
    'dumpsys power',
    `echo '${POLICY_MARKER}'`,
    'dumpsys window policy',
  ].join('; ')
  return ['shell', 'sh', '-c', script, 'morpho-startup-probe', packageName]
}

export function parseMorphoStartupProbe(output: string): MorphoStartupState {
  const services = sectionBetween(output, SERVICES_MARKER, PROCESS_MARKER)
  const process = sectionBetween(output, PROCESS_MARKER, POWER_MARKER)
  const power = sectionBetween(output, POWER_MARKER, POLICY_MARKER)
  const windowPolicy = sectionBetween(output, POLICY_MARKER)
  if (services === undefined || process === undefined
    || power === undefined || windowPolicy === undefined) {
    throw new TaskExecutionError('Morpho 启动状态探测输出不完整', 'SDK_START_FAILED')
  }
  return {
    processRunning: /\d/.test(process),
    serviceRunning: isMorphoBatchServiceRunning(services),
    readiness: classifyDeviceReadinessSnapshot({ power, windowPolicy }),
  }
}

export function isMorphoBatchServiceRunning(dumpsys: string) {
  return [
    'com.morphoinc.videopostprocessor/.BatchProcessService',
    'com.morphoinc.videopostprocessor/com.morphoinc.videopostprocessor.BatchProcessService',
  ].some((component) => dumpsys.includes(component))
}

export interface MorphoStartupState {
  processRunning: boolean
  serviceRunning: boolean
  readiness: DeviceReadinessObservation
}

interface MorphoStartupOptions {
  signal: AbortSignal
  hasBusinessLog: () => boolean
  getLogcatFailure: () => TaskExecutionError | undefined
  inspect: (remainingMs: number) => Promise<MorphoStartupState>
  now?: () => number
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
  diagnosticAfterMs?: number
  timeoutMs?: number
  pollIntervalMs?: number
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
      throw new TaskExecutionError(
        `Morpho 启动命令已发送，但 ${Math.round(timeoutMs / 1000)} 秒内未检测到业务日志或 BatchProcessService；`
          + `最后设备状态=${lastReadiness.condition}；${lastReadiness.summary}`,
        'SDK_START_FAILED',
      )
    }

    const state = await options.inspect(Math.max(1, timeoutMs - elapsed))
    lastReadiness = state.readiness
    if (state.serviceRunning) return 'BATCH_SERVICE'
    if (!state.processRunning) {
      throw new TaskExecutionError('Morpho 进程已退出，业务批处理服务未启动', 'APP_CRASHED')
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
