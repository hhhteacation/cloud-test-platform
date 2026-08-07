import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_KILL_GRACE_MS = 3000

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

export interface RunProcessOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputBytes?: number
  killGraceMs?: number
  cwd?: string
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

function boundedAppend(current: string, chunk: Buffer, maxBytes: number) {
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(current))
  if (remaining === 0) return { value: current, truncated: true }
  if (chunk.length <= remaining) return { value: current + chunk.toString('utf8'), truncated: false }
  return { value: current + chunk.subarray(0, remaining).toString('utf8'), truncated: true }
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

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let settled = false
    let terminationError: unknown
    let killTimer: NodeJS.Timeout | undefined

    const timeout = options.timeoutMs
      ? setTimeout(() => terminate(new ProcessError(`命令执行超时：${command}`, command, args)), options.timeoutMs)
      : undefined

    const onAbort = () => terminate(new DOMException('任务已取消', 'AbortError'))

    function result(code: number): ProcessResult {
      return {
        code,
        stdout,
        stderr,
        ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
        ...(stderrTruncated ? { stderrTruncated: true } : {}),
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

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()

    child.stdout.on('data', (chunk: Buffer) => {
      const appended = boundedAppend(stdout, chunk, maxOutputBytes)
      stdout = appended.value
      stdoutTruncated ||= appended.truncated
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const appended = boundedAppend(stderr, chunk, maxOutputBytes)
      stderr = appended.value
      stderrTruncated ||= appended.truncated
    })
    child.on('error', finishReject)
    child.on('close', (code) => {
      if (settled) return
      const processResult = result(code ?? -1)
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
    })
  })
}

export class BoundedProcessRunner implements ProcessRunner {
  constructor(private readonly defaults: Pick<RunProcessOptions, 'maxOutputBytes' | 'killGraceMs'> = {}) {}

  run(command: string, args: string[], options: RunProcessOptions = {}) {
    return runProcess(command, args, { ...this.defaults, ...options })
  }
}
