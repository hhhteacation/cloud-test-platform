import { readFile, stat } from 'node:fs/promises'

import { buildLaunchArguments } from '../apk-protocols.js'
import type { AndroidCheckEvent, AndroidResult } from '../types.js'
import { getCheckName } from './check-names.js'
import { TaskExecutionError } from './execution-errors.js'
import {
  BaseProtocolExecutor,
  type ProtocolExecutionContext,
  type ProtocolExecutionResult,
} from './protocol-executor.js'

export function parseCarrierResult(content: string): AndroidResult {
  if (!content.trim()) {
    throw new TaskExecutionError('APK 返回的 result.json 为空', 'RESULT_INVALID')
  }

  let result: unknown
  try {
    result = JSON.parse(content)
  } catch (error) {
    throw new TaskExecutionError(
      `APK 返回的 result.json 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      'RESULT_INVALID',
    )
  }

  if (
    !result
    || typeof result !== 'object'
    || Array.isArray(result)
    || typeof (result as { taskId?: unknown }).taskId !== 'string'
    || !['passed', 'failed'].includes((result as { status?: unknown }).status as string)
  ) {
    throw new TaskExecutionError(
      'APK 返回的 result.json 缺少有效的 taskId 或 status',
      'RESULT_INVALID',
    )
  }

  return result as AndroidResult
}

export class CarrierProtocolExecutor extends BaseProtocolExecutor {
  async execute(context: ProtocolExecutionContext): Promise<ProtocolExecutionResult> {
    const { protocol, paths, signal, reporter } = context
    if (!paths.remoteResultFile) {
      throw new TaskExecutionError('协议缺少 result.json 路径', 'INVALID_TEST_APK')
    }

    let stopLogcat: (() => Promise<void>) | undefined
    let logcatWarning: string | undefined

    try {
      const inputSizeBytes = await this.prepareInput(context)
      await this.assertLogcatDiskSpace(context.local.runDirectory)
      const logTags = protocol.progress.logTags ?? [protocol.progress.logTag]

      try {
        stopLogcat = await this.startLogcat(
          context,
          logTags,
          (line) => this.consumeStructuredEvent(context, line),
          (event) => {
            logcatWarning = this.describeLogcatEvent(event)
            reporter.addLog(logcatWarning, 'warning')
          },
        )
      } catch (error) {
        logcatWarning = `LOGCAT_START_FAILED：无法启动设备业务 Logcat：${error instanceof Error ? error.message : String(error)}`
        reporter.addLog(logcatWarning, 'warning')
      }

      if (stopLogcat) reporter.addLog(`开始采集过滤业务 Logcat：${logTags.join(', ')}`)
      await this.delay(100, signal)

      reporter.update('launching_app', 35, `正在按 ${protocol.name} 启动 APK`)
      await this.adb(
        buildLaunchArguments(protocol, paths, context.taskId),
        signal,
        30_000,
        'APP_LAUNCH_FAILED',
      )
      reporter.upsertCheck({ key: 'launch', name: '应用启动', status: 'passed' })

      reporter.update('processing', 45, 'APK 已自动启动，等待真实 SDK 生成 result.json 和 output.mp4')
      await this.waitForResultJson(context)
      await this.collectCarrierResult(context)

      const output = await this.collectOutput(context, paths.remoteOutputFile)
      return { inputSizeBytes, ...output, logcatWarning }
    } catch (error) {
      if (stopLogcat) {
        await stopLogcat().catch((stopError) => {
          reporter.addLog(
            `LOGCAT_WRITE_FAILED：${stopError instanceof Error ? stopError.message : String(stopError)}`,
            'warning',
          )
        })
        stopLogcat = undefined
      }
      if (!signal.aborted && !reporter.isCancelled()) await this.captureFailureLogcat(context)
      throw error
    } finally {
      if (stopLogcat) {
        await stopLogcat().catch((error) => {
          reporter.addLog(
            `LOGCAT_WRITE_FAILED：${error instanceof Error ? error.message : String(error)}`,
            'warning',
          )
        })
      }
      await this.bestEffortDeviceRun(
        context,
        ['shell', 'am', 'force-stop', protocol.packageName],
        '执行结束时停止 APK 失败',
      )
      await this.bestEffortDeviceRun(
        context,
        ['shell', 'rm', '-rf', paths.remoteTaskRoot],
        '清理 APK 远端任务目录失败',
      )
    }
  }

  private async prepareInput(context: ProtocolExecutionContext) {
    const { paths, signal, reporter } = context
    reporter.update('transferring_input', 25, '正在准备 APK 输入目录并清理本次旧结果')
    await this.adb(['shell', 'rm', '-rf', paths.remoteTaskRoot], signal)
    await this.adb(['shell', 'mkdir', '-p', paths.remoteInputDirectory], signal)
    await this.adb([
      'shell', 'mkdir', '-p', paths.remoteOutputDirectory, `${paths.remoteTaskRoot}/result`,
    ], signal)
    await this.adb(
      ['push', context.input.localPath, paths.remoteInputFile],
      signal,
      180_000,
      'INPUT_PUSH_FAILED',
    )

    const remoteSize = await this.remoteStat(paths.remoteInputFile, signal)
    const localSize = (await stat(context.input.localPath)).size
    if (!Number.isFinite(remoteSize) || remoteSize !== localSize) {
      throw new TaskExecutionError(
        '手机端输入 MP4 大小与上传文件不一致',
        'INPUT_PUSH_FAILED',
      )
    }
    reporter.upsertCheck({
      key: 'input',
      name: '输入 MP4 校验',
      status: 'passed',
      message: `${localSize} bytes`,
    })
    return localSize
  }

  private async waitForResultJson(context: ProtocolExecutionContext) {
    const remoteResult = context.paths.remoteResultFile!
    const timeoutMs = context.configuredTimeoutSeconds * 1_000
    const startedAt = this.now()
    while (this.now() - startedAt < timeoutMs) {
      if (context.reporter.isCancelled()) {
        throw new DOMException('任务已取消', 'AbortError')
      }
      if (await this.remoteStat(remoteResult, context.signal) >= 0) return
      if (this.now() - startedAt > 2_000
        && !await this.isPackageRunning(context.protocol.packageName, context.signal)) {
        throw new TaskExecutionError(
          '测试 APK 进程已退出，且未生成 result.json',
          'APP_CRASHED',
        )
      }
      await this.delay(this.dependencies.pollIntervalMs, context.signal)
    }
    throw new TaskExecutionError(
      `超过 ${Math.round(timeoutMs / 1_000)} 秒仍未收到 result.json`,
      'TASK_TIMEOUT',
    )
  }

  private async collectCarrierResult(context: ProtocolExecutionContext) {
    await this.adb(
      ['pull', context.paths.remoteResultFile!, context.local.resultPath],
      context.signal,
      30_000,
      'RESULT_MISSING',
    )

    let content: string
    try {
      content = await readFile(context.local.resultPath, 'utf8')
    } catch (error) {
      throw new TaskExecutionError(
        `无法读取 APK 返回的 result.json：${error instanceof Error ? error.message : String(error)}`,
        'RESULT_INVALID',
        { evidenceRefs: ['result.json'], phase: 'validating_output' },
      )
    }

    let result: AndroidResult
    try {
      result = parseCarrierResult(content)
    } catch (error) {
      if (error instanceof TaskExecutionError) {
        throw new TaskExecutionError(error.message, error.code, {
          evidenceRefs: ['result.json'],
          phase: 'validating_output',
        })
      }
      throw error
    }
    if (result.taskId !== context.taskId) {
      throw new TaskExecutionError(
        'APK 返回的 taskId 与当前任务不一致',
        'RESULT_TASK_MISMATCH',
        { evidenceRefs: ['result.json'], phase: 'validating_output' },
      )
    }
    for (const check of result.checks ?? []) context.reporter.upsertCheck(check)
    if (result.status !== 'passed') {
      const vendorCode = result.failureCode
      throw new TaskExecutionError(
        `${result.failureMessage ?? '真实 SDK 视频处理失败'}${vendorCode ? `（供应商错误码：${vendorCode}）` : ''}`,
        'SDK_PROCESSING_FAILED',
        { evidenceRefs: ['result.json'], phase: 'processing' },
      )
    }
  }

  private consumeStructuredEvent(context: ProtocolExecutionContext, line: string) {
    const jsonStart = line.indexOf('{')
    if (jsonStart < 0) return
    let event: AndroidCheckEvent
    try {
      event = JSON.parse(line.slice(jsonStart)) as AndroidCheckEvent
    } catch {
      // Non-structured SDK_COMPAT lines remain in logcat.txt.
      return
    }
    if (event.taskId !== context.taskId) return
    if (event.message) context.reporter.addLog(event.message)
    if (event.checkKey && event.status && event.status !== 'running') {
      context.reporter.upsertCheck({
        key: event.checkKey,
        name: event.name ?? getCheckName(event.checkKey),
        status: event.status,
        durationMs: event.durationMs,
        message: event.message,
      })
    }
    if (typeof event.progress === 'number') {
      context.reporter.setProcessingProgress(Math.max(45, Math.min(75, event.progress)))
    }
  }
}
