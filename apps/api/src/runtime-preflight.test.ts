import { access, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { loadConfig } from './config.js'
import type { ProcessRunner } from './process.js'
import { assertRuntimeReady } from './runtime-preflight.js'

function testConfig(dataDir: string) {
  return loadConfig({
    ...process.env,
    CLOUD_TEST_DATA_DIR: dataDir,
    ADB_PATH: process.execPath,
    AAPT_PATH: process.execPath,
    FFMPEG_PATH: process.execPath,
    FFPROBE_PATH: process.execPath,
    MIN_FREE_DISK_BYTES: '1',
  })
}

const runner = {
  run: vi.fn(async () => ({
    command: process.execPath, args: [], exitCode: 0, signal: null,
    stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
  })),
} as unknown as ProcessRunner

describe('runtime preflight', () => {
  it('创建稳定数据子目录并报告显式设备配置', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cloud-preflight-'))
    const config = testConfig(dataDir)
    const report = await assertRuntimeReady(config, runner)

    expect(report.dataDir).toBe(dataDir)
    expect(report.configuredDeviceSerial).toBeUndefined()
    await expect(access(config.artifactsDir)).resolves.toBeUndefined()
    await expect(access(config.tasksDir)).resolves.toBeUndefined()
    await expect(access(config.quarantineDir)).resolves.toBeUndefined()
    await expect(access(config.trashDir)).resolves.toBeUndefined()
  })

  it('外部工具不存在时停止启动', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cloud-preflight-tool-'))
    const config = { ...testConfig(dataDir), adbPath: path.join(dataDir, 'missing-adb') }
    await expect(assertRuntimeReady(config, runner)).rejects.toThrow('ADB 不可执行或不存在')
  })

  it('磁盘低于阈值时停止启动', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cloud-preflight-disk-'))
    const config = { ...testConfig(dataDir), minFreeDiskBytes: Number.MAX_SAFE_INTEGER }
    await expect(assertRuntimeReady(config, runner)).rejects.toThrow('数据盘可用空间不足')
  })
})
