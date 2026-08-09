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
    if (args[0] === 'shell' && args[1] === 'getprop' && args[2] === 'ro.product.manufacturer') {
      return result(0, 'Example')
    }
    if (args[0] === 'shell' && args[1] === 'getprop' && args[2] === 'ro.product.model') {
      return result(0, 'MODEL-1')
    }
    if (args[0] === 'shell' && args[1] === 'getprop' && args[2] === 'ro.build.version.release') {
      return result(0, '15')
    }
    if (args[0] === 'shell' && args[1] === 'getprop' && args[2] === 'ro.build.fingerprint') {
      return result(0, 'example/model/device:15/BUILD/1:user/release-keys')
    }
    if (args.includes('services')) {
      return result(0, this.serviceDetected ? 'ServiceRecord com.morphoinc.videopostprocessor/.BatchProcessService' : '')
    }
    if (args.includes('pidof')) return result(0, '1234')
    if (section === 'power') {
      const value = result(0, 'mWakefulness: Awake\nmInteractive=true')
      return this.incompletePower ? { ...value, stdout: 'partial', stdoutTruncated: true, stdoutBytes: 100 } : value
    }
    if (section === 'policy') return result(0, 'KeyguardServiceDelegate\n  interactiveState=INTERACTIVE_STATE_AWAKE')
    if (section === 'windows') return result(0, 'mCurrentFocus=Window{123 u0 com.example/.MainActivity}')
    if (args[0] === 'shell' && args[1] === 'pm') {
      return result(0, 'package:com.android.permissioncontroller')
    }
    if (args[0] === 'shell' && args[1] === 'input') return result(0, 'Usage: input <command>')
    if (args[0] === 'exec-out' && args[1] === 'uiautomator') {
      return result(0, '<?xml version="1.0"?><hierarchy rotation="0"></hierarchy>')
    }
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
    async captureLogcatSnapshot(_taskId, targetPath) { await writeFile(targetPath, 'full logcat') },
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
  it('records source, input, device snapshot, and evidence identity before application preparation', async () => {
    const { database, execution, root } = await createHarness()
    const appConfig: AppConfig = {
      ...defaultConfig,
      rootDir: root,
      adbPath: 'adb',
      tasksDir: path.join(root, 'tasks'),
      dataDir: root,
      databasePath: path.join(root, 'cloud-test.sqlite'),
      minFreeDiskBytes: 1,
      pollIntervalMs: 1,
    }
    const runner: ProcessRunner = { async run() { return result() } }
    const device = new FakeDevice(() => undefined)
    const failingPreparer: AndroidAppPreparer = {
      async prepareApplication() {
        throw new TaskExecutionError('stop after manifest seam', 'APK_INSTALL_FAILED')
      },
    }
    const executor = new AdbRunExecutor(
      database, execution, createMediaChecker(), appConfig, runner,
      {
        createDevice: () => device,
        createStreams: () => createStreams(() => undefined),
        createAppPreparer: () => failingPreparer,
        readSourceIdentity: async () => ({ commitSha: '0123456789abcdef', dirty: false }),
        now: () => new Date('2026-08-09T01:02:03.000Z'),
      },
    )

    await executor.execute()

    const evidenceDirectory = path.join(root, 'tasks', execution.taskId, 'device-runs', execution.runId)
    const manifest = JSON.parse(await readFile(path.join(evidenceDirectory, 'attempt-manifest.json'), 'utf8'))
    expect(manifest).toEqual({
      attemptId: execution.runId,
      commitSha: '0123456789abcdef',
      dirty: false,
      startedAt: '2026-08-09T01:02:03.000Z',
      device: {
        serial: 'SERIAL-1',
        manufacturer: 'Example',
        model: 'MODEL-1',
        androidVersion: '15',
        buildFingerprint: 'example/model/device:15/BUILD/1:user/release-keys',
      },
      protocolId: 'morpho-video-postprocessor-batch-v2',
      profileVersion: 'android-dialog-profiles@1',
      inputFingerprint: '3dc8a2dea8c9b132b872a0acc02b82baa35a5aa5f90f6bccfd520028034881a3',
      evidenceDirectory,
    })
    expect(JSON.parse(await readFile(path.join(evidenceDirectory, 'device-snapshot.json'), 'utf8'))).toMatchObject({
      connectionStatus: 'online',
      manufacturer: 'Example',
      model: 'MODEL-1',
      androidVersion: '15',
      currentWindow: 'com.example/.MainActivity',
      controllerPackages: ['com.android.permissioncontroller'],
      inputAutomationCommandAvailable: true,
      observationFailures: [],
    })
    expect(JSON.parse(await readFile(
      path.join(evidenceDirectory, 'diagnostics/failure/failure-context.json'),
      'utf8',
    ))).toMatchObject({
      capturedAt: '2026-08-09T01:02:03.000Z',
      phase: 'validating_apk',
      cancelled: false,
      error: { code: 'APK_INSTALL_FAILED', message: 'stop after manifest seam' },
    })
    expect(await readFile(path.join(evidenceDirectory, 'diagnostics/failure/window.txt'), 'utf8'))
      .toContain('com.example/.MainActivity')
    expect(await readFile(path.join(evidenceDirectory, 'diagnostics/failure/ui.xml'), 'utf8'))
      .toContain('<hierarchy')
    expect(await readFile(path.join(evidenceDirectory, 'diagnostics/failure/screenshot.png'), 'utf8'))
      .toBe('png')
    expect(await readFile(path.join(evidenceDirectory, 'diagnostics/failure/logcat-full.txt'), 'utf8'))
      .toBe('full logcat')
    const failureEvidenceRefs = database.getTask(execution.taskId)?.runs['device-1'].failure?.evidenceRefs ?? []
    for (const evidenceRef of [
      'attempt-manifest.json',
      'diagnostics/failure/failure-context.json',
      'diagnostics/failure/window.txt',
      'diagnostics/failure/ui.xml',
      'diagnostics/failure/screenshot.png',
      'diagnostics/failure/logcat-full.txt',
      'diagnostics/failure/evidence-capture-result.json',
    ]) {
      expect(failureEvidenceRefs.some((ref) => ref.endsWith(`/evidence/${evidenceRef}`))).toBe(true)
    }
  })

  it('keeps the initial manifest when the device is offline', async () => {
    const { database, execution, root } = await createHarness()
    const appConfig: AppConfig = {
      ...defaultConfig,
      rootDir: root,
      adbPath: 'adb',
      tasksDir: path.join(root, 'tasks'),
      dataDir: root,
      databasePath: path.join(root, 'cloud-test.sqlite'),
      minFreeDiskBytes: 1,
      pollIntervalMs: 1,
    }
    const runner: ProcessRunner = { async run() { return result() } }
    const device = new FakeDevice(() => undefined)
    device.connectionStatus = async () => 'offline'
    const executor = new AdbRunExecutor(
      database, execution, createMediaChecker(), appConfig, runner,
      {
        createDevice: () => device,
        createStreams: () => createStreams(() => undefined),
        createAppPreparer: () => preparer,
        readSourceIdentity: async () => ({ commitSha: 'offline-sha', dirty: true }),
      },
    )

    await executor.execute()

    const evidenceDirectory = path.join(root, 'tasks', execution.taskId, 'device-runs', execution.runId)
    expect(JSON.parse(await readFile(path.join(evidenceDirectory, 'attempt-manifest.json'), 'utf8'))).toMatchObject({
      attemptId: execution.runId,
      commitSha: 'offline-sha',
      dirty: true,
      device: { serial: 'SERIAL-1', manufacturer: 'unknown', model: 'unknown' },
    })
    expect(JSON.parse(await readFile(path.join(evidenceDirectory, 'device-snapshot.json'), 'utf8'))).toMatchObject({
      connectionStatus: 'offline',
      observationFailures: ['device connection is offline'],
    })
  })

  it('records an attempt before rejecting an unsupported APK protocol', async () => {
    const { database, execution, root } = await createHarness()
    const unsupportedExecution: DeviceRunExecution = {
      ...execution,
      apkPackageName: 'com.example.unsupported',
    }
    const appConfig: AppConfig = {
      ...defaultConfig,
      rootDir: root,
      adbPath: 'adb',
      tasksDir: path.join(root, 'tasks'),
      dataDir: root,
      databasePath: path.join(root, 'cloud-test.sqlite'),
      minFreeDiskBytes: 1,
      pollIntervalMs: 1,
    }
    const runner: ProcessRunner = { async run() { return result() } }
    const executor = new AdbRunExecutor(
      database, unsupportedExecution, createMediaChecker(), appConfig, runner,
      {
        createDevice: () => new FakeDevice(() => undefined),
        createStreams: () => createStreams(() => undefined),
        createAppPreparer: () => preparer,
        readSourceIdentity: async () => ({ commitSha: 'unsupported-sha', dirty: false }),
      },
    )

    await executor.execute()

    const manifestPath = path.join(
      root, 'tasks', execution.taskId, 'device-runs', execution.runId, 'attempt-manifest.json',
    )
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({
      attemptId: execution.runId,
      protocolId: 'unsupported',
      commitSha: 'unsupported-sha',
      device: { serial: 'SERIAL-1' },
    })
    expect(database.getTask(execution.taskId)?.runs['device-1']).toMatchObject({
      status: 'failed', failureCode: 'UNSUPPORTED_APK_PROTOCOL',
    })
  })

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
