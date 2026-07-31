import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly args: string[],
    readonly result?: ProcessResult,
  ) {
    super(message)
  }
}

export function runProcess(
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, { shell: false })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM')
          finishReject(new ProcessError(`命令执行超时：${command}`, command, args))
        }, options.timeoutMs)
      : undefined

    const onAbort = () => {
      child.kill('SIGTERM')
      finishReject(new DOMException('任务已取消', 'AbortError'))
    }

    function cleanup() {
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
    }

    function finishReject(error: unknown) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) {
      onAbort()
      return
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', finishReject)
    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      const result = { code: code ?? -1, stdout, stderr }
      if (code === 0) resolve(result)
      else reject(new ProcessError(`${command} 执行失败`, command, args, result))
    })
  })
}
