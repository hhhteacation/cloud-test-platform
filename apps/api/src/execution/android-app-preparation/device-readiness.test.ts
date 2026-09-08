import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { ProcessResult } from '../../process.js'
import { TaskExecutionError } from '../execution-errors.js'
import type { AndroidPreparationDevice } from './contracts.js'
import {
  AndroidDeviceReadiness,
  classifyDeviceReadinessSnapshot,
} from './device-readiness.js'

const fixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`./__fixtures__/device-readiness/${name}`, import.meta.url)),
  'utf8',
)

const snapshot = (name: string) => ({
  power: fixture(`${name}.power.txt`),
  windowPolicy: fixture(`${name}.policy.txt`),
})

const XIAOMI_INPUT_INJECTION_ERROR = new TaskExecutionError(
  `设备=network-endpoint，操作=shell input keyevent KEYCODE_WAKEUP，退出码=255：Exception occurred while executing 'keyevent': java.lang.SecurityException: Injecting input events requires the caller to have the INJECT_EVENTS permission. at com.android.server.input.InputManagerService.injectInputEventToTarget(InputManagerService.java:1103)`,
  'DEVICE_WAKE_FAILED',
)

function clock() {
  let elapsed = 0
  return {
    now: () => elapsed,
    delay: async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) throw new DOMException('任务已取消', 'AbortError')
      elapsed += ms
    },
    elapsed: () => elapsed,
  }
}

class ReadinessFakeDevice implements AndroidPreparationDevice {
  readonly calls: string[][] = []
  readonly connectionStatusSignals: Array<AbortSignal | undefined> = []
  private inspection = 0

  constructor(
    private readonly snapshots: Array<{ power: string; windowPolicy: string }>,
    private readonly options: {
      status?: 'online' | 'offline' | 'unauthorized'
      inputWakeError?: TaskExecutionError
      powerWakeError?: TaskExecutionError
    } = {},
  ) {}

  async connectionStatus(signal?: AbortSignal) {
    this.connectionStatusSignals.push(signal)
    return this.options.status ?? 'online'
  }
  async isPackageInstalled() { return true }

  async run(args: string[]): Promise<ProcessResult> {
    this.calls.push(args)
    const command = args.join(' ')
    const current = this.snapshots[Math.min(this.inspection, this.snapshots.length - 1)]!
    if (command === 'shell dumpsys power') {
      return { code: 0, stdout: current.power, stderr: '' }
    }
    if (command === 'shell dumpsys window policy') {
      this.inspection += 1
      return { code: 0, stdout: current.windowPolicy, stderr: '' }
    }
    if (command === 'shell input keyevent KEYCODE_WAKEUP' && this.options.inputWakeError) {
      throw this.options.inputWakeError
    }
    if (command === 'shell cmd power wakeup 0' && this.options.powerWakeError) {
      throw this.options.powerWakeError
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

const sleeping = {
  power: 'mWakefulness=Asleep\nmInteractive=false\nDisplay Power: state=OFF',
  windowPolicy: 'mKeyguardShowing=false\nisKeyguardSecure=false',
}
const ready = {
  power: 'mWakefulness=Awake\nmInteractive=true\nDisplay Power: state=ON',
  windowPolicy: 'mKeyguardShowing=false\nisKeyguardSecure=false',
}
const keyguard = {
  power: 'mWakefulness=Awake\nmInteractive=true',
  windowPolicy: 'mKeyguardShowing=true\nisKeyguardSecure=false',
}
const unknown = {
  power: 'vendorPowerMode=active',
  windowPolicy: 'vendorLockState=clear',
}

function createReadiness(device: AndroidPreparationDevice) {
  const timer = clock()
  return {
    readiness: new AndroidDeviceReadiness(device, {
      now: timer.now,
      delay: timer.delay,
      timeoutMs: 3_000,
      pollIntervalMs: 250,
    }),
    timer,
  }
}

describe('device readiness snapshot classification', () => {
  it.each([
    'huawei-ready',
    'vivo-ready',
    'oppo-ready',
    'xiaomi-ready',
    'aosp-ready',
  ])('classifies the anonymized %s OEM fixture as ready', (name) => {
    expect(classifyDeviceReadinessSnapshot(snapshot(name))).toMatchObject({ condition: 'ready' })
  })

  it('lets authoritative Huawei hidden fields override showingAndNotOccluded=true', () => {
    const observation = classifyDeviceReadinessSnapshot(snapshot('huawei-ready'))
    expect(observation.condition).toBe('ready')
    expect(observation.summary).toContain('KeyguardStateMonitor.mIsShowing=false')
    expect(observation.summary).not.toContain('DEVICE_LOCKED')
  })

  it('recognizes vivo mIsInteractive: true and policy awake variants', () => {
    const observation = classifyDeviceReadinessSnapshot(snapshot('vivo-ready'))
    expect(observation.condition).toBe('ready')
    expect(observation.summary).toContain('mIsInteractive=true')
  })

  it('returns unknown for conflicting or unsupported power evidence', () => {
    expect(classifyDeviceReadinessSnapshot({
      power: 'mWakefulness=Awake\nmInteractive=false',
      windowPolicy: 'mKeyguardShowing=false',
    })).toMatchObject({ condition: 'unknown', summary: expect.stringContaining('conflict') })
    expect(classifyDeviceReadinessSnapshot(unknown)).toMatchObject({ condition: 'unknown' })
  })

  it('keeps keyguard fields scoped to their owning dumpsys sections', () => {
    expect(classifyDeviceReadinessSnapshot({
      power: ready.power,
      windowPolicy: `
KeyguardServiceDelegate
  showing=false
  secure=false
  KeyguardStateMonitor
    mIsShowing=false
OtherVendorState
  showing=true
  secure=true
  mIsShowing=true
`,
    })).toMatchObject({ condition: 'ready' })
  })

  it('requires explicit showing and secure evidence for secure_locked', () => {
    expect(classifyDeviceReadinessSnapshot({
      power: ready.power,
      windowPolicy: 'KeyguardStateMonitor\n  mIsShowing=true\n  mSecure=true',
    })).toMatchObject({ condition: 'secure_locked' })

    expect(classifyDeviceReadinessSnapshot({
      power: ready.power,
      windowPolicy: 'KeyguardServiceDelegate\n  showing=false\n  secure=true',
    })).toMatchObject({ condition: 'ready' })
  })
})

describe('AndroidDeviceReadiness Attempt cancellation', () => {
  it('propagates the Attempt signal to the initial connection observation', async () => {
    const device = new ReadinessFakeDevice([ready])
    const { readiness } = createReadiness(device)
    const controller = new AbortController()

    await readiness.prepare(controller.signal)

    expect(device.connectionStatusSignals).toEqual([controller.signal])
  })
})

describe('AndroidDeviceReadiness.prepare', () => {
  it('checks only connection and snapshots when already ready', async () => {
    const device = new ReadinessFakeDevice([ready])
    const { readiness } = createReadiness(device)

    await expect(readiness.prepare(new AbortController().signal)).resolves.toMatchObject({
      condition: 'ready',
    })
    expect(device.calls).toEqual([
      ['shell', 'dumpsys', 'power'],
      ['shell', 'dumpsys', 'window', 'policy'],
    ])
  })

  it('polls a sleeping device until it converges instead of relying on 350ms', async () => {
    const device = new ReadinessFakeDevice([sleeping, sleeping, sleeping, ready])
    const { readiness, timer } = createReadiness(device)

    await expect(readiness.prepare(new AbortController().signal)).resolves.toMatchObject({
      condition: 'ready',
    })
    expect(device.calls).toContainEqual(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
    expect(device.calls).toContainEqual(['shell', 'cmd', 'power', 'wakeup', '0'])
    expect(device.calls).toContainEqual(['shell', 'wm', 'dismiss-keyguard'])
    expect(device.calls).toContainEqual(['shell', 'input', 'keyevent', 'KEYCODE_MENU'])
    expect(timer.elapsed()).toBe(500)
  })

  it('uses PowerManager fallback for input injection denial without Xiaomi-specific failure', async () => {
    const device = new ReadinessFakeDevice([sleeping, ready], {
      inputWakeError: XIAOMI_INPUT_INJECTION_ERROR,
    })
    const { readiness } = createReadiness(device)

    await expect(readiness.prepare(new AbortController().signal)).resolves.toMatchObject({
      condition: 'ready',
    })
    expect(device.calls).toContainEqual(['shell', 'cmd', 'power', 'wakeup', '0'])
  })

  it('returns DEVICE_WAKE_FAILED rather than input automation denial when both wake paths fail', async () => {
    const device = new ReadinessFakeDevice([sleeping], {
      inputWakeError: XIAOMI_INPUT_INJECTION_ERROR,
      powerWakeError: new TaskExecutionError('PowerManager unavailable', 'DEVICE_WAKE_FAILED'),
    })
    const { readiness } = createReadiness(device)

    await expect(readiness.prepare(new AbortController().signal)).rejects.toMatchObject({
      code: 'DEVICE_WAKE_FAILED',
      message: expect.not.stringContaining('USB 调试（安全设置）'),
    })
  })

  it('returns DEVICE_WAKE_FAILED after timeout only when the device remains explicitly sleeping', async () => {
    const device = new ReadinessFakeDevice([sleeping])
    const { readiness, timer } = createReadiness(device)

    await expect(readiness.prepare(new AbortController().signal)).rejects.toMatchObject({
      code: 'DEVICE_WAKE_FAILED',
    })
    expect(timer.elapsed()).toBe(3_000)
  })

  it.each([
    ['keyguard', keyguard],
    ['unknown', unknown],
  ] as const)('returns %s after timeout so callers can continue with diagnostics', async (condition, state) => {
    const device = new ReadinessFakeDevice([state])
    const { readiness, timer } = createReadiness(device)

    await expect(readiness.prepare(new AbortController().signal)).resolves.toMatchObject({ condition })
    expect(timer.elapsed()).toBe(3_000)
  })

  it('rejects an explicit secure lock without trying to bypass it', async () => {
    const device = new ReadinessFakeDevice([{
      power: ready.power,
      windowPolicy: 'mKeyguardShowing=true\nisKeyguardSecure=true',
    }])
    const { readiness } = createReadiness(device)

    await expect(readiness.prepare(new AbortController().signal)).rejects.toMatchObject({
      code: 'DEVICE_LOCKED',
    })
    expect(device.calls).not.toContainEqual(['shell', 'wm', 'dismiss-keyguard'])
  })

  it.each([
    ['unauthorized', 'DEVICE_UNAUTHORIZED'],
    ['offline', 'DEVICE_OFFLINE'],
  ] as const)('preserves %s connection errors', async (status, code) => {
    const device = new ReadinessFakeDevice([ready], { status })
    const { readiness } = createReadiness(device)

    await expect(readiness.prepare(new AbortController().signal)).rejects.toMatchObject({ code })
    expect(device.calls).toEqual([])
  })
})
