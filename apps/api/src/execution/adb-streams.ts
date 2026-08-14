import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

import { TaskProcessRegistry } from './process-registry.js'

export type LogLineHandler = (line: string) => void
export type LogcatStreamEvent =
  | { type: 'truncated'; maxBytes: number }
  | { type: 'write_failed'; error: Error }
  | { type: 'process_exited'; code: number | null; signal: NodeJS.Signals | null; stderr: string }

const LOGCAT_TRUNCATED_MARKER = '\n[LOGCAT_TRUNCATED：日志达到大小上限，后续内容未保存]\n'

function terminate(child: ChildProcessWithoutNullStreams, killGraceMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, killGraceMs)
  timer.unref()
}

function endStream(stream: WriteStream) {
  return new Promise<void>((resolve) => {
    if (stream.closed || stream.destroyed) return resolve()
    stream.end(resolve)
  })
}

function errorFromUnknown(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

/** Owns long-running ADB streams and binary device captures for one task. */
export class AdbStreams {
  constructor(
    private readonly adbPath: string,
    private readonly deviceSerial: string,
    private readonly processes = new TaskProcessRegistry(),
    private readonly options: { maxLogBytes?: number; killGraceMs?: number } = {},
  ) {}

  async startLogcat(
    taskId: string,
    targetPath: string,
    signal: AbortSignal,
    tags: readonly string[],
    onLine: LogLineHandler,
    onEvent: (event: LogcatStreamEvent) => void = () => undefined,
    maxBytes?: number,
  ) {
    if (tags.length === 0) throw new Error('Logcat Tag 白名单不能为空')
    const maxLogBytes = Math.min(
      this.options.maxLogBytes ?? 256 * 1024 * 1024,
      maxBytes ?? Number.POSITIVE_INFINITY,
    )
    const killGraceMs = this.options.killGraceMs ?? 3000
    const child = spawn(this.adbPath, [
      '-s', this.deviceSerial, 'logcat', '-T', '1', '-v', 'threadtime',
      ...tags.map((tag) => `${tag}:V`),
      '*:S',
    ], { shell: false })
    this.processes.add(taskId, child)

    const output = createWriteStream(targetPath, { flags: 'w' })
    let writtenBytes = 0
    let stopping = false
    let captureStopped = false
    let stderr = ''
    let writeFailure: Error | undefined

    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk.toString('utf8')
    })

    const lines = readline.createInterface({ input: child.stdout })
    const stopCapture = (event: LogcatStreamEvent) => {
      if (captureStopped) return
      captureStopped = true
      onEvent(event)
      terminate(child, killGraceMs)
    }

    output.on('error', (error) => {
      writeFailure = errorFromUnknown(error)
      stopCapture({ type: 'write_failed', error: writeFailure })
    })

    lines.on('line', (line) => {
      onLine(line)
      if (captureStopped || output.destroyed) return

      const chunk = Buffer.from(`${line}\n`)
      const remaining = Math.max(0, maxLogBytes - writtenBytes)
      if (remaining > 0) {
        const saved = chunk.subarray(0, remaining)
        output.write(saved)
        writtenBytes += saved.length
      }
      if (chunk.length > remaining) {
        output.write(LOGCAT_TRUNCATED_MARKER)
        stopCapture({ type: 'truncated', maxBytes: maxLogBytes })
      }
    })

    const closed = new Promise<void>((resolve) => {
      child.once('close', (code, childSignal) => {
        if (!stopping && !captureStopped) {
          onEvent({ type: 'process_exited', code, signal: childSignal, stderr: stderr.trim() })
        }
        resolve()
      })
    })

    const startup = new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => reject(errorFromUnknown(error))
      // Keep a child error listener for the whole lifecycle. Removing the
      // startup listener after spawn would otherwise turn a later child error
      // into an unhandled EventEmitter error.
      child.once('error', fail)
      output.once('error', fail)
      child.once('spawn', () => {
        output.once('open', () => {
          output.removeListener('error', fail)
          resolve()
        })
      })
    })

    try {
      await startup
    } catch (error) {
      stopping = true
      lines.close()
      terminate(child, killGraceMs)
      output.destroy()
      this.processes.remove(taskId, child)
      throw error
    }

    const abort = () => terminate(child, killGraceMs)
    signal.addEventListener('abort', abort, { once: true })
    let stopped = false

    return async () => {
      if (stopped) return
      stopped = true
      stopping = true
      signal.removeEventListener('abort', abort)
      terminate(child, killGraceMs)
      await closed
      lines.close()
      await endStream(output)
      this.processes.remove(taskId, child)
      if (writeFailure) throw writeFailure
    }
  }

  async captureLogcatSnapshot(
    taskId: string,
    targetPath: string,
    signal: AbortSignal,
    maxBytes: number,
  ) {
    await mkdir(path.dirname(targetPath), { recursive: true })
    const killGraceMs = this.options.killGraceMs ?? 3000
    const effectiveMaxBytes = Math.min(
      this.options.maxLogBytes ?? 256 * 1024 * 1024,
      maxBytes,
    )

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.adbPath, [
        '-s', this.deviceSerial, 'logcat', '-d', '-b', 'all', '-v', 'threadtime',
      ], { shell: false })
      this.processes.add(taskId, child)
      const output = createWriteStream(targetPath, { flags: 'w' })
      let writtenBytes = 0
      let truncated = false
      let stderr = ''
      let settled = false

      child.stderr.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk.toString('utf8')
      })
      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated || output.destroyed) return
        const remaining = Math.max(0, effectiveMaxBytes - writtenBytes)
        if (remaining > 0) {
          const saved = chunk.subarray(0, remaining)
          output.write(saved)
          writtenBytes += saved.length
        }
        if (chunk.length > remaining) {
          truncated = true
          output.write(LOGCAT_TRUNCATED_MARKER)
          terminate(child, killGraceMs)
        }
      })

      const abort = () => terminate(child, killGraceMs)
      signal.addEventListener('abort', abort, { once: true })

      const finish = async (error?: Error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        this.processes.remove(taskId, child)
        if (error) {
          output.destroy()
          await rm(targetPath, { force: true }).catch(() => undefined)
          reject(error)
          return
        }
        await endStream(output)
        resolve()
      }

      child.on('error', (error) => { void finish(errorFromUnknown(error)) })
      output.on('error', (error) => {
        terminate(child, killGraceMs)
        void finish(errorFromUnknown(error))
      })
      child.on('close', (code) => {
        const failed = !truncated && code !== 0
        const detail = stderr.trim()
        void finish(failed
          ? new Error(`Logcat 失败快照采集失败（code=${code ?? 'null'}）${detail ? `：${detail}` : ''}`)
          : undefined)
      })
      if (signal.aborted) abort()
    })
  }

  async captureScreenshot(taskId: string, targetPath: string, signal: AbortSignal) {
    await mkdir(path.dirname(targetPath), { recursive: true })
    const killGraceMs = this.options.killGraceMs ?? 3000

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.adbPath, [
        '-s', this.deviceSerial, 'exec-out', 'screencap', '-p',
      ], { shell: false })
      this.processes.add(taskId, child)
      child.stderr.resume()

      const output = createWriteStream(targetPath, { flags: 'w' })
      child.stdout.pipe(output)
      const abort = () => terminate(child, killGraceMs)
      signal.addEventListener('abort', abort, { once: true })
      let settled = false

      const finish = async (error?: Error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        this.processes.remove(taskId, child)
        if (error) {
          child.stdout.unpipe(output)
          child.stdout.resume()
          output.destroy()
          await rm(targetPath, { force: true }).catch(() => undefined)
          reject(error)
          return
        }
        if (!output.closed) await new Promise<void>((done) => output.end(done))
        resolve()
      }

      child.on('error', (error) => { void finish(error) })
      output.on('error', (error) => { void finish(errorFromUnknown(error)) })
      child.on('close', (code) => {
        void finish(code === 0 ? undefined : new Error(signal.aborted ? '截图已取消' : '截图失败'))
      })
    })
  }
}
