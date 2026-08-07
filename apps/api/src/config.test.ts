import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from './config.js'

describe('AppConfig', () => {
  it('默认数据目录不依赖 process.cwd()', () => {
    const first = loadConfig({ HOME: '/tmp/home' })
    const previous = process.cwd()
    process.chdir('/tmp')
    try {
      const second = loadConfig({ HOME: '/tmp/home' })
      expect(second.dataDir).toBe(first.dataDir)
      expect(path.isAbsolute(second.dataDir)).toBe(true)
    } finally {
      process.chdir(previous)
    }
  })

  it('拒绝相对数据目录', () => {
    expect(() => loadConfig({ CLOUD_TEST_DATA_DIR: './data' })).toThrow(ConfigError)
  })

  it('拒绝非本机监听地址', () => {
    expect(() => loadConfig({ API_HOST: '0.0.0.0' })).toThrow(/仅允许本机访问/)
  })

  it('没有显式 ADB_SERIAL 时不提供默认真机', () => {
    expect(loadConfig({ HOME: '/tmp/home' }).deviceSerial).toBeUndefined()
  })

  it('默认使用项目内置的 FFmpeg 和 FFprobe', () => {
    const value = loadConfig({ HOME: '/tmp/home' })
    expect(path.isAbsolute(value.ffmpegPath)).toBe(true)
    expect(path.basename(value.ffmpegPath)).toBe('ffmpeg')
    expect(path.isAbsolute(value.ffprobePath)).toBe(true)
    expect(path.basename(value.ffprobePath)).toBe('ffprobe')
  })


  it('为全量 Logcat 提供独立容量配置', () => {
    expect(loadConfig({ HOME: '/tmp/home' }).maxLogcatBytes).toBe(256 * 1024 * 1024)
    expect(loadConfig({ HOME: '/tmp/home', MAX_LOGCAT_BYTES: '8192' }).maxLogcatBytes).toBe(8192)
    expect(() => loadConfig({ HOME: '/tmp/home', MAX_LOGCAT_BYTES: '0' })).toThrow(ConfigError)
  })

  it('允许通过环境变量覆盖媒体工具路径', () => {
    const value = loadConfig({
      HOME: '/tmp/home',
      FFMPEG_PATH: '/custom/bin/ffmpeg',
      FFPROBE_PATH: '/custom/bin/ffprobe',
    })
    expect(value.ffmpegPath).toBe('/custom/bin/ffmpeg')
    expect(value.ffprobePath).toBe('/custom/bin/ffprobe')
  })
})
