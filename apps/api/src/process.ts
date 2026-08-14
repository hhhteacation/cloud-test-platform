import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_KILL_GRACE_MS = 3000

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  stdoutBytes?: number
  stderrBytes?: number
}

export interface RunProcessOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputBytes?: number
  killGraceMs?: number
  cwd?: string
  captureStdoutPath?: string
  captureStderrPath?: string
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: RunProcessOptions): Promise<ProcessResult>
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly args: string[],
    readonly result?: ProcessResult,
  ) {
    super(message)
    this.name = 'ProcessError'
  }
}

interface BoundedOutput {
  chunks: Buffer[]
  retainedBytes: number
  totalBytes: number
  truncated: boolean
}

function appendBounded(output: BoundedOutput, chunk: Buffer, maxBytes: number) {
  output.totalBytes += chunk.length
  const remaining = Math.max(0, maxBytes - output.retainedBytes)
  if (remaining > 0) {
    const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
    output.chunks.push(retained)
    output.retainedBytes += retained.length
  }
  if (chunk.length > remaining) output.truncated = true
}

function signalProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.killed) return
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try { child.kill(signal) } catch { /* 进程可能已退出。 */ }
  }
}

function createCapture(targetPath?: string) {
  return targetPath ? createWriteStream(targetPath, { flags: 'w' }) : undefined
}

async function finishCapture(capture?: WriteStream) {
  if (!capture) return
  if (!capture.writableEnded && !capture.destroyed) capture.end()
  try {
    await finished(capture)
  } catch {
    // The stream error is retained separately and converted to ProcessError
    // after stdout/stderr and process exit evidence have been assembled.
  }
}

function writeCapture(capture: WriteStream | undefined, source: Readable, chunk: Buffer) {
  if (!capture || capture.destroyed) return
  if (capture.write(chunk)) return
  source.pause()
  const resume = () => source.resume()
  capture.once('drain', resume)
  capture.once('close', resume)
}

export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, {
        shell: false,
        cwd: options.cwd,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      reject(error)
      return
    }

    const stdout: BoundedOutput = {
      chunks: [],
      retainedBytes: 0,
      totalBytes: 0,
      truncated: false,
    }
    const stderr: BoundedOutput = {
      chunks: [],
      retainedBytes: 0,
      totalBytes: 0,
      truncated: false,
    }
    let captureError: Error | undefined
    const stdoutCapture = createCapture(options.captureStdoutPath)
    const stderrCapture = createCapture(options.captureStderrPath)
    let settled = false
    let finalizing = false
    let terminationError: unknown
    let killTimer: NodeJS.Timeout | undefined

    const timeout = options.timeoutMs
      ? setTimeout(() => terminate(new ProcessError(`命令执行超时：${command}`, command, args)), options.timeoutMs)
      : undefined

    // Keep a ProcessError wrapper so the bounded stdout/stderr and exit code
    // remain available to the domain layer when cancellation interrupts adb.
    const onAbort = () => terminate(new ProcessError('命令执行已取消', command, args))

    function result(code: number): ProcessResult {
      return {
        code,
        stdout: Buffer.concat(stdout.chunks, stdout.retainedBytes).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks, stderr.retainedBytes).toString('utf8'),
        ...(stdout.truncated ? { stdoutTruncated: true } : {}),
        ...(stderr.truncated ? { stderrTruncated: true } : {}),
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
      }
    }

    function cleanup() {
      if (timeout) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    function finishReject(error: unknown) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    function terminate(error: unknown) {
      if (terminationError || settled) return
      terminationError = error
      signalProcess(child, 'SIGTERM')
      killTimer = setTimeout(() => signalProcess(child, 'SIGKILL'), killGraceMs)
    }

    for (const capture of [stdoutCapture, stderrCapture]) {
      capture?.on('error', (error) => {
        captureError ??= error
        terminate(new ProcessError(`命令 Evidence 写入失败：${error.message}`, command, args))
      })
    }

    child.stdout.on('data', (chunk: Buffer) => {
      appendBounded(stdout, chunk, maxOutputBytes)
      writeCapture(stdoutCapture, child.stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      appendBounded(stderr, chunk, maxOutputBytes)
      writeCapture(stderrCapture, child.stderr, chunk)
    })

    async function finalize(code: number, processError?: unknown) {
      if (settled || finalizing) return
      finalizing = true
      await Promise.all([finishCapture(stdoutCapture), finishCapture(stderrCapture)])
      if (settled) return
      const processResult = result(code)
      if (captureError) {
        finishReject(new ProcessError(
          `命令 Evidence 写入失败：${captureError.message}`,
          command,
          args,
          processResult,
        ))
        return
      }
      if (processError) {
        finishReject(processError)
        return
      }
      if (terminationError instanceof ProcessError) {
        finishReject(new ProcessError(terminationError.message, command, args, processResult))
        return
      }
      if (terminationError) {
        finishReject(terminationError)
        return
      }
      if (code === 0) {
        settled = true
        cleanup()
        resolve(processResult)
      } else {
        finishReject(new ProcessError(`${command} 执行失败`, command, args, processResult))
      }
    }

    child.on('error', (error) => { void finalize(-1, error) })
    child.on('close', (code) => { void finalize(code ?? -1) })

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
  })
}

export class BoundedProcessRunner implements ProcessRunner {
  constructor(private readonly defaults: Pick<RunProcessOptions, 'maxOutputBytes' | 'killGraceMs'> = {}) {}

  run(command: string, args: string[], options: RunProcessOptions = {}) {
    return runProcess(command, args, { ...this.defaults, ...options })
  }
}
