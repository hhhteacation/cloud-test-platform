import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildExecutionPaths,
  findApkExecutionProtocol,
} from '../apk-protocols.js'
import type { ProcessResult } from '../process.js'
import type { AdbObservation } from './adb-client.js'
import { TaskExecutionError } from './execution-errors.js'
import { MorphoProtocolExecutor } from './morpho-protocol-executor.js'
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

type ProbeSection = 'services' | 'process' | 'power' | 'windowPolicy'

interface MorphoScenario {
  serviceRunning?: boolean
  processRunning?: boolean
  truncatedSection?: ProbeSection
  commandFailureSection?: ProbeSection
  observationFailureSection?: ProbeSection
  launchLines?: string[]
  logcatStartError?: Error
  markerObservation?: AdbObservation<boolean>
  outputObservation?: AdbObservation<number>
  cancelled?: boolean
  cleanupError?: Error
  /** File name → content written into a local companion-asset dir; 'missing' points at a non-existent dir. */
  companionAssets?: Record<string, string> | 'missing'
}

function probeSection(args: readonly string[]): ProbeSection | undefined {
  if (args.includes('services')) return 'services'
  if (args.includes('pidof')) return 'process'
  if (args.includes('power')) return 'power'
  if (args.includes('policy')) return 'windowPolicy'
  return undefined
}

class MorphoDevice implements ProtocolExecutionDevice {
  readonly commands: string[][] = []
  readonly observations: string[][] = []
  onLaunch?: () => void

  constructor(
    private readonly inputSize: number,
    private readonly scenario: MorphoScenario,
  ) {}

  async run(args: string[]): Promise<ProcessResult> {
    this.commands.push(args)
    if (args.includes('force-stop') && this.scenario.cleanupError) {
      throw this.scenario.cleanupError
    }
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start') {
      this.onLaunch?.()
    }
    if (args[0] === 'pull') await writeFile(args[2]!, 'output-video')
    return processResult()
  }

  async observe(
    args: string[],
    _signal: AbortSignal,
    _timeoutMs?: number,
    capture?: { captureStdoutPath?: string; captureStderrPath?: string },
  ): Promise<ProcessResult> {
    this.observations.push(args)
    const section = probeSection(args)
    if (section && this.scenario.observationFailureSection === section) {
      throw new TaskExecutionError(
        `${section} observation failed`,
        'ADB_OBSERVATION_FAILED',
      )
    }

    let result: ProcessResult
    if (section && this.scenario.commandFailureSection === section) {
      result = processResult(2, '', 'permission denied')
    } else if (section === 'services') {
      result = processResult(
        0,
        this.scenario.serviceRunning === false
          ? ''
          : 'ServiceRecord com.morphoinc.videopostprocessor/.BatchProcessService',
      )
    } else if (section === 'process') {
      result = this.scenario.processRunning === false
        ? processResult(1, '')
        : processResult(0, '1234')
    } else if (section === 'power') {
      result = processResult(0, 'mWakefulness: Awake\nmInteractive=true')
    } else if (section === 'windowPolicy') {
      result = processResult(0, 'interactiveState=INTERACTIVE_STATE_AWAKE')
    } else {
      result = processResult()
    }

    if (section && this.scenario.truncatedSection === section) {
      result = { ...result, stdoutTruncated: true, stdoutBytes: 4_096 }
    }
    if (capture?.captureStdoutPath) await writeFile(capture.captureStdoutPath, result.stdout)
    if (capture?.captureStderrPath) await writeFile(capture.captureStderrPath, result.stderr)
    return result
  }

  async stat(remotePath: string): Promise<AdbObservation<number>> {
    if (remotePath.endsWith('/input.mp4')) return present(this.inputSize)
    if (remotePath.endsWith('.mp4')) {
      return this.scenario.outputObservation ?? present(12)
    }
    return absent()
  }

  async exists(remotePath: string): Promise<AdbObservation<boolean>> {
    if (remotePath.endsWith('.batch_processing_complete')) {
      return this.scenario.markerObservation ?? present(true)
    }
    return absent()
  }

  async isPackageRunning(): Promise<AdbObservation<boolean>> {
    return present(this.scenario.processRunning !== false)
  }
}

async function createHarness(scenario: MorphoScenario = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'morpho-protocol-executor-'))
  roots.push(root)
  const inputPath = path.join(root, 'input.mp4')
  await writeFile(inputPath, 'input-video')
  let companionAssetsDir: string | undefined
  if (scenario.companionAssets === 'missing') {
    companionAssetsDir = path.join(root, 'missing-assets')
  } else if (scenario.companionAssets) {
    companionAssetsDir = path.join(root, 'companion-assets')
    await mkdir(companionAssetsDir)
    for (const [name, content] of Object.entries(scenario.companionAssets)) {
      await writeFile(path.join(companionAssetsDir, name), content)
    }
  }
  const protocol = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
  const paths = buildExecutionPaths(protocol, {
    taskId: 'task-1',
    manufacturer: 'OnePlus',
    model: 'PKR110',
    inputFileName: 'input.mp4',
  })
  const device = new MorphoDevice(Buffer.byteLength('input-video'), scenario)
  const logs: Array<{ message: string; level: string }> = []
  const checks: Array<{ key: string; status: string }> = []
  const reporter: ProtocolExecutionReporter = {
    update: vi.fn(),
    addLog: (message, level = 'info') => logs.push({ message, level }),
    setProcessingProgress: vi.fn(),
    upsertCheck: (check) => checks.push({ key: check.key, status: check.status }),
    isCancelled: () => Boolean(scenario.cancelled),
  }
  let lineHandler: (line: string) => void = () => undefined
  const captureFailureLogcat = vi.fn(async () => undefined)
  const streams: ProtocolExecutionStreams = {
    async startLogcat(_key, _target, _signal, _tags, onLine) {
      if (scenario.logcatStartError) throw scenario.logcatStartError
      lineHandler = onLine
      return async () => undefined
    },
    captureLogcatSnapshot: captureFailureLogcat,
  }
  device.onLaunch = () => {
    for (const line of scenario.launchLines ?? []) lineHandler(line)
  }
  let now = 0
  const executor = new MorphoProtocolExecutor({
    device,
    streams,
    pollIntervalMs: 1_000,
    maxLogcatBytes: 1_024,
    minFreeDiskBytes: 1,
    companionAssetsDir,
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
    configuredTimeoutSeconds: 30,
    signal: new AbortController().signal,
    reporter,
  }
  return { captureFailureLogcat, context, device, executor, logs, checks, companionAssetsDir }
}

describe('MorphoProtocolExecutor seam', () => {
  it('completes from a full startup probe and writes a backend result', async () => {
    const harness = await createHarness()

    const result = await harness.executor.execute(harness.context)

    expect(result).toMatchObject({
      inputSizeBytes: 11,
      outputSizeBytes: 12,
      remoteOutputFile: harness.context.paths.remoteOutputFile,
    })
    expect(JSON.parse(await readFile(harness.context.local.resultPath, 'utf8'))).toMatchObject({
      taskId: 'task-1',
      status: 'passed',
      source: 'backend-synthesized',
      output: { originalRemotePath: harness.context.paths.remoteOutputFile },
    })
    expect(harness.checks).toEqual(expect.arrayContaining([
      { key: 'launch', status: 'passed' },
      { key: 'processing', status: 'passed' },
    ]))
  })

  it('keeps a truncated probe distinct from a negative startup observation', async () => {
    const harness = await createHarness({
      serviceRunning: false,
      truncatedSection: 'power',
    })

    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      code: 'STARTUP_OBSERVATION_INCOMPLETE',
    })
    expect(harness.logs).toContainEqual({
      message: expect.stringContaining('启动探测证据不完整'),
      level: 'warning',
    })
  })

  it('keeps a failed probe command distinct from process absence', async () => {
    const harness = await createHarness({
      serviceRunning: false,
      commandFailureSection: 'services',
    })
    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      code: 'STARTUP_OBSERVATION_INCOMPLETE',
    })
  })

  it('classifies a confirmed absent process as an app crash', async () => {
    const harness = await createHarness({
      serviceRunning: false,
      processRunning: false,
    })
    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      code: 'APP_CRASHED',
    })
  })

  it('does not convert a process observation failure into process absence', async () => {
    const harness = await createHarness({
      serviceRunning: false,
      observationFailureSection: 'process',
    })
    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      code: 'ADB_OBSERVATION_FAILED',
    })
  })

  it('accepts a business log before the first startup probe', async () => {
    const harness = await createHarness({
      serviceRunning: false,
      launchLines: ['MORPHO: Processing file input.mp4'],
    })

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      outputSizeBytes: 12,
    })
    expect(harness.device.observations).toHaveLength(0)
  })

  it('lets positive service/output evidence win over a Logcat startup failure', async () => {
    const harness = await createHarness({
      logcatStartError: new Error('logcat unavailable'),
    })

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      logcatWarning: expect.stringContaining('LOGCAT_START_FAILED'),
    })
    expect(harness.logs).toContainEqual({
      message: expect.stringContaining('LOGCAT_START_FAILED'),
      level: 'warning',
    })
  })

  it('gives an explicit Morpho business failure priority over marker and output', async () => {
    const harness = await createHarness({
      launchLines: [
        'MORPHO: Processing file input.mp4',
        'MORPHO: Error processing file: decoder failed',
      ],
    })

    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      code: 'SDK_PROCESSING_FAILED',
      message: expect.stringContaining('decoder failed'),
    })
  })

  it.each([
    [absent<number>(), 'OUTPUT_MISSING'],
    [present(0), 'OUTPUT_EMPTY'],
    [{
      kind: 'failed',
      error: new TaskExecutionError('stat permission denied', 'ADB_OBSERVATION_FAILED'),
      result: processResult(2, '', 'permission denied'),
    } satisfies AdbObservation<number>, 'ADB_OBSERVATION_FAILED'],
  ])('keeps marker output observations distinct', async (outputObservation, code) => {
    const harness = await createHarness({ outputObservation })
    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({ code })
  })

  it('uses only a directly discovered MP4 child as the output path', async () => {
    const reference = await createHarness()
    const discovered = `${reference.context.paths.remoteOutputDirectory}/vendor-output.mp4`
    const discoveredHarness = await createHarness({
      launchLines: [`MORPHO: Output: ${discovered}`],
    })
    const discoveredResult = await discoveredHarness.executor.execute(discoveredHarness.context)
    expect(discoveredResult.remoteOutputFile).toBe(discovered)
    expect(JSON.parse(await readFile(discoveredHarness.context.local.resultPath, 'utf8'))).toMatchObject({
      output: { originalRemotePath: discovered },
    })
  })

  it('stops polling on cancellation and still force-stops and cleans remote files', async () => {
    const harness = await createHarness({
      cancelled: true,
      launchLines: ['MORPHO: Processing file input.mp4'],
    })

    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(harness.device.commands).toEqual(expect.arrayContaining([
      ['shell', 'am', 'force-stop', harness.context.protocol.packageName],
      expect.arrayContaining(['shell', 'rm', '-f', harness.context.paths.remoteInputFile]),
    ]))
  })

  it('records cleanup failure as a warning without replacing the original failure', async () => {
    const harness = await createHarness({
      launchLines: [
        'MORPHO: Processing file input.mp4',
        'MORPHO: Error processing file: original business failure',
      ],
      cleanupError: new Error('force-stop denied'),
    })

    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      code: 'SDK_PROCESSING_FAILED',
      message: expect.stringContaining('original business failure'),
    })
    expect(harness.logs).toContainEqual({
      message: expect.stringContaining('force-stop denied'),
      level: 'warning',
    })
  })
})

describe('MorphoProtocolExecutor companion assets', () => {
  const xml = '<MorphoVideoDenoiser><Mode><bypass length="1">0</bypass></Mode></MorphoVideoDenoiser>'

  it('pushes companion assets into the DataPack before the input MP4, without force-stop', async () => {
    const harness = await createHarness({
      companionAssets: {
        'morpho_video_denoiser_setting.xml': xml,
        '.DS_Store': 'finder-noise',
      },
    })

    await harness.executor.execute(harness.context)

    const { paths } = harness.context
    const commands = harness.device.commands.map((command) => command.join(' '))
    const assetIndex = commands.indexOf(
      [
        'push',
        path.join(harness.companionAssetsDir!, 'morpho_video_denoiser_setting.xml'),
        `${paths.remoteInputDirectory}/morpho_video_denoiser_setting.xml`,
      ].join(' '),
    )
    const inputIndex = commands.indexOf(
      ['push', harness.context.input.localPath, paths.remoteInputFile].join(' '),
    )
    const launchIndex = commands.findIndex((command) => command.startsWith('shell am start'))
    expect(assetIndex).toBeGreaterThanOrEqual(0)
    expect(inputIndex).toBeGreaterThan(assetIndex)
    expect(launchIndex).toBeGreaterThan(inputIndex)
    // vivo freezes cold-restarted batch processes — no force-stop may run between
    // the push and the batch launch (the final cleanup force-stop is fine).
    expect(commands.slice(assetIndex, launchIndex)).not.toContain(
      `shell am force-stop ${harness.context.protocol.packageName}`,
    )
    expect(commands.some((command) => command.includes('.DS_Store'))).toBe(false)
    expect(harness.logs).toContainEqual({
      message: `已推送伴生资产：morpho_video_denoiser_setting.xml (${Buffer.byteLength(xml)} bytes)`,
      level: 'info',
    })
  })

  it('warns and runs stabilizer-only when the companion asset directory is missing', async () => {
    const harness = await createHarness({ companionAssets: 'missing' })

    await harness.executor.execute(harness.context)

    const pushes = harness.device.commands.filter((command) => command[0] === 'push')
    expect(pushes).toEqual([
      ['push', harness.context.input.localPath, harness.context.paths.remoteInputFile],
    ])
    expect(harness.logs).toContainEqual({
      message: expect.stringContaining('未找到伴生资产目录'),
      level: 'warning',
    })
  })

  it('fails the attempt as INPUT_PUSH_FAILED when an asset push fails', async () => {
    const harness = await createHarness({
      companionAssets: { 'morpho_video_denoiser_setting.xml': xml },
    })
    const originalRun = harness.device.run.bind(harness.device)
    harness.device.run = async (args) => {
      if (args[0] === 'push' && args[1]?.endsWith('.xml')) {
        throw new TaskExecutionError('adb: error: failed to copy', 'INPUT_PUSH_FAILED')
      }
      return originalRun(args)
    }

    await expect(harness.executor.execute(harness.context)).rejects.toMatchObject({
      code: 'INPUT_PUSH_FAILED',
    })
  })
})
