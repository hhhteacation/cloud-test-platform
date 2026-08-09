import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildExecutionPaths,
  findApkExecutionProtocol,
} from '../apk-protocols.js'
import type { ProcessResult } from '../process.js'
import { CarrierProtocolExecutor } from './carrier-protocol-executor.js'
import type { AdbObservation } from './adb-client.js'
import { TaskExecutionError } from './execution-errors.js'
import type {
  ProtocolExecutionContext,
  ProtocolExecutionDevice,
  ProtocolExecutionReporter,
  ProtocolExecutionStreams,
} from './protocol-executor.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function processResult(code = 0, stdout = '', stderr = ''): ProcessResult {
  return { code, stdout, stderr }
}

function present<T>(value: T): AdbObservation<T> {
  return { kind: 'present', value, result: processResult(0, String(value)) }
}

function absent<T>(): AdbObservation<T> {
  return { kind: 'absent', result: processResult(1, '', 'No such file or directory') }
}

interface CarrierScenario {
  resultContent?: string
  resultObservation?: AdbObservation<number>
  outputObservation?: AdbObservation<number>
  packageRunning?: AdbObservation<boolean>
  cancelled?: boolean
  logcatStartError?: Error
  cleanupError?: Error
}

class CarrierDevice implements ProtocolExecutionDevice {
  readonly commands: string[][] = []

  constructor(
    private readonly inputSize: number,
    private readonly scenario: CarrierScenario,
  ) {}

  async run(args: string[]): Promise<ProcessResult> {
    this.commands.push(args)
    if (args.includes('force-stop') && this.scenario.cleanupError) {
      throw this.scenario.cleanupError
    }
    if (args[0] === 'pull') {
      const remotePath = args[1]!
      const localPath = args[2]!
      await writeFile(
        localPath,
        remotePath.endsWith('result.json')
          ? this.scenario.resultContent ?? JSON.stringify({ taskId: 'task-1', status: 'passed' })
          : 'output-video',
      )
    }
    return processResult()
  }

  async observe(): Promise<ProcessResult> {
    return processResult()
  }

  async stat(remotePath: string): Promise<AdbObservation<number>> {
    if (remotePath.endsWith('/input/input.mp4')) return present(this.inputSize)
    if (remotePath.endsWith('/result/result.json')) {
      return this.scenario.resultObservation ?? present(1)
    }
    if (remotePath.endsWith('/output/output.mp4')) {
      return this.scenario.outputObservation ?? present(12)
    }
    return absent()
  }

  async exists(): Promise<AdbObservation<boolean>> {
    return absent()
  }

  async isPackageRunning(): Promise<AdbObservation<boolean>> {
    return this.scenario.packageRunning ?? present(true)
  }
}

async function createHarness(scenario: CarrierScenario = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'carrier-protocol-executor-'))
  roots.push(root)
  const inputPath = path.join(root, 'input.mp4')
  await writeFile(inputPath, 'input-video')
  const protocol = findApkExecutionProtocol('com.sdktest.platform')!
  const paths = buildExecutionPaths(protocol, { taskId: 'task-1' })
  const device = new CarrierDevice(Buffer.byteLength('input-video'), scenario)
  const logs: Array<{ message: string; level: string }> = []
  const checks: Array<{ key: string; status: string }> = []
  const reporter: ProtocolExecutionReporter = {
    update: vi.fn(),
    addLog: (message, level = 'info') => logs.push({ message, level }),
    setProcessingProgress: vi.fn(),
    upsertCheck: (check) => checks.push({ key: check.key, status: check.status }),
    isCancelled: () => Boolean(scenario.cancelled),
  }
  const streams: ProtocolExecutionStreams = {
    async startLogcat() {
      if (scenario.logcatStartError) throw scenario.logcatStartError
      return async () => undefined
    },
    async captureLogcatSnapshot() { return undefined },
  }
  let now = 0
  const executor = new CarrierProtocolExecutor({
    device,
    streams,
    pollIntervalMs: 10,
    maxLogcatBytes: 1_024,
    minFreeDiskBytes: 1,
    now: () => now,
    delay: async (ms, signal) => {
      if (signal.aborted) throw new DOMException('任务已取消', 'AbortError')
      now += ms
    },
  })
  const context: ProtocolExecutionContext = {
    executionKey: 'run-1',
    taskId: 'task-1',
    protocol,
    paths,
    input: { localPath: inputPath, originalName: 'input.mp4' },
    local: {
      runDirectory: root,
      resultPath: path.join(root, 'result.json'),
      outputPath: path.join(root, 'output.mp4'),
      logcatPath: path.join(root, 'logcat.txt'),
      diagnosticsDirectory: path.join(root, 'diagnostics'),
    },
    configuredTimeoutSeconds: 1,
    signal: new AbortController().signal,
    reporter,
  }
  return { context, device, executor, logs, checks }
}

describe('CarrierProtocolExecutor seam', () => {
  it('uses result.json and output as conclusive evidence when Logcat cannot start', async () => {
    const harness = await createHarness({ logcatStartError: new Error('logcat unavailable') })

    const result = await harness.executor.execute(harness.context)

    expect(result).toMatchObject({
      inputSizeBytes: 11,
      outputSizeBytes: 12,
      remoteOutputFile: harness.context.paths.remoteOutputFile,
      logcatWarning: expect.stringContaining('LOGCAT_START_FAILED'),
    })
    expect(await readFile(harness.context.local.outputPath, 'utf8')).toBe('output-video')
    expect(harness.logs).toContainEqual({
      message: expect.stringContaining('LOGCAT_START_FAILED'),
      level: 'warning',
    })
    expect(harness.device.commands).toEqual(expect.arrayContaining([
      ['shell', 'am', 'force-stop', harness.context.protocol.packageName],
      ['shell', 'rm', '-rf', harness.context.paths.remoteTaskRoot],
    ]))
  })

  it.each([
    ['', 'empty'],
    ['{', 'malformed'],
    ['[]', 'array'],
    ['{}', 'missing fields'],
    [JSON.stringify({ taskId: 'task-1', status: 'running' }), 'non-terminal status'],
  ])('rejects invalid result.json content (%s)', async (resultContent) => {
    const harness = await createHarness({ resultContent })
    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      code: 'RESULT_INVALID',
    })
  })

  it('rejects a result for another task', async () => {
    const harness = await createHarness({
      resultContent: JSON.stringify({ taskId: 'other-task', status: 'passed' }),
    })
    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      code: 'RESULT_TASK_MISMATCH',
    })
  })

  it('preserves a business failure returned by the carrier', async () => {
    const harness = await createHarness({
      resultContent: JSON.stringify({
        taskId: 'task-1',
        status: 'failed',
        failureCode: 'VENDOR_PROCESSING_FAILED',
        failureMessage: 'vendor rejected input',
      }),
    })
    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      code: 'VENDOR_PROCESSING_FAILED',
      message: 'vendor rejected input',
    })
  })

  it.each([
    [absent<number>(), 'OUTPUT_MISSING'],
    [present(0), 'OUTPUT_EMPTY'],
    [{
      kind: 'failed',
      error: new TaskExecutionError('permission denied', 'ADB_OBSERVATION_FAILED'),
      result: processResult(2, '', 'permission denied'),
    } satisfies AdbObservation<number>, 'ADB_OBSERVATION_FAILED'],
  ])('keeps output observation semantics distinct', async (outputObservation, code) => {
    const harness = await createHarness({ outputObservation })
    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({ code })
  })

  it('stops polling on cancellation and still owns cleanup', async () => {
    const harness = await createHarness({ cancelled: true, resultObservation: absent() })
    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(harness.device.commands).toEqual(expect.arrayContaining([
      ['shell', 'am', 'force-stop', harness.context.protocol.packageName],
      ['shell', 'rm', '-rf', harness.context.paths.remoteTaskRoot],
    ]))
  })

  it('does not let cleanup failure replace the original business failure', async () => {
    const harness = await createHarness({
      resultContent: JSON.stringify({
        taskId: 'task-1',
        status: 'failed',
        failureCode: 'VENDOR_FAILED',
        failureMessage: 'original failure',
      }),
      cleanupError: new Error('force-stop denied'),
    })

    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      code: 'VENDOR_FAILED',
      message: 'original failure',
    })
    expect(harness.logs).toContainEqual({
      message: expect.stringContaining('force-stop denied'),
      level: 'warning',
    })
  })
})
