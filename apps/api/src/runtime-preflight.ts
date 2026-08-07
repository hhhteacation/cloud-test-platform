import { constants } from 'node:fs'
import { access, mkdir, statfs } from 'node:fs/promises'

import type { AppConfig } from './config.js'
import type { ProcessRunner } from './process.js'

export interface RuntimePreflightReport {
  dataDir: string
  availableDiskBytes: number
  configuredDeviceSerial?: string
}

async function assertExecutable(filePath: string, label: string) {
  if (!filePath.includes('/')) return
  try {
    await access(filePath, constants.X_OK)
  } catch {
    throw new Error(`${label} 不可执行或不存在：${filePath}`)
  }
}

async function assertTool(runner: ProcessRunner, command: string, args: string[], label: string) {
  try {
    await runner.run(command, args, { timeoutMs: 10_000 })
  } catch (error) {
    throw new Error(`${label} 启动检查失败（${command}）：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function assertRuntimeReady(config: AppConfig, runner: ProcessRunner): Promise<RuntimePreflightReport> {
  await mkdir(config.dataDir, { recursive: true })
  await Promise.all([
    mkdir(config.artifactsDir, { recursive: true }),
    mkdir(config.tasksDir, { recursive: true }),
    mkdir(config.quarantineDir, { recursive: true }),
    mkdir(config.trashDir, { recursive: true }),
  ])

  const disk = await statfs(config.dataDir)
  const availableDiskBytes = disk.bavail * disk.bsize
  if (availableDiskBytes < config.minFreeDiskBytes) {
    throw new Error(`数据盘可用空间不足：当前 ${availableDiskBytes} 字节，最低要求 ${config.minFreeDiskBytes} 字节`)
  }

  await Promise.all([
    assertExecutable(config.adbPath, 'ADB'),
    assertExecutable(config.aaptPath, 'AAPT'),
    assertExecutable(config.ffmpegPath, 'FFmpeg'),
    assertExecutable(config.ffprobePath, 'FFprobe'),
  ])
  await Promise.all([
    assertTool(runner, config.adbPath, ['version'], 'ADB'),
    assertTool(runner, config.aaptPath, ['version'], 'AAPT'),
    assertTool(runner, config.ffmpegPath, ['-version'], 'FFmpeg'),
    assertTool(runner, config.ffprobePath, ['-version'], 'FFprobe'),
  ])

  return { dataDir: config.dataDir, availableDiskBytes, configuredDeviceSerial: config.deviceSerial }
}
