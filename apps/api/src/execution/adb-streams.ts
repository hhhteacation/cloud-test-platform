import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

import { config } from '../config.js'
import { TaskProcessRegistry } from './process-registry.js'

export type LogLineHandler = (line: string) => void

/** Owns long-running ADB streams and binary device captures for one task. */
export class AdbStreams {
  constructor(
    private readonly adbPath = config.adbPath,
    private readonly deviceSerial = config.deviceSerial,
    private readonly processes = new TaskProcessRegistry(),
  ) {}

  startLogcat(
    taskId: string,
    logTag: string,
    signal: AbortSignal,
    onLine: LogLineHandler,
  ) {
    const child = spawn(this.adbPath, [
      '-s', this.deviceSerial, 'logcat', '-v', 'brief', `${logTag}:V`, '*:S',
    ], { shell: false })
    this.processes.add(taskId, child)

    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', onLine)

    const abort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', abort, { once: true })

    return async () => {
      signal.removeEventListener('abort', abort)
      lines.close()
      child.kill('SIGTERM')
      this.processes.remove(taskId, child)
    }
  }

  async captureScreenshot(taskId: string, targetPath: string, signal: AbortSignal) {
    await mkdir(path.dirname(targetPath), { recursive: true })

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.adbPath, [
        '-s', this.deviceSerial, 'exec-out', 'screencap', '-p',
      ], { shell: false })
      this.processes.add(taskId, child)

      const output = createWriteStream(targetPath)
      child.stdout.pipe(output)
      const abort = () => child.kill('SIGTERM')
      signal.addEventListener('abort', abort, { once: true })

      const finish = (error?: Error) => {
        signal.removeEventListener('abort', abort)
        this.processes.remove(taskId, child)
        if (error) reject(error)
        else resolve()
      }

      child.on('error', (error) => finish(error))
      child.on('close', (code) => {
        if (code === 0) finish()
        else finish(new Error('截图失败'))
      })
    })
  }
}
