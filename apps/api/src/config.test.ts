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


  it('提供多视频任务数量与总输入容量配置', () => {
    const defaults = loadConfig({ HOME: '/tmp/home' })
    expect(defaults.maxTaskVideos).toBe(10)
    expect(defaults.maxTaskInputVideoBytes).toBe(10 * 1024 * 1024 * 1024)
    const overridden = loadConfig({
      HOME: '/tmp/home', MAX_TASK_VIDEOS: '6', MAX_TASK_INPUT_VIDEO_BYTES: '123456',
    })
    expect(overridden.maxTaskVideos).toBe(6)
    expect(overridden.maxTaskInputVideoBytes).toBe(123456)
  })

  it('提供可调的任务输出膨胀系数与单视频运行开销', () => {
    const defaults = loadConfig({ HOME: '/tmp/home' })
    expect(defaults.taskOutputExpansionFactor).toBe(1.5)
    expect(defaults.taskVideoRunOverheadBytes).toBe(320 * 1024 * 1024)
    const overridden = loadConfig({
      HOME: '/tmp/home', TASK_OUTPUT_EXPANSION_FACTOR: '2.25', TASK_VIDEO_RUN_OVERHEAD_BYTES: '4096',
    })
    expect(overridden.taskOutputExpansionFactor).toBe(2.25)
    expect(overridden.taskVideoRunOverheadBytes).toBe(4096)
    expect(() => loadConfig({ HOME: '/tmp/home', TASK_OUTPUT_EXPANSION_FACTOR: '0' })).toThrow(ConfigError)
  })

  it('为全量 Logcat 提供独立容量配置', () => {
    expect(loadConfig({ HOME: '/tmp/home' }).maxLogcatBytes).toBe(256 * 1024 * 1024)
    expect(loadConfig({ HOME: '/tmp/home', MAX_LOGCAT_BYTES: '8192' }).maxLogcatBytes).toBe(8192)
    expect(() => loadConfig({ HOME: '/tmp/home', MAX_LOGCAT_BYTES: '0' })).toThrow(ConfigError)
  })

  it('为 Attempt 间连接恢复提供独立 deadline', () => {
    expect(loadConfig({ HOME: '/tmp/home' }).attemptRecoveryDeadlineMs).toBe(15_000)
    expect(loadConfig({
      HOME: '/tmp/home', ATTEMPT_RECOVERY_DEADLINE_MS: '2500',
    }).attemptRecoveryDeadlineMs).toBe(2500)
    expect(() => loadConfig({
      HOME: '/tmp/home', ATTEMPT_RECOVERY_DEADLINE_MS: '0',
    })).toThrow(ConfigError)
  })

  it('为首次 Endpoint 解析提供独立 deadline', () => {
    expect(loadConfig({ HOME: '/tmp/home' }).endpointResolutionDeadlineMs).toBe(15_000)
    expect(loadConfig({
      HOME: '/tmp/home', ENDPOINT_RESOLUTION_DEADLINE_MS: '3500',
    }).endpointResolutionDeadlineMs).toBe(3500)
    expect(() => loadConfig({
      HOME: '/tmp/home', ENDPOINT_RESOLUTION_DEADLINE_MS: '0',
    })).toThrow(ConfigError)
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

  it('Managed Observation 自动采用默认关闭，只接受显式 true 或 false', () => {
    expect(loadConfig({ HOME: '/tmp/home' }).managedObservationAdoptionEnabled).toBe(false)
    expect(loadConfig({ HOME: '/tmp/home' }).managedObservationAdoptionDeviceIds).toEqual([])
    expect(loadConfig({
      HOME: '/tmp/home',
      MANAGED_OBSERVATION_ADOPTION_ENABLED: 'true',
    }).managedObservationAdoptionEnabled).toBe(true)
    expect(loadConfig({
      HOME: '/tmp/home',
      MANAGED_OBSERVATION_ADOPTION_ENABLED: 'false',
    }).managedObservationAdoptionEnabled).toBe(false)
    expect(() => loadConfig({
      HOME: '/tmp/home',
      MANAGED_OBSERVATION_ADOPTION_ENABLED: '1',
    })).toThrow(ConfigError)
  })
})
