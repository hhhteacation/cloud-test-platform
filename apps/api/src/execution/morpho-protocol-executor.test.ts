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
  return { captureFailureLogcat, context, device, executor, logs, checks }
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

interface BatchScenario {
  launchLines?: string[]
  markerObservation?: AdbObservation<boolean>
  /** 按输出文件名（basename）指定 stat 结果，未指定的输出默认 present(12)。 */
  outputStats?: Map<string, AdbObservation<number>>
  /** 按输入文件名（basename）覆盖远端大小，用于构造 push 校验失败。 */
  inputSizeOverrides?: Map<string, number>
  processRunning?: boolean
  cancelled?: boolean
}

class BatchMorphoDevice implements ProtocolExecutionDevice {
  readonly commands: string[][] = []
  onLaunch?: () => void

  constructor(
    private readonly localInputSizes: Map<string, number>,
    private readonly scenario: BatchScenario,
  ) {}

  async run(args: string[]): Promise<ProcessResult> {
    this.commands.push(args)
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
    let result: ProcessResult
    if (args.includes('services')) {
      result = processResult(0, 'ServiceRecord com.morphoinc.videopostprocessor/.BatchProcessService')
    } else if (args.includes('pidof')) {
      result = this.scenario.processRunning === false ? processResult(1, '') : processResult(0, '1234')
    } else if (args.includes('power')) {
      result = processResult(0, 'mWakefulness: Awake\nmInteractive=true')
    } else if (args.includes('policy')) {
      result = processResult(0, 'interactiveState=INTERACTIVE_STATE_AWAKE')
    } else {
      result = processResult()
    }
    if (capture?.captureStdoutPath) await writeFile(capture.captureStdoutPath, result.stdout)
    if (capture?.captureStderrPath) await writeFile(capture.captureStderrPath, result.stderr)
    return result
  }

  async stat(remotePath: string): Promise<AdbObservation<number>> {
    const name = remotePath.split('/').pop()!
    if (name.endsWith('_stabilized.mp4')) {
      return this.scenario.outputStats?.get(name) ?? present(12)
    }
    if (this.scenario.inputSizeOverrides?.has(name)) {
      return present(this.scenario.inputSizeOverrides.get(name)!)
    }
    return present(this.localInputSizes.get(name) ?? 12)
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

async function createBatchHarness(videoNames: string[], scenario: BatchScenario = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'morpho-batch-executor-'))
  roots.push(root)
  const protocol = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
  const batchRoot = path.join(root, 'batch-attempts', '1')
  const localInputSizes = new Map<string, number>()
  const videos = videoNames.map((name, index) => {
    const localPath = path.join(root, `source-${index}.mp4`)
    return { name, localPath, content: `input-video-${index}` }
  })
  for (const video of videos) {
    await writeFile(video.localPath, video.content)
  }

  const sharedPaths = buildExecutionPaths(protocol, {
    taskId: 'task-1',
    manufacturer: 'HONOR',
    model: 'ALI-AN00',
    inputFileName: videos[0]!.name,
  })
  const requests = videos.map((video, index) => {
    const paths = buildExecutionPaths(protocol, {
      taskId: 'task-1',
      manufacturer: 'HONOR',
      model: 'ALI-AN00',
      inputFileName: video.name,
    })
    localInputSizes.set(paths.remoteInputFile.split('/').pop()!, Buffer.byteLength(video.content))
    const runDirectory = path.join(batchRoot, 'videos', `task-video-${index + 1}`, 'attempts', '1')
    const logs: Array<{ message: string; level: string }> = []
    const checks: Array<{ key: string; status: string }> = []
    const progress: number[] = []
    const reporter: ProtocolExecutionReporter = {
      update: vi.fn(),
      addLog: (message, level = 'info') => logs.push({ message, level }),
      setProcessingProgress: (value) => progress.push(value),
      upsertCheck: (check) => checks.push({ key: check.key, status: check.status }),
      isCancelled: () => Boolean(scenario.cancelled),
    }
    return {
      taskVideoId: `task-video-${index + 1}`,
      originalName: video.name,
      localPath: video.localPath,
      paths,
      local: {
        runDirectory,
        resultPath: path.join(runDirectory, 'result.json'),
        outputPath: path.join(runDirectory, 'output.mp4'),
      },
      reporter,
      logs,
      checks,
      progress,
    }
  })

  const device = new BatchMorphoDevice(localInputSizes, scenario)
  const batchLogs: string[] = []
  const batchReporter: ProtocolExecutionReporter = {
    update: vi.fn(),
    addLog: (message) => batchLogs.push(message),
    setProcessingProgress: vi.fn(),
    upsertCheck: vi.fn(),
    isCancelled: () => Boolean(scenario.cancelled),
  }
  let lineHandler: (line: string) => void = () => undefined
  const streams: ProtocolExecutionStreams = {
    async startLogcat(_key, _target, _signal, _tags, onLine) {
      lineHandler = onLine
      return async () => undefined
    },
    captureLogcatSnapshot: vi.fn(async () => undefined),
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
    now: () => now,
    delay: async (ms, signal) => {
      if (signal.aborted) throw new DOMException('任务已取消', 'AbortError')
      now += ms
    },
  })
  await Promise.all(requests.map((request) => mkdir(request.local.runDirectory, { recursive: true })))
  const context: BatchExecutionContext = {
    executionKey: 'batch-1',
    taskId: 'task-1',
    protocol,
    paths: sharedPaths,
    videos: requests,
    local: {
      runDirectory: batchRoot,
      logcatPath: path.join(batchRoot, 'logcat.txt'),
      diagnosticsDirectory: path.join(batchRoot, 'diagnostics'),
    },
    configuredTimeoutSeconds: 30,
    signal: new AbortController().signal,
    reporter: batchReporter,
  }
  return { context, device, executor, requests, batchLogs, outputDirectory: sharedPaths.remoteOutputDirectory }
}

describe('MorphoProtocolExecutor directory batch', () => {
  it('pushes all inputs once, sends one Action, and converges every video output', async () => {
    const harness = await createBatchHarness(['tv-1-input.mp4', 'tv-2-input.mp4', 'tv-3-input.mp4'], {
      launchLines: [
        'MORPHO: Found 3 mp4 files to process',
        'MORPHO: Processing file 1/3: tv-1-input.mp4',
        `MORPHO: Output: ${buildExecutionPaths(findApkExecutionProtocol('com.morphoinc.videopostprocessor')!, { taskId: 'task-1', manufacturer: 'HONOR', model: 'ALI-AN00', inputFileName: 'tv-1-input.mp4' }).remoteOutputFile}`,
        'MORPHO: Processing file 2/3: tv-2-input.mp4',
        // 第二条视频故意不发 Output 行：收敛必须回退到确定性命名。
        'MORPHO: Processing file 3/3: tv-3-input.mp4',
        `MORPHO: Output: ${buildExecutionPaths(findApkExecutionProtocol('com.morphoinc.videopostprocessor')!, { taskId: 'task-1', manufacturer: 'HONOR', model: 'ALI-AN00', inputFileName: 'tv-3-input.mp4' }).remoteOutputFile}`,
        `MORPHO: Created completion marker file: ${findApkExecutionProtocol('com.morphoinc.videopostprocessor')!.completion.remotePathTemplate.replaceAll('{packageName}', 'com.morphoinc.videopostprocessor')}`,
        'MORPHO: BatchProcessService destroyed',
      ],
    })

    const result = await harness.executor.executeBatch(harness.context)

    expect(result.batchAborted).toBe(false)
    expect(result.outcomes.map((outcome) => [outcome.taskVideoId, outcome.status])).toEqual([
      ['task-video-1', 'converged'],
      ['task-video-2', 'converged'],
      ['task-video-3', 'converged'],
    ])
    // 每条视频的输出都拉到自己的 attempt 目录并写了 result.json。
    for (const request of harness.requests) {
      const outcome = result.outcomes.find((entry) => entry.taskVideoId === request.taskVideoId)!
      expect(outcome.output?.remoteOutputFile).toBe(request.paths.remoteOutputFile)
      expect(await readFile(request.local.outputPath, 'utf8')).toBe('output-video')
      expect(JSON.parse(await readFile(request.local.resultPath, 'utf8'))).toMatchObject({
        status: 'passed',
        batch: { taskVideoId: request.taskVideoId },
        output: { originalRemotePath: request.paths.remoteOutputFile },
      })
      expect(request.checks).toEqual(expect.arrayContaining([
        { key: 'input', status: 'passed' },
        { key: 'processing', status: 'passed' },
        { key: 'output_generated', status: 'passed' },
      ]))
    }
    // 只发一次批处理 Action；三条输入各 push 一次；清理覆盖全部输入/输出/marker。
    const launches = harness.device.commands.filter((args) =>
      args.some((argument) => argument.endsWith('ACTION_BATCH_PROCESS')))
    expect(launches).toHaveLength(1)
    const pushes = harness.device.commands.filter((args) => args[0] === 'push')
    expect(pushes).toHaveLength(3)
    const cleanup = harness.device.commands.filter((args) => args.includes('rm') && args.includes('-f'))
    for (const request of harness.requests) {
      expect(cleanup).toEqual(expect.arrayContaining([
        expect.arrayContaining([request.paths.remoteInputFile, request.paths.remoteOutputFile]),
      ]))
    }
  })

  it('converges finished videos, fails the fatal one, and leaves the rest not_started on batch abort', async () => {
    const harness = await createBatchHarness(['tv-1-input.mp4', 'tv-2-input.mp4', 'tv-3-input.mp4'], {
      markerObservation: absent(),
      processRunning: false,
      launchLines: [
        'MORPHO: Found 3 mp4 files to process',
        'MORPHO: Processing file 1/3: tv-1-input.mp4',
        `MORPHO: Output: ${buildExecutionPaths(findApkExecutionProtocol('com.morphoinc.videopostprocessor')!, { taskId: 'task-1', manufacturer: 'HONOR', model: 'ALI-AN00', inputFileName: 'tv-1-input.mp4' }).remoteOutputFile}`,
        'MORPHO: Processing file 2/3: tv-2-input.mp4',
        'E MorphoVideoPProc/Controller: [PIPELINE] Received Error: module=VideoStabilizer failure=12 code=6 fatal=1 frame=59 msg=video_stabilizer SDK process failed',
        'MORPHO: BatchProcessService destroyed',
      ],
    })

    const result = await harness.executor.executeBatch(harness.context)

    expect(result.batchAborted).toBe(true)
    expect(result.outcomes.map((outcome) => [outcome.taskVideoId, outcome.status])).toEqual([
      ['task-video-1', 'converged'],
      ['task-video-2', 'failed'],
      ['task-video-3', 'not_started'],
    ])
    expect(result.outcomes[1]!.failure).toMatchObject({
      code: 'SDK_PROCESSING_FAILED',
      message: expect.stringContaining('video_stabilizer SDK process failed'),
    })
    // 已收敛视频的输出依然回收成功，失败视频不写 result.json。
    expect(await readFile(harness.requests[0]!.local.outputPath, 'utf8')).toBe('output-video')
    await expect(readFile(harness.requests[1]!.local.resultPath, 'utf8')).rejects.toThrow()
  })

  it('fails only the video whose output is missing after the marker', async () => {
    const protocol = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const missingOutput = buildExecutionPaths(protocol, {
      taskId: 'task-1', manufacturer: 'HONOR', model: 'ALI-AN00', inputFileName: 'tv-2-input.mp4',
    }).remoteOutputFile.split('/').pop()!
    const harness = await createBatchHarness(['tv-1-input.mp4', 'tv-2-input.mp4'], {
      outputStats: new Map([[missingOutput, absent<number>()]]),
      launchLines: [
        'MORPHO: Found 2 mp4 files to process',
        'MORPHO: Processing file 1/3: tv-1-input.mp4'.replace('1/3', '1/2'),
        'MORPHO: Processing file 2/2: tv-2-input.mp4',
        'MORPHO: Created completion marker file: done',
      ],
    })

    const result = await harness.executor.executeBatch(harness.context)

    expect(result.batchAborted).toBe(false)
    expect(result.outcomes.map((outcome) => [outcome.taskVideoId, outcome.status])).toEqual([
      ['task-video-1', 'converged'],
      ['task-video-2', 'failed'],
    ])
    expect(result.outcomes[1]!.failure?.code).toBe('OUTPUT_MISSING')
  })

  it('marks every video not_started when the service dies without any failure signal', async () => {
    const harness = await createBatchHarness(['tv-1-input.mp4', 'tv-2-input.mp4'], {
      markerObservation: absent(),
      processRunning: false,
      launchLines: ['MORPHO: BatchProcessService destroyed'],
    })

    const result = await harness.executor.executeBatch(harness.context)

    expect(result.batchAborted).toBe(true)
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['not_started', 'not_started'])
  })

  it('rejects an input whose remote size mismatches after push', async () => {
    const harness = await createBatchHarness(['tv-1-input.mp4', 'tv-2-input.mp4'], {
      inputSizeOverrides: new Map([['tv-2-input.mp4', 1]]),
    })

    await expect(harness.executor.executeBatch(harness.context)).rejects.toMatchObject({
      code: 'INPUT_PUSH_FAILED',
    })
    // 准备失败也要清理已推送的输入与输出目录。
    const cleanup = harness.device.commands.filter((args) => args.includes('rm'))
    expect(cleanup.length).toBeGreaterThan(0)
  })

  it('times out the whole batch Action with the scaled deadline', async () => {
    const harness = await createBatchHarness(['tv-1-input.mp4', 'tv-2-input.mp4'], {
      markerObservation: absent(),
      launchLines: ['MORPHO: Processing file 1/2: tv-1-input.mp4'],
    })
    harness.context.configuredTimeoutSeconds = 1

    await expect(harness.executor.executeBatch(harness.context)).rejects.toMatchObject({
      code: 'TASK_TIMEOUT',
      message: expect.stringContaining('2 秒'),
    })
  })

  it('stops on cancellation and still cleans up remote files', async () => {
    const harness = await createBatchHarness(['tv-1-input.mp4'], {
      cancelled: true,
      markerObservation: absent(),
      launchLines: ['MORPHO: Processing file 1/1: tv-1-input.mp4'],
    })

    await expect(harness.executor.executeBatch(harness.context)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(harness.device.commands).toEqual(expect.arrayContaining([
      ['shell', 'am', 'force-stop', harness.context.protocol.packageName],
      expect.arrayContaining(['shell', 'rm', '-f', harness.context.paths.remoteCompletionPath]),
    ]))
  })
})
