import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  buildExecutionPaths,
  buildLaunchArguments,
  findApkExecutionProtocol,
  parseMorphoLogLine,
  resolveProtocolTimeoutSeconds,
  type ApkExecutionPaths,
  type ApkExecutionProtocol,
} from './apk-protocols.js'
import { config, tasksDir } from './config.js'
import { PlatformDatabase, type DeviceRunExecution, type DeviceRunJob } from './database.js'
import { runProcess } from './process.js'
import { TaskExecutionError } from './execution/execution-errors.js'
import { getCheckName } from './execution/check-names.js'
import { delay, sha256File } from './execution/file-utils.js'
import { AdbDeviceClient } from './execution/adb-client.js'
import { AdbStreams } from './execution/adb-streams.js'
import { TaskProcessRegistry } from './execution/process-registry.js'
import {
  DefaultAndroidAppPreparer,
  type AndroidAppPreparer,
} from './execution/android-app-preparation/index.js'
import type { AndroidCheckEvent, AndroidResult, DeviceRunPhase } from './types.js'

function isDirectRemoteChild(directory: string, candidate: string) {
  const prefix = `${directory.replace(/\/+$/, '')}/`
  if (!candidate.startsWith(prefix)) return false
  const relative = candidate.slice(prefix.length)
  return Boolean(relative) && !relative.includes('/') && relative.toLowerCase().endsWith('.mp4')
}

export class AdbWorker {
  private readonly active = new Map<string, AdbRunExecutor>()

  constructor(private readonly database: PlatformDatabase) {}

  async execute(job: DeviceRunJob) {
    const execution = this.database.getDeviceRunExecution(job.taskId, job.runId)
    if (!execution) throw new Error(`设备执行不存在：${job.runId}`)
    if (execution.taskStatus === 'cancelled' || execution.runStatus !== 'queued') return

    const runner = new AdbRunExecutor(this.database, execution)
    this.active.set(job.runId, runner)
    try {
      await runner.execute()
    } finally {
      this.active.delete(job.runId)
    }
  }

  cancelTask(taskId: string) {
    for (const runner of this.active.values()) {
      if (runner.taskId === taskId) runner.cancel()
    }
  }
}

class AdbRunExecutor {
  readonly taskId: string
  private readonly runId: string
  private readonly processes = new TaskProcessRegistry()
  private readonly device: AdbDeviceClient
  private readonly streams: AdbStreams
  private readonly appPreparer: AndroidAppPreparer

  constructor(
    private readonly database: PlatformDatabase,
    private readonly execution: DeviceRunExecution,
  ) {
    this.taskId = execution.taskId
    this.runId = execution.runId
    this.device = new AdbDeviceClient(config.adbPath, execution.deviceSerial)
    this.streams = new AdbStreams(config.adbPath, execution.deviceSerial, this.processes)
    this.appPreparer = new DefaultAndroidAppPreparer({
      createDevice: () => this.device,
      captureScreenshot: (targetPath, signal) => this.streams.captureScreenshot(
        this.runId,
        targetPath,
        signal,
      ),
    })
  }

  cancel() {
    this.processes.abort(this.runId)
    this.processes.killChildren(this.runId)
    const packageName = this.processes.packageName(this.runId) || this.execution.apkPackageName
    if (packageName) {
      void runProcess(config.adbPath, [
        '-s', this.execution.deviceSerial, 'shell', 'am', 'force-stop', packageName,
      ]).catch(() => undefined)
    }
  }

  async execute() {
    const execution = this.execution
    const { taskId, runId } = execution

    const protocol = findApkExecutionProtocol(execution.apkPackageName)
    if (!protocol) {
      this.database.setExecutionState({
        taskId,
        runId: execution.runId,
        taskStatus: 'failed',
        runStatus: 'failed',
        progress: 100,
        finished: true,
        failureCode: 'UNSUPPORTED_APK_PROTOCOL',
        failureMessage: `APK 包名 ${execution.apkPackageName || '未知'} 没有执行协议`,
      })
      return
    }

    const controller = new AbortController()
    const signal = controller.signal
    this.processes.begin(runId, controller, protocol.packageName)

    const localRunDir = path.join(tasksDir, taskId, 'device-runs', runId)
    const localResult = path.join(localRunDir, 'result.json')
    const localOutput = path.join(localRunDir, 'output.mp4')
    const localLogcat = path.join(localRunDir, 'logcat.txt')
    const screenshotDir = path.join(localRunDir, 'screenshots')
    const diagnosticsDirectory = path.join(localRunDir, 'diagnostics')
    let paths: ApkExecutionPaths | undefined
    let detectedRemoteOutputFile: string | undefined
    let logcatText = ''
    let protocolFailure: string | undefined
    let stopLogcat: (() => Promise<void>) | undefined

    const update = (phase: DeviceRunPhase, progress: number, message: string) => {
      this.database.setExecutionState({
        taskId, runId, taskStatus: 'running', runStatus: 'running', phase, progress,
      })
      this.database.addLog(taskId, runId, message)
    }

    try {
      await mkdir(screenshotDir, { recursive: true })
      this.database.setExecutionState({
        taskId, runId, taskStatus: 'running', runStatus: 'running',
        phase: 'validating_device', progress: 2, started: true,
        failureCode: null, failureMessage: null,
      })
      this.database.addLog(taskId, runId, `开始检查 ADB 真机连接；执行协议：${protocol.name}`)

      const deviceStatus = await this.device.connectionStatus()
      if (deviceStatus === 'unauthorized') {
        throw new TaskExecutionError(`${execution.deviceName} 尚未授权此电脑，请在手机上确认 USB 调试授权`, 'DEVICE_UNAUTHORIZED')
      }
      if (deviceStatus !== 'online') {
        throw new TaskExecutionError(`${execution.deviceName} 未连接或 ADB 状态异常`, 'DEVICE_OFFLINE')
      }

      update('validating_apk', 8, `正在校验 APK 执行协议：${protocol.id}`)
      const manufacturer = (await this.adb(['shell', 'getprop', 'ro.product.manufacturer'], signal)).stdout.trim()
      const model = (await this.adb(['shell', 'getprop', 'ro.product.model'], signal)).stdout.trim()
      paths = buildExecutionPaths(protocol, {
        taskId,
        manufacturer,
        model,
        inputFileName: execution.videoOriginalName,
      })
      detectedRemoteOutputFile = paths.remoteOutputFile

      const preparation = await this.appPreparer.prepareApplication({
        deviceSerial: execution.deviceSerial,
        deviceManufacturer: manufacturer,
        deviceModel: model,
        apkPath: execution.apkPath,
        protocol,
        diagnosticsDirectory,
        signal,
        onEvent: (event) => update(event.phase, event.progress ?? 15, event.message),
      })
      this.database.addLog(
        taskId,
        runId,
        `应用准备完成：${preparation.cleanInstalled ? '干净安装' : '覆盖安装'}；`
          + `已授权 ${preparation.grantedPermissions.length} 项权限；`
          + `自动处理 ${preparation.handledDialogs.length} 个系统弹窗`,
      )

      update('transferring_input', 25, '正在准备 APK 输入目录并清理本次旧结果')
      await this.prepareRemotePaths(protocol, paths, signal)
      await this.adb(['push', execution.videoPath, paths.remoteInputFile], signal, 180_000, 'INPUT_PUSH_FAILED')
      const remoteSize = await this.remoteStat(paths.remoteInputFile, signal)
      const localSize = (await stat(execution.videoPath)).size
      if (!Number.isFinite(remoteSize) || remoteSize !== localSize) {
        throw new TaskExecutionError('手机端输入 MP4 大小与上传文件不一致', 'INPUT_PUSH_FAILED')
      }
      this.database.upsertCheck(runId, {
        key: 'input', name: '输入 MP4 校验', status: 'passed', message: `${localSize} bytes`,
      })

      await this.adb(['logcat', '-c'], signal)
      stopLogcat = this.startLogcat(runId, protocol.progress.logTag, signal, (line) => {
        logcatText += `${line}\n`
        if (protocol.progress.mode === 'structured_log') {
          this.consumeStructuredEvent(taskId, runId, line)
          return
        }

        const event = parseMorphoLogLine(line)
        if (!event) return
        if (event.message) this.database.addLog(taskId, runId, event.message, event.failureMessage ? 'error' : 'info')
        if (event.failureMessage) protocolFailure = event.failureMessage
        if (event.outputPath && paths && isDirectRemoteChild(paths.remoteOutputDirectory, event.outputPath)) {
          detectedRemoteOutputFile = event.outputPath
          this.database.addLog(taskId, runId, `Morpho 实际输出路径：${event.outputPath}`)
        }
        if (typeof event.progress === 'number') {
          this.database.setExecutionState({
            taskId, runId, taskStatus: 'running', runStatus: 'running',
            phase: 'processing', progress: event.progress,
          })
        }
      })

      update('launching_app', 35, `正在按 ${protocol.name} 启动 APK`)
      await this.adb(buildLaunchArguments(protocol, paths, taskId), signal, 30_000, 'APP_LAUNCH_FAILED')
      this.database.upsertCheck(runId, { key: 'launch', name: '应用启动', status: 'passed' })

      update('processing', 45, protocol.id === 'morpho-video-postprocessor-batch-v2'
        ? 'Morpho 已自动启动，等待批处理完成标记和稳定后视频'
        : 'APK 已自动启动，等待真实 SDK 生成 result.json 和 output.mp4')

      if (protocol.completion.mode === 'result_json') {
        if (!paths.remoteResultFile) throw new TaskExecutionError('协议缺少 result.json 路径', 'INVALID_TEST_APK')
        await this.waitForResultJson(taskId, protocol, paths.remoteResultFile, execution.timeoutSeconds * 1000, signal)
        await this.collectCarrierResult(taskId, runId, paths, localResult, signal)
      } else {
        const effectiveTimeoutSeconds = resolveProtocolTimeoutSeconds(protocol, execution.timeoutSeconds)
        await this.waitForMorphoCompletion(
          taskId,
          protocol,
          paths,
          effectiveTimeoutSeconds * 1000,
          signal,
          () => protocolFailure,
          () => detectedRemoteOutputFile ?? paths!.remoteOutputFile,
        )
        this.database.upsertCheck(runId, {
          key: 'processing', name: 'SDK 视频处理', status: 'passed',
          message: 'Morpho 完成标记、日志和输出文件联合校验通过',
        })
      }

      update('validating_output', 78, '正在验证 APK 生成的输出 MP4')
      const remoteOutputFile = detectedRemoteOutputFile ?? paths.remoteOutputFile
      const outputStat = await this.remoteStat(remoteOutputFile, signal)
      if (outputStat <= 0) {
        throw new TaskExecutionError(
          `APK 未生成有效输出：${remoteOutputFile}`,
          outputStat === 0 ? 'OUTPUT_EMPTY' : 'OUTPUT_MISSING',
        )
      }

      update('collecting_output', 88, '正在从手机拉取处理后的 MP4，并在平台统一保存为 output.mp4')
      await this.adb(['pull', remoteOutputFile, localOutput], signal, 180_000, 'OUTPUT_MISSING')
      const outputLocalStat = await stat(localOutput)
      if (outputLocalStat.size <= 0) throw new TaskExecutionError('拉取的输出 MP4 为空', 'OUTPUT_EMPTY')
      const outputSha256 = await sha256File(localOutput)
      this.database.addOutput({
        taskId, runId, storagePath: localOutput, sizeBytes: outputLocalStat.size, sha256: outputSha256,
      })
      this.database.upsertCheck(runId, {
        key: 'output_generated', name: '输出 MP4 生成', status: 'passed',
        message: `${outputLocalStat.size} bytes；手机原始路径：${remoteOutputFile}`,
      })

      if (!protocol.result.apkGeneratesResultJson) {
        await this.writeBackendResult({
          taskId,
          protocol,
          localResult,
          inputSizeBytes: localSize,
          inputName: execution.videoOriginalName,
          outputSizeBytes: outputLocalStat.size,
          outputSha256,
          remoteOutputFile,
        })
      }

      update('generating_report', 96, '正在保存日志、截图和兼容性报告')
      await writeFile(localLogcat, logcatText, 'utf8')
      await this.captureScreenshot(runId, path.join(screenshotDir, 'final.png'), signal).catch(() => undefined)
      this.database.setExecutionState({
        taskId, runId, taskStatus: 'passed', runStatus: 'passed',
        phase: 'completed', progress: 100, finished: true,
      })
      this.database.addLog(
        taskId,
        runId,
        `真实 APK 处理完成；协议 ${protocol.id}；输出 MP4 已回收到平台`,
      )
    } catch (error) {
      const cancelled = signal.aborted || this.database.isCancelled(taskId)
      const failureCode = cancelled
        ? 'TASK_CANCELLED'
        : error instanceof TaskExecutionError
          ? error.code
          : 'SDK_PROCESSING_FAILED'
      const failureMessage = cancelled ? '用户取消任务' : error instanceof Error ? error.message : String(error)
      if (!cancelled) {
        this.database.setExecutionState({
          taskId, runId, taskStatus: 'failed', runStatus: 'failed',
          progress: 100, finished: true, failureCode, failureMessage,
        })
        this.database.addLog(taskId, runId, `${failureCode}：${failureMessage}`, 'error')
      }
      await writeFile(localLogcat, logcatText, 'utf8').catch(() => undefined)
    } finally {
      if (stopLogcat) await stopLogcat().catch(() => undefined)
      await runProcess(config.adbPath, [
        '-s', execution.deviceSerial, 'shell', 'am', 'force-stop', protocol.packageName,
      ]).catch(() => undefined)

      if (paths) {
        if (protocol.completion.mode === 'result_json') {
          await runProcess(config.adbPath, [
            '-s', execution.deviceSerial, 'shell', 'rm', '-rf', paths.remoteTaskRoot,
          ]).catch(() => undefined)
        } else {
          const cleanupFiles = [...new Set([
            paths.remoteCompletionPath,
            paths.remoteInputFile,
            paths.remoteOutputFile,
            detectedRemoteOutputFile,
          ].filter((value): value is string => Boolean(value)))]
          await runProcess(config.adbPath, [
            '-s', execution.deviceSerial, 'shell', 'rm', '-f', ...cleanupFiles,
          ]).catch(() => undefined)
        }
      }

      this.processes.clear(runId)
    }
  }

  private async prepareRemotePaths(
    protocol: ApkExecutionProtocol,
    paths: ApkExecutionPaths,
    signal: AbortSignal,
  ) {
    if (protocol.completion.mode === 'result_json') {
      await this.adb(['shell', 'rm', '-rf', paths.remoteTaskRoot], signal)
      await this.adb(['shell', 'mkdir', '-p', paths.remoteInputDirectory], signal)
      await this.adb(['shell', 'mkdir', '-p', paths.remoteOutputDirectory, `${paths.remoteTaskRoot}/result`], signal)
      return
    }

    // Morpho 必须使用厂商 Demo 约定的共享根目录，不能替换成平台自创的 tasks/{taskId} 目录。
    await this.adb(['shell', 'mkdir', '-p', paths.remoteInputDirectory], signal)
    await this.adb(['shell', 'rm', '-f', paths.remoteCompletionPath, paths.remoteInputFile], signal)
    if (protocol.output.clearDirectoryBeforeRun) {
      await this.adb(['shell', 'rm', '-rf', paths.remoteOutputDirectory], signal)
    } else {
      await this.adb(['shell', 'rm', '-f', paths.remoteOutputFile], signal)
    }
    if (!protocol.output.appCreatesDirectory) {
      await this.adb(['shell', 'mkdir', '-p', paths.remoteOutputDirectory], signal)
    }
  }

  private async collectCarrierResult(
    taskId: string,
    runId: string,
    paths: ApkExecutionPaths,
    localResult: string,
    signal: AbortSignal,
  ) {
    if (!paths.remoteResultFile) throw new TaskExecutionError('APK 协议缺少 result.json 路径', 'RESULT_MISSING')

    await this.adb(['pull', paths.remoteResultFile, localResult], signal, 30_000, 'RESULT_MISSING')
    const result = JSON.parse(await readFile(localResult, 'utf8')) as AndroidResult
    if (result.taskId !== taskId) {
      throw new TaskExecutionError('APK 返回的 taskId 与当前任务不一致', 'RESULT_TASK_MISMATCH')
    }
    for (const check of result.checks ?? []) this.database.upsertCheck(runId, check)
    if (result.status !== 'passed') {
      throw new TaskExecutionError(
        result.failureMessage ?? '真实 SDK 视频处理失败',
        result.failureCode ?? 'SDK_PROCESSING_FAILED',
      )
    }
  }

  private async writeBackendResult(input: {
    taskId: string
    protocol: ApkExecutionProtocol
    localResult: string
    inputSizeBytes: number
    inputName: string
    outputSizeBytes: number
    outputSha256: string
    remoteOutputFile: string
  }) {
    await writeFile(input.localResult, JSON.stringify({
      protocolVersion: 1,
      taskId: input.taskId,
      status: 'passed',
      source: 'backend-synthesized',
      protocolId: input.protocol.id,
      packageName: input.protocol.packageName,
      adapter: 'MorphoVideoPostProcessor',
      apkGeneratedResult: false,
      input: {
        name: input.inputName,
        sizeBytes: input.inputSizeBytes,
      },
      output: {
        name: 'output.mp4',
        originalRemotePath: input.remoteOutputFile,
        sizeBytes: input.outputSizeBytes,
        sha256: input.outputSha256,
      },
      checks: [
        { key: 'input', name: '输入 MP4 校验', status: 'passed' },
        { key: 'launch', name: '应用启动', status: 'passed' },
        { key: 'processing', name: 'SDK 视频处理', status: 'passed' },
        { key: 'output_generated', name: '输出 MP4 生成', status: 'passed' },
      ],
      generatedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
  }

  private adb(
    args: string[],
    signal: AbortSignal,
    timeoutMs = 30_000,
    code = 'SDK_PROCESSING_FAILED',
  ) {
    return this.device.run(args, signal, timeoutMs, code)
  }

  private remoteStat(remotePath: string, signal: AbortSignal) {
    return this.device.stat(remotePath, signal)
  }

  private remoteExists(remotePath: string, signal: AbortSignal) {
    return this.device.exists(remotePath, signal)
  }

  private async waitForResultJson(
    taskId: string,
    protocol: ApkExecutionProtocol,
    remoteResult: string,
    timeoutMs: number,
    signal: AbortSignal,
  ) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (this.database.isCancelled(taskId)) throw new DOMException('任务已取消', 'AbortError')
      if (await this.remoteStat(remoteResult, signal) > 0) return

      if (Date.now() - startedAt > 2_000 && !await this.isPackageRunning(protocol.packageName, signal)) {
        throw new TaskExecutionError('测试 APK 进程已退出，且未生成 result.json', 'APP_CRASHED')
      }
      await delay(config.pollIntervalMs, signal)
    }
    throw new TaskExecutionError(`超过 ${Math.round(timeoutMs / 1000)} 秒仍未收到 result.json`, 'TASK_TIMEOUT')
  }

  private async waitForMorphoCompletion(
    taskId: string,
    protocol: ApkExecutionProtocol,
    paths: ApkExecutionPaths,
    timeoutMs: number,
    signal: AbortSignal,
    getFailure: () => string | undefined,
    getOutputFile: () => string,
  ) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (this.database.isCancelled(taskId)) throw new DOMException('任务已取消', 'AbortError')

      const failure = getFailure()
      if (failure) throw new TaskExecutionError(`Morpho SDK 处理失败：${failure}`, 'SDK_PROCESSING_FAILED')

      if (await this.remoteExists(paths.remoteCompletionPath, signal)) {
        const size = await this.remoteStat(getOutputFile(), signal)
        if (size < 0) {
          throw new TaskExecutionError('Morpho 已结束批处理，但没有生成本次稳定后视频', 'OUTPUT_MISSING')
        }
        if (size === 0) {
          throw new TaskExecutionError('Morpho 已生成输出文件，但文件大小为 0', 'OUTPUT_EMPTY')
        }
        return
      }

      if (Date.now() - startedAt > 3_000 && !await this.isPackageRunning(protocol.packageName, signal)) {
        throw new TaskExecutionError('Morpho 进程已退出，且没有生成完成标记', 'APP_CRASHED')
      }
      await delay(config.pollIntervalMs, signal)
    }
    throw new TaskExecutionError(
      `超过 ${Math.round(timeoutMs / 1000)} 秒仍未检测到 Morpho 完成标记`,
      'TASK_TIMEOUT',
    )
  }

  private isPackageRunning(packageName: string, signal: AbortSignal) {
    return this.device.isPackageRunning(packageName, signal)
  }

  private consumeStructuredEvent(taskId: string, runId: string, line: string) {
    const jsonStart = line.indexOf('{')
    if (jsonStart < 0) return
    try {
      const event = JSON.parse(line.slice(jsonStart)) as AndroidCheckEvent
      if (event.taskId !== taskId) return
      if (event.message) this.database.addLog(taskId, runId, event.message)
      if (event.checkKey && event.status && event.status !== 'running') {
        this.database.upsertCheck(runId, {
          key: event.checkKey,
          name: event.name ?? getCheckName(event.checkKey),
          status: event.status,
          durationMs: event.durationMs,
          message: event.message,
        })
      }
      if (typeof event.progress === 'number') {
        const progress = Math.max(45, Math.min(75, event.progress))
        this.database.setExecutionState({
          taskId, runId, taskStatus: 'running', runStatus: 'running',
          phase: 'processing', progress,
        })
      }
    } catch {
      // 非结构化 SDK_COMPAT 行仍保存在 logcat.txt 中。
    }
  }

  private startLogcat(
    executionKey: string,
    logTag: string,
    signal: AbortSignal,
    onLine: (line: string) => void,
  ) {
    return this.streams.startLogcat(executionKey, logTag, signal, onLine)
  }

  private captureScreenshot(executionKey: string, targetPath: string, signal: AbortSignal) {
    return this.streams.captureScreenshot(executionKey, targetPath, signal)
  }
}
