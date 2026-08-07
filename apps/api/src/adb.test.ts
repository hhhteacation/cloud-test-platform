import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AdbRunExecutor, parseCarrierResult, type AdbExecutionDevice, type AdbExecutionStreams } from './adb.js'
import { config as defaultConfig, type AppConfig } from './config.js'
import { PlatformDatabase, type DeviceRunExecution } from './database.js'
import { MediaIntegrityChecker } from './media-integrity.js'
import type { ProcessResult, ProcessRunner } from './process.js'
import { TaskExecutionError } from './execution/execution-errors.js'
import type { AndroidAppPreparer } from './execution/android-app-preparation/contracts.js'
import type { LogcatStreamEvent } from './execution/adb-streams.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function result(code = 0, stdout = '', stderr = ''): ProcessResult {
  return { code, stdout, stderr }
}

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), 'cloud-test-adb-executor-'))
  roots.push(root)
  const inputPath = path.join(root, 'input.mp4')
  const apkPath = path.join(root, 'test.apk')
  await writeFile(inputPath, 'input-video')
  await writeFile(apkPath, 'apk')

  const database = new PlatformDatabase({
    databasePath: path.join(root, 'cloud-test.sqlite'),
    seedDevice: false,
    markInterruptedTasks: false,
  })
  database.upsertAdbDevice({
    id: 'device-1', serial: 'SERIAL-1', name: 'Test device', manufacturer: 'Example',
    model: 'MODEL-1', osVersion: 'Android 15', apiLevel: 35, architecture: 'arm64-v8a',
  })
  database.upsertDeviceEndpoint({
    deviceId: 'device-1', kind: 'usb', adbSerial: 'SERIAL-1', status: 'online',
  })
  const apk = database.insertArtifact({
    kind: 'apk', originalName: 'test.apk', mimeType: 'application/vnd.android.package-archive',
    storagePath: apkPath, sizeBytes: 3, sha256: 'apk-sha', packageName: 'com.morphoinc.videopostprocessor',
  })
  const video = database.insertArtifact({
    kind: 'video', originalName: 'input.mp4', mimeType: 'video/mp4',
    storagePath: inputPath, sizeBytes: 11, sha256: 'video-sha',
  })
  const task = database.createTask({
    name: 'executor seam', apkArtifactId: apk.id, videoArtifactId: video.id,
    deviceIds: ['device-1'], timeoutSeconds: 30,
  })
  const [job] = database.listQueuedDeviceRunJobs(task.id)
  database.assignDeviceRunEndpoint(job!, {
    endpointId: 'missing-endpoint-id', connectionKind: 'usb', adbSerial: 'SERIAL-1',
  })
  // The endpoint id is only used as an execution precondition by AdbWorker; the
  // executor itself receives the already-resolved execution object.
  const execution = database.getDeviceRunExecution(task.id, job!.runId)!
  return { root, database, execution, inputPath }
}

function createMediaChecker() {
  const runner: ProcessRunner = {
    async run(command) {
      if (command.includes('ffprobe')) {
        return result(0, JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'h264', width: 16, height: 16, avg_frame_rate: '30/1', nb_read_frames: '1' }],
          format: { duration: '1', format_name: 'mp4' },
        }))
      }
      return result()
    },
  }
  return new MediaIntegrityChecker({
    runner,
    config: { ...defaultConfig, ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg' },
  })
}

class FakeDevice implements AdbExecutionDevice {
  readonly observations: string[][] = []
  private readonly onLaunch: () => void
  incompletePower = false
  serviceDetected = true

  constructor(onLaunch: () => void) {
    this.onLaunch = onLaunch
  }

  async connectionStatus() { return 'online' as const }

  async run(args: string[]) {
    this.observations.push(args)
    if (args[0] === 'shell' && args[1] === 'getprop' && args[2] === 'ro.product.manufacturer') {
      return result(0, 'Example')
    }
    if (args[0] === 'shell' && args[1] === 'getprop' && args[2] === 'ro.product.model') {
      return result(0, 'MODEL-1')
    }
    if (args[0] === 'shell' && args[1] === 'dumpsys' && args[2] === 'power') {
      return result(0, 'mWakefulness: Awake\nmInteractive=true')
    }
    if (args[0] === 'shell' && args[1] === 'dumpsys' && args[2] === 'window') {
      return result(0, 'KeyguardServiceDelegate\n  interactiveState=INTERACTIVE_STATE_AWAKE')
    }
    if (args[0] === 'pull') {
      await writeFile(args[2]!, 'output-video')
      return result()
    }
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start') {
      this.onLaunch()
    }
    return result()
  }

  async observe(args: string[]) {
    this.observations.push(args)
    const section = args[args.length - 1]
    if (args.includes('services')) {
      return result(0, this.serviceDetected ? 'ServiceRecord com.morphoinc.videopostprocessor/.BatchProcessService' : '')
    }
    if (args.includes('pidof')) return result(0, '1234')
    if (section === 'power') {
      const value = result(0, 'mWakefulness: Awake\nmInteractive=true')
      return this.incompletePower ? { ...value, stdout: 'partial', stdoutTruncated: true, stdoutBytes: 100 } : value
    }
    if (section === 'policy') return result(0, 'KeyguardServiceDelegate\n  interactiveState=INTERACTIVE_STATE_AWAKE')
    return result()
  }

  async stat(remotePath: string) {
    if (remotePath.endsWith('input.mp4')) return { kind: 'present', value: 11, result: result(0, '11') } as const
    if (remotePath.endsWith('_stabilized.mp4')) return { kind: 'present', value: 12, result: result(0, '12') } as const
    return { kind: 'absent', result: result(1, '', 'No such file or directory') } as const
  }

  async exists(remotePath: string) {
    if (remotePath.endsWith('.batch_processing_complete')) return { kind: 'present', value: true, result: result() } as const
    return { kind: 'absent', result: result(1) } as const
  }

  async isPackageRunning() {
    return { kind: 'present', value: true, result: result(0, '1234') } as const
  }

  async isPackageInstalled() { return true }
}

function createStreams(setHandler: (handler: (line: string) => void) => void): AdbExecutionStreams {
  return {
    async startLogcat(_taskId, _targetPath, _signal, _tags, handler, _onEvent?: (event: LogcatStreamEvent) => void) {
      setHandler(handler)
      return async () => undefined
    },
    async captureLogcatSnapshot() { return undefined },
    async captureScreenshot(_taskId, targetPath) { await writeFile(targetPath, 'png') },
  }
}

const preparer: AndroidAppPreparer = {
  async prepareApplication() {
    return {
      packageName: 'com.morphoinc.videopostprocessor', cleanInstalled: true,
      grantedPermissions: [], handledDialogs: [], timings: { installMs: 1, permissionMs: 1 },
    }
  },
}

describe('carrier result contract', () => {
  it('accepts only an object with a taskId and a terminal status', () => {
    expect(parseCarrierResult(JSON.stringify({ taskId: 'task-1', status: 'passed' }))).toMatchObject({
      taskId: 'task-1',
      status: 'passed',
    })

    for (const content of ['', '   ', '{', '[]', '{}', JSON.stringify({ taskId: 'task-1' }), JSON.stringify({ status: 'passed' }), JSON.stringify({ taskId: 'task-1', status: 'running' })]) {
      expect(() => parseCarrierResult(content)).toThrowError(TaskExecutionError)
      try {
        parseCarrierResult(content)
      } catch (error) {
        expect(error).toMatchObject({ code: 'RESULT_INVALID' })
      }
    }
  })

  it('does not silently reinterpret malformed JSON as an SDK business failure', () => {
    expect(() => parseCarrierResult('{"taskId":"task-1","status":"passed"'))
      .toThrowError(/不是有效 JSON/)
  })
})

describe('AdbRunExecutor cross-module seam', () => {
  it('keeps a Morpho run alive when startup probe output is incomplete but business Logcat arrives', async () => {
    const { database, execution, root } = await createHarness()
    const appConfig: AppConfig = {
      ...defaultConfig, adbPath: 'adb', tasksDir: path.join(root, 'tasks'), dataDir: root,
      databasePath: path.join(root, 'cloud-test.sqlite'), minFreeDiskBytes: 1, pollIntervalMs: 1,
    }
    const runner: ProcessRunner = { async run() { return result() } }
    let logLineHandler: ((line: string) => void) | undefined
    const device = new FakeDevice(() => {
      setTimeout(() => logLineHandler?.('MORPHO: Processing file input.mp4'), 3_200)
    })
    device.incompletePower = true
    device.serviceDetected = false
    const streams = createStreams((handler) => { logLineHandler = handler })
    const executor = new AdbRunExecutor(
      database, execution, createMediaChecker(), appConfig, runner,
      { createDevice: () => device, createStreams: () => streams, createAppPreparer: () => preparer },
    )

    await executor.execute()

    expect(database.getTask(execution.taskId)?.runs['device-1']).toMatchObject({
      status: 'passed', executionStatus: 'passed', failureCode: undefined,
    })
    expect(database.getTask(execution.taskId)?.runs['device-1'].logs).toEqual(expect.arrayContaining([
      expect.stringContaining('Morpho 启动探测证据不完整'),
    ]))
  }, 15_000)

  it('does not map a failed remote observation to ordinary missing output', async () => {
    const { database, execution, root } = await createHarness()
    const appConfig: AppConfig = { ...defaultConfig, adbPath: 'adb', tasksDir: path.join(root, 'tasks'), dataDir: root, databasePath: path.join(root, 'cloud-test.sqlite'), minFreeDiskBytes: 1, pollIntervalMs: 1 }
    const runner: ProcessRunner = { async run() { return result() } }
    const device = new FakeDevice(() => undefined)
    device.stat = async (remotePath: string) => remotePath.endsWith('input.mp4')
      ? { kind: 'present', value: 11, result: result(0, '11') } as const
      : { kind: 'failed', error: new TaskExecutionError('permission denied', 'ADB_OBSERVATION_FAILED'), result: result(2, '', 'permission denied') } as const
    const executor = new AdbRunExecutor(
      database, execution, createMediaChecker(), appConfig, runner,
      { createDevice: () => device, createStreams: () => createStreams(() => undefined), createAppPreparer: () => preparer },
    )

    await executor.execute()

    expect(database.getTask(execution.taskId)?.runs['device-1']).toMatchObject({
      status: 'failed', failureCode: 'ADB_OBSERVATION_FAILED',
    })
  }, 15_000)
})
