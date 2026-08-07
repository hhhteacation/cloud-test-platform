import { describe, expect, it, vi } from 'vitest'

import { TaskExecutionError } from './execution-errors.js'
import {
  buildMorphoStartupProbeArguments,
  isMorphoBatchServiceRunning,
  parseMorphoStartupProbe,
  waitForMorphoStartup,
} from './morpho-startup.js'

function clock() {
  let elapsed = 0
  return {
    now: () => elapsed,
    delay: async (ms: number) => { elapsed += ms },
    elapsed: () => elapsed,
  }
}

const observation = (condition: 'ready' | 'sleeping' | 'keyguard' | 'secure_locked' | 'unknown') => ({
  condition,
  summary: `summary:${condition}`,
})

const readyState = {
  processRunning: true,
  serviceRunning: false,
  readiness: observation('ready'),
}

describe('Morpho startup handshake', () => {
  it('uses one bounded shell probe and the shared readiness classifier', () => {
    const args = buildMorphoStartupProbeArguments('com.morphoinc.videopostprocessor')
    expect(args.slice(0, 3)).toEqual(['shell', 'sh', '-c'])
    expect(args.at(-1)).toBe('com.morphoinc.videopostprocessor')
    expect(args.join(' ')).toContain('dumpsys activity services "$1"')
    expect(args.join(' ')).toContain('pidof "$1"')

    expect(parseMorphoStartupProbe(`
__MORPHO_SERVICES__
* ServiceRecord{123 u0 com.morphoinc.videopostprocessor/.BatchProcessService}
__MORPHO_PROCESS__=1234
__MORPHO_POWER__
mWakefulness=Awake
mInteractive=true
__MORPHO_POLICY__
mKeyguardShowing=false
`)).toEqual({
      processRunning: true,
      serviceRunning: true,
      readiness: expect.objectContaining({ condition: 'ready' }),
    })
  })

  it('rejects incomplete startup probe output instead of guessing device state', () => {
    expect(() => parseMorphoStartupProbe('__MORPHO_SERVICES__\nno service'))
      .toThrow('Morpho 启动状态探测输出不完整')
  })

  it('matches only the exact Morpho BatchProcessService component', () => {
    expect(isMorphoBatchServiceRunning(`
      * ServiceRecord{123 u0 com.morphoinc.videopostprocessor/.BatchProcessService}
    `)).toBe(true)
    expect(isMorphoBatchServiceRunning(`
      * ServiceRecord{123 u0 com.morphoinc.videopostprocessor/com.morphoinc.videopostprocessor.BatchProcessService}
    `)).toBe(true)
    expect(isMorphoBatchServiceRunning('com.example.other/.BatchProcessService')).toBe(false)
    expect(isMorphoBatchServiceRunning(
      'com.morphoinc.videopostprocessor/.MainActivity',
    )).toBe(false)
  })

  it.each([5_000, 12_000])('accepts a business log appearing after %sms', async (appearsAt) => {
    const timer = clock()
    await expect(waitForMorphoStartup({
      signal: new AbortController().signal,
      hasBusinessLog: () => timer.elapsed() >= appearsAt,
      getLogcatFailure: () => undefined,
      inspect: async () => readyState,
      now: timer.now,
      delay: timer.delay,
    })).resolves.toBe('MORPHO_LOG')
    expect(timer.elapsed()).toBe(appearsAt)
  })

  it('returns immediately when a Morpho business log is observed', async () => {
    const timer = clock()
    const inspect = vi.fn(async () => readyState)
    await expect(waitForMorphoStartup({
      signal: new AbortController().signal,
      hasBusinessLog: () => true,
      getLogcatFailure: () => undefined,
      inspect,
      now: timer.now,
      delay: timer.delay,
    })).resolves.toBe('MORPHO_LOG')
    expect(timer.elapsed()).toBe(0)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('accepts the exact BatchProcessService before other failure evidence', async () => {
    const timer = clock()
    await expect(waitForMorphoStartup({
      signal: new AbortController().signal,
      hasBusinessLog: () => false,
      getLogcatFailure: () => new TaskExecutionError('logcat exited', 'LOGCAT_START_FAILED'),
      inspect: async () => ({
        processRunning: false,
        serviceRunning: true,
        readiness: observation('secure_locked'),
      }),
      now: timer.now,
      delay: timer.delay,
    })).resolves.toBe('BATCH_SERVICE')
    expect(timer.elapsed()).toBe(3_000)
  })

  it.each([
    ['secure_locked', 'DEVICE_LOCKED'],
    ['sleeping', 'DEVICE_WAKE_FAILED'],
  ] as const)('maps %s to %s', async (condition, code) => {
    const timer = clock()
    await expect(waitForMorphoStartup({
      signal: new AbortController().signal,
      hasBusinessLog: () => false,
      getLogcatFailure: () => undefined,
      inspect: async () => ({ ...readyState, readiness: observation(condition) }),
      now: timer.now,
      delay: timer.delay,
    })).rejects.toMatchObject({ code })
    expect(timer.elapsed()).toBe(3_000)
  })

  it.each(['keyguard', 'unknown'] as const)('continues polling through %s until business evidence appears', async (condition) => {
    const timer = clock()
    await expect(waitForMorphoStartup({
      signal: new AbortController().signal,
      hasBusinessLog: () => timer.elapsed() >= 5_000,
      getLogcatFailure: () => undefined,
      inspect: async () => ({ ...readyState, readiness: observation(condition) }),
      now: timer.now,
      delay: timer.delay,
    })).resolves.toBe('MORPHO_LOG')
    expect(timer.elapsed()).toBe(5_000)
  })

  it('keeps process exit and logcat failures precise', async () => {
    for (const scenario of [
      { state: { ...readyState, processRunning: false }, logcat: undefined, code: 'APP_CRASHED' },
      {
        state: readyState,
        logcat: new TaskExecutionError('logcat exited', 'LOGCAT_START_FAILED'),
        code: 'LOGCAT_START_FAILED',
      },
    ]) {
      const timer = clock()
      await expect(waitForMorphoStartup({
        signal: new AbortController().signal,
        hasBusinessLog: () => false,
        getLogcatFailure: () => scenario.logcat,
        inspect: async () => scenario.state,
        now: timer.now,
        delay: timer.delay,
      })).rejects.toMatchObject({ code: scenario.code })
      expect(timer.elapsed()).toBe(3_000)
    }
  })

  it('fails at the 15 second hard limit and includes the last readiness summary', async () => {
    const timer = clock()
    await expect(waitForMorphoStartup({
      signal: new AbortController().signal,
      hasBusinessLog: () => false,
      getLogcatFailure: () => undefined,
      inspect: async () => ({ ...readyState, readiness: observation('unknown') }),
      now: timer.now,
      delay: timer.delay,
    })).rejects.toMatchObject({
      code: 'SDK_START_FAILED',
      message: expect.stringContaining('最后设备状态=unknown；summary:unknown'),
    })
    expect(timer.elapsed()).toBe(15_000)
  })
})
