import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TaskExecutionError } from './execution-errors.js'
import {
  collectMorphoStartupInspection,
  isMorphoBatchServiceRunning,
  inspectMorphoStartupProbe,
  type MorphoStartupProbeResult,
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
  kind: 'complete' as const,
  processRunning: true,
  serviceRunning: false,
  readiness: observation('ready'),
}

const defaultProbe = {
  services: {
    code: 0,
    stdout: '* ServiceRecord{123 u0 com.morphoinc.videopostprocessor/.BatchProcessService}',
    stderr: '',
  },
  process: { code: 0, stdout: '1234\n', stderr: '' },
  power: { code: 0, stdout: 'mWakefulness=Awake\nmInteractive=true', stderr: '' },
  windowPolicy: { code: 0, stdout: 'mKeyguardShowing=false', stderr: '' },
} satisfies Record<string, MorphoStartupProbeResult>

function successfulProbe(overrides: Partial<typeof defaultProbe> = {}) {
  return { ...defaultProbe, ...overrides }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('Morpho startup observation', () => {
  it('collects scoped commands separately and records replayable Evidence metadata', async () => {
    const diagnosticsDirectory = await mkdtemp(path.join(tmpdir(), 'morpho-startup-'))
    temporaryDirectories.push(diagnosticsDirectory)
    const calls: string[][] = []
    const results = successfulProbe()

    const inspection = await collectMorphoStartupInspection({
      packageName: 'com.morphoinc.videopostprocessor',
      diagnosticsDirectory,
      attempt: 2,
      remainingMs: 10_000,
      signal: new AbortController().signal,
      runner: {
        async run(args, _signal, _timeoutMs, capture) {
          calls.push(args)
          const section = args.includes('pidof')
            ? 'process'
            : args.at(-1) === 'power'
              ? 'power'
              : args.at(-1) === 'policy'
                ? 'windowPolicy'
                : 'services'
          const result = results[section]
          await Promise.all([
            writeFile(capture.stdoutPath, result.stdout),
            writeFile(capture.stderrPath, result.stderr),
          ])
          return result
        },
      },
    })

    expect(inspection).toMatchObject({ kind: 'complete', serviceRunning: true })
    expect(calls).toEqual([
      [
        'shell',
        'dumpsys',
        'activity',
        'services',
        'com.morphoinc.videopostprocessor/.BatchProcessService',
      ],
      ['shell', 'pidof', 'com.morphoinc.videopostprocessor'],
      ['shell', 'dumpsys', 'power'],
      ['shell', 'dumpsys', 'window', 'policy'],
    ])
    expect(calls.flat()).not.toContain('grep')

    const metadata = JSON.parse(await readFile(
      path.join(diagnosticsDirectory, 'morpho-startup', 'probe-02-metadata.json'),
      'utf8',
    )) as { commands: Array<{ section: string; stdoutFile: string; durationMs: number }> }
    expect(metadata.commands.every((command) => command.durationMs >= 0)).toBe(true)
    expect(metadata.commands.map((command) => command.section)).toEqual([
      'services',
      'process',
      'power',
      'windowPolicy',
    ])
    await expect(readFile(
      path.join(diagnosticsDirectory, 'morpho-startup', metadata.commands[0]!.stdoutFile),
      'utf8',
    )).resolves.toContain('BatchProcessService')
  })

  it('uses the shared readiness classifier for a complete observation', () => {
    expect(inspectMorphoStartupProbe(successfulProbe())).toEqual({
      kind: 'complete',
      processRunning: true,
      serviceRunning: true,
      readiness: expect.objectContaining({ condition: 'ready' }),
    })
  })

  it('treats pidof exit code 1 as a valid stopped-process observation', () => {
    expect(inspectMorphoStartupProbe(successfulProbe({
      services: { code: 0, stdout: '', stderr: '' },
      process: { code: 1, stdout: '', stderr: '' },
    }))).toMatchObject({
      kind: 'complete',
      serviceRunning: false,
      processRunning: false,
    })
  })

  it('reports command failures without converting them to SDK business failure', () => {
    expect(inspectMorphoStartupProbe(successfulProbe({
      services: { code: 2, stdout: '', stderr: 'dumpsys failed' },
    }))).toMatchObject({
      kind: 'incomplete',
      reason: 'command_failed',
      missingSections: ['services'],
    })
  })


  it('classifies a timed-out probe command as incomplete observation', () => {
    expect(inspectMorphoStartupProbe(successfulProbe({
      services: { code: -1, stdout: '', stderr: 'command timed out' },
    }))).toMatchObject({
      kind: 'incomplete',
      reason: 'command_failed',
      missingSections: ['services'],
    })
  })

  it('classifies truncated output as incomplete while retaining positive service evidence', () => {
    expect(inspectMorphoStartupProbe(successfulProbe({
      power: {
        code: 0,
        stdout: 'partial power output',
        stderr: '',
        stdoutTruncated: true,
        stdoutBytes: 4 * 1024 * 1024,
      },
    }))).toMatchObject({
      kind: 'incomplete',
      reason: 'truncated',
      missingSections: ['power'],
      serviceRunning: true,
    })
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
})

describe('Morpho startup decision', () => {
  it('does not turn an incomplete probe into a terminal failure before the startup deadline', async () => {
    const timer = clock()
    const onIncompleteObservation = vi.fn()
    await expect(waitForMorphoStartup({
      signal: new AbortController().signal,
      hasBusinessLog: () => false,
      getLogcatFailure: () => undefined,
      inspect: async () => ({
        kind: 'incomplete' as const,
        reason: 'truncated' as const,
        missingSections: ['windowPolicy'] as const,
        summary: 'stdout truncated',
      }),
      onIncompleteObservation,
      now: timer.now,
      delay: timer.delay,
    })).rejects.toMatchObject({ code: 'STARTUP_OBSERVATION_INCOMPLETE' })
    expect(timer.elapsed()).toBe(15_000)
    expect(onIncompleteObservation).toHaveBeenCalled()
  })


  it('allows later business Logcat evidence to win after an incomplete probe', async () => {
    const timer = clock()
    await expect(waitForMorphoStartup({
      signal: new AbortController().signal,
      hasBusinessLog: () => timer.elapsed() >= 5_000,
      getLogcatFailure: () => undefined,
      inspect: async () => ({
        kind: 'incomplete' as const,
        reason: 'truncated' as const,
        missingSections: ['windowPolicy'] as const,
        summary: 'window policy truncated',
      }),
      now: timer.now,
      delay: timer.delay,
    })).resolves.toBe('MORPHO_LOG')
    expect(timer.elapsed()).toBe(5_000)
  })

  it('stops immediately when the task is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitForMorphoStartup({
      signal: controller.signal,
      hasBusinessLog: () => false,
      getLogcatFailure: () => undefined,
      inspect: async () => readyState,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('accepts positive BatchProcessService evidence even when another observation is incomplete', async () => {
    const timer = clock()
    await expect(waitForMorphoStartup({
      signal: new AbortController().signal,
      hasBusinessLog: () => false,
      getLogcatFailure: () => undefined,
      inspect: async () => ({
        kind: 'incomplete' as const,
        reason: 'truncated' as const,
        missingSections: ['power'] as const,
        serviceRunning: true as const,
        summary: 'power output truncated',
      }),
      now: timer.now,
      delay: timer.delay,
    })).resolves.toBe('BATCH_SERVICE')
    expect(timer.elapsed()).toBe(3_000)
  })

  it('does not let an old incomplete observation override later complete observations', async () => {
    const timer = clock()
    let inspections = 0
    await expect(waitForMorphoStartup({
      signal: new AbortController().signal,
      hasBusinessLog: () => false,
      getLogcatFailure: () => undefined,
      inspect: async () => {
        inspections += 1
        return inspections === 1
          ? {
              kind: 'incomplete' as const,
              reason: 'empty_output' as const,
              missingSections: ['power'] as const,
              summary: 'power output empty',
            }
          : { ...readyState, readiness: observation('unknown') }
      },
      now: timer.now,
      delay: timer.delay,
    })).rejects.toMatchObject({ code: 'SDK_START_FAILED' })
    expect(timer.elapsed()).toBe(15_000)
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
        kind: 'complete' as const,
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
