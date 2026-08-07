import { TaskExecutionError } from '../execution-errors.js'
import { delay as abortableDelay } from '../file-utils.js'
import type { AndroidPreparationDevice } from './contracts.js'
import { isInputInjectionDenied } from './input-automation-compatibility.js'

export type DeviceLaunchCondition =
  | 'ready'
  | 'sleeping'
  | 'keyguard'
  | 'secure_locked'
  | 'unknown'

export interface DeviceReadinessObservation {
  condition: DeviceLaunchCondition
  summary: string
}

type BooleanEvidence = {
  label: string
  value: boolean
}

type EvidenceResolution = {
  value: boolean | 'unknown'
  evidence: string[]
}

interface ReadinessRuntimeOptions {
  now?: () => number
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
  timeoutMs?: number
  pollIntervalMs?: number
  inspectionTimeoutMs?: number
}

const SECURE_LOCK_MESSAGE = '设备仍处于安全锁屏状态。测试机必须移除 PIN、图案或密码锁后才能无人值守执行。'

function normalizeBoolean(value: string) {
  return value.toLowerCase() === 'true'
}

function collectBooleanEvidence(
  text: string,
  rules: ReadonlyArray<{ label: string; pattern: RegExp; map?: (value: string) => boolean }>,
) {
  const evidence: BooleanEvidence[] = []
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      const raw = match[1]
      if (!raw) continue
      evidence.push({
        label: `${rule.label}=${raw}`,
        value: rule.map ? rule.map(raw) : normalizeBoolean(raw),
      })
    }
  }
  return evidence
}

function resolveEvidence(evidence: BooleanEvidence[]): EvidenceResolution {
  const values = new Set(evidence.map((item) => item.value))
  if (values.size !== 1) {
    return {
      value: 'unknown',
      evidence: evidence.length > 0
        ? [`conflict(${evidence.map((item) => item.label).join(',')})`]
        : ['missing'],
    }
  }
  return {
    value: evidence[0]!.value,
    evidence: evidence.map((item) => item.label),
  }
}

function indentedSection(text: string, heading: RegExp) {
  const lines = text.split(/\r?\n/)
  const headingIndex = lines.findIndex((line) => heading.test(line))
  if (headingIndex < 0) return ''
  const headingIndent = /^\s*/.exec(lines[headingIndex]!)?.[0].length ?? 0
  const section = [lines[headingIndex]!]
  for (const line of lines.slice(headingIndex + 1)) {
    if (!line.trim()) {
      section.push(line)
      continue
    }
    const indent = /^\s*/.exec(line)?.[0].length ?? 0
    if (indent <= headingIndent) break
    section.push(line)
  }
  return section.join('\n')
}

function parsePowerEvidence(power: string, windowPolicy: string): EvidenceResolution {
  const evidence = collectBooleanEvidence(power, [
    {
      label: 'mWakefulness',
      pattern: /\bmWakefulness\s*[:=]\s*(Awake|Asleep|Dozing)\b/gi,
      map: (value) => value.toLowerCase() === 'awake',
    },
    { label: 'mInteractive', pattern: /\bmInteractive\s*[:=]\s*(true|false)\b/gi },
    { label: 'mIsInteractive', pattern: /\bmIsInteractive\s*[:=]\s*(true|false)\b/gi },
    {
      label: 'DisplayPower.state',
      pattern: /\bDisplay Power\s*:\s*state\s*=\s*(ON|OFF|DOZE|DOZE_SUSPEND)\b/gi,
      map: (value) => value.toUpperCase() === 'ON',
    },
  ])

  const delegate = indentedSection(windowPolicy, /\bKeyguardServiceDelegate\b/i)
  evidence.push(...collectBooleanEvidence(delegate, [
    {
      label: 'KeyguardServiceDelegate.interactiveState',
      pattern: /\binteractiveState\s*=\s*(INTERACTIVE_STATE_AWAKE|INTERACTIVE_STATE_ASLEEP)\b/gi,
      map: (value) => value.toUpperCase() === 'INTERACTIVE_STATE_AWAKE',
    },
    {
      label: 'KeyguardServiceDelegate.screenState',
      pattern: /\bscreenState\s*=\s*(SCREEN_STATE_ON|SCREEN_STATE_OFF)\b/gi,
      map: (value) => value.toUpperCase() === 'SCREEN_STATE_ON',
    },
  ]))

  return resolveEvidence(evidence)
}

function firstResolvedShowingEvidence(windowPolicy: string): EvidenceResolution {
  const stateMonitor = indentedSection(windowPolicy, /\bKeyguardStateMonitor\b/i)
  const stateMonitorEvidence = collectBooleanEvidence(stateMonitor, [
    {
      label: 'KeyguardStateMonitor.mIsShowing',
      pattern: /\bmIsShowing\s*[:=]\s*(true|false)\b/gi,
    },
  ])
  if (stateMonitorEvidence.length > 0) return resolveEvidence(stateMonitorEvidence)

  const delegate = indentedSection(windowPolicy, /\bKeyguardServiceDelegate\b/i)
  const delegateBeforeMonitor = delegate.split(/\bKeyguardStateMonitor\b/i, 1)[0] ?? delegate
  const delegateEvidence = collectBooleanEvidence(delegateBeforeMonitor, [
    {
      label: 'KeyguardServiceDelegate.showing',
      pattern: /(?:^|\n)\s*showing\s*[:=]\s*(true|false)\b/gim,
    },
  ])
  if (delegateEvidence.length > 0) return resolveEvidence(delegateEvidence)

  const directEvidence = collectBooleanEvidence(windowPolicy, [
    { label: 'mKeyguardShowing', pattern: /\bmKeyguardShowing\s*[:=]\s*(true|false)\b/gi },
    { label: 'mShowingLockscreen', pattern: /\bmShowingLockscreen\s*[:=]\s*(true|false)\b/gi },
  ])
  if (directEvidence.length > 0) return resolveEvidence(directEvidence)

  return resolveEvidence(collectBooleanEvidence(windowPolicy, [
    {
      label: 'showingAndNotOccluded',
      pattern: /\bshowingAndNotOccluded\s*[:=]\s*(true|false)\b/gi,
    },
  ]))
}

function parseSecureEvidence(windowPolicy: string): EvidenceResolution {
  const stateMonitor = indentedSection(windowPolicy, /\bKeyguardStateMonitor\b/i)
  const stateMonitorEvidence = collectBooleanEvidence(stateMonitor, [
    { label: 'KeyguardStateMonitor.mSecure', pattern: /\bmSecure\s*[:=]\s*(true|false)\b/gi },
    { label: 'KeyguardStateMonitor.mSimSecure', pattern: /\bmSimSecure\s*[:=]\s*(true|false)\b/gi },
  ])
  if (stateMonitorEvidence.some((item) => item.label.startsWith('KeyguardStateMonitor.mSecure='))) {
    return resolveEvidence(stateMonitorEvidence.filter(
      (item) => item.label.startsWith('KeyguardStateMonitor.mSecure='),
    ))
  }

  const delegate = indentedSection(windowPolicy, /\bKeyguardServiceDelegate\b/i)
  const delegateBeforeMonitor = delegate.split(/\bKeyguardStateMonitor\b/i, 1)[0] ?? delegate
  const delegateEvidence = collectBooleanEvidence(delegateBeforeMonitor, [
    {
      label: 'KeyguardServiceDelegate.secure',
      pattern: /(?:^|\n)\s*secure\s*[:=]\s*(true|false)\b/gim,
    },
  ])
  if (delegateEvidence.length > 0) return resolveEvidence(delegateEvidence)

  return resolveEvidence(collectBooleanEvidence(windowPolicy, [
    { label: 'isKeyguardSecure', pattern: /\bisKeyguardSecure\s*[:=]\s*(true|false)\b/gi },
    { label: 'mKeyguardSecure', pattern: /\bmKeyguardSecure\s*[:=]\s*(true|false)\b/gi },
    { label: 'mSecure', pattern: /\bmSecure\s*[:=]\s*(true|false)\b/gi },
  ]))
}

function boundedSummary(parts: string[]) {
  const summary = parts.join('; ')
  return summary.length <= 800 ? summary : `${summary.slice(0, 797)}...`
}

export function classifyDeviceReadinessSnapshot(snapshot: {
  power: string
  windowPolicy: string
}): DeviceReadinessObservation {
  const power = parsePowerEvidence(snapshot.power, snapshot.windowPolicy)
  const showing = firstResolvedShowingEvidence(snapshot.windowPolicy)
  const secure = parseSecureEvidence(snapshot.windowPolicy)
  const summary = boundedSummary([
    `power=${power.value}[${power.evidence.join('|')}]`,
    `keyguardShowing=${showing.value}[${showing.evidence.join('|')}]`,
    `secure=${secure.value}[${secure.evidence.join('|')}]`,
  ])

  if (showing.value === true && secure.value === true) {
    return { condition: 'secure_locked', summary }
  }
  if (power.value === 'unknown' || showing.value === 'unknown') {
    return { condition: 'unknown', summary }
  }
  if (power.value === false) return { condition: 'sleeping', summary }
  if (showing.value === true) return { condition: 'keyguard', summary }
  return { condition: 'ready', summary }
}

export class AndroidDeviceReadiness {
  private readonly now: () => number
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly timeoutMs: number
  private readonly pollIntervalMs: number
  private readonly inspectionTimeoutMs: number

  constructor(
    private readonly device: AndroidPreparationDevice,
    options: ReadinessRuntimeOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.wait = options.delay ?? abortableDelay
    this.timeoutMs = options.timeoutMs ?? 3_000
    this.pollIntervalMs = options.pollIntervalMs ?? 250
    this.inspectionTimeoutMs = options.inspectionTimeoutMs ?? 10_000
  }

  async prepare(signal: AbortSignal): Promise<DeviceReadinessObservation> {
    const status = await this.device.connectionStatus()
    if (status === 'unauthorized') {
      throw new TaskExecutionError('设备尚未授权此电脑，请在手机上允许 USB 调试授权。', 'DEVICE_UNAUTHORIZED')
    }
    if (status !== 'online') {
      throw new TaskExecutionError('设备当前不在线，无法执行 Android 应用准备。', 'DEVICE_OFFLINE')
    }

    let observation = await this.observe(signal)
    this.throwIfSecureLocked(observation)
    if (observation.condition === 'ready') return observation

    let inputWakeError: unknown
    let powerWakeError: unknown
    try {
      await this.device.run(
        ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
        signal,
        this.inspectionTimeoutMs,
        'DEVICE_WAKE_FAILED',
      )
    } catch (error) {
      inputWakeError = error
    }

    if (!inputWakeError) {
      observation = await this.observe(signal)
      this.throwIfSecureLocked(observation)
    }
    if (inputWakeError || observation.condition === 'sleeping') {
      try {
        await this.device.run(
          ['shell', 'cmd', 'power', 'wakeup', '0'],
          signal,
          this.inspectionTimeoutMs,
          'DEVICE_WAKE_FAILED',
        )
      } catch (error) {
        powerWakeError = error
      }
    }

    if (inputWakeError && powerWakeError) {
      const inputDetail = isInputInjectionDenied(inputWakeError)
        ? 'input injection denied'
        : this.errorSummary(inputWakeError)
      throw new TaskExecutionError(
        `设备唤醒失败：KEYCODE_WAKEUP=${inputDetail}；PowerManager=${this.errorSummary(powerWakeError)}`,
        'DEVICE_WAKE_FAILED',
      )
    }

    await this.device.run(
      ['shell', 'wm', 'dismiss-keyguard'],
      signal,
      this.inspectionTimeoutMs,
      'DEVICE_LOCKED',
    ).catch(() => undefined)
    await this.device.run(
      ['shell', 'input', 'keyevent', 'KEYCODE_MENU'],
      signal,
      this.inspectionTimeoutMs,
      'DEVICE_WAKE_FAILED',
    ).catch(() => undefined)

    const startedAt = this.now()
    while (this.now() - startedAt < this.timeoutMs) {
      await this.wait(
        Math.min(this.pollIntervalMs, this.timeoutMs - (this.now() - startedAt)),
        signal,
      )
      observation = await this.observe(signal)
      this.throwIfSecureLocked(observation)
      if (observation.condition === 'ready') return observation
    }

    if (observation.condition === 'sleeping') {
      throw new TaskExecutionError(
        `设备唤醒后 ${this.timeoutMs}ms 内仍明确处于休眠状态：${observation.summary}`,
        'DEVICE_WAKE_FAILED',
      )
    }
    return observation
  }

  private async observe(signal: AbortSignal): Promise<DeviceReadinessObservation> {
    const deadline = Date.now() + this.inspectionTimeoutMs
    const remainingMs = () => Math.max(1, deadline - Date.now())
    const power = await this.device.run(
      ['shell', 'dumpsys', 'power'],
      signal,
      remainingMs(),
      'DEVICE_WAKE_FAILED',
    )
    const windowPolicy = await this.device.run(
      ['shell', 'dumpsys', 'window', 'policy'],
      signal,
      remainingMs(),
      'DEVICE_WAKE_FAILED',
    )
    return classifyDeviceReadinessSnapshot({
      power: power.stdout,
      windowPolicy: windowPolicy.stdout,
    })
  }

  private throwIfSecureLocked(observation: DeviceReadinessObservation) {
    if (observation.condition === 'secure_locked') {
      throw new TaskExecutionError(SECURE_LOCK_MESSAGE, 'DEVICE_LOCKED')
    }
  }

  private errorSummary(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return message.length <= 300 ? message : `${message.slice(0, 297)}...`
  }
}
