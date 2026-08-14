import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundledMediaTools } from './media-tools.js'

export interface AppConfig {
  host: '127.0.0.1' | '::1'
  port: number
  rootDir: string
  dataDir: string
  databasePath: string
  artifactsDir: string
  tasksDir: string
  quarantineDir: string
  trashDir: string
  adbPath: string
  aaptPath: string
  ffmpegPath: string
  ffprobePath: string
  deviceSerial?: string
  maxApkBytes: number
  maxVideoBytes: number
  maxTaskVideos: number
  maxTaskInputVideoBytes: number
  minFreeDiskBytes: number
  maxConcurrentUploads: number
  maxProcessOutputBytes: number
  maxLogcatBytes: number
  processKillGraceMs: number
  pollIntervalMs: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const projectRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${name} 必须是大于 0 的整数，当前值：${raw}`)
  }
  return value
}

function loopbackHost(env: NodeJS.ProcessEnv): AppConfig['host'] {
  const value = env.API_HOST?.trim() || '127.0.0.1'
  if (value !== '127.0.0.1' && value !== '::1' && value !== 'localhost') {
    throw new ConfigError('Phase 0 仅允许本机访问，API_HOST 只能配置为 127.0.0.1、::1 或 localhost')
  }
  return value === 'localhost' ? '127.0.0.1' : value
}

function absoluteDataDir(env: NodeJS.ProcessEnv) {
  const configured = env.CLOUD_TEST_DATA_DIR?.trim()
  if (!configured) return path.join(projectRoot, 'data')
  if (!path.isAbsolute(configured)) {
    throw new ConfigError('CLOUD_TEST_DATA_DIR 必须是绝对路径，避免从不同目录启动时写入不同数据目录')
  }
  return path.normalize(configured)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const androidSdk = env.ANDROID_SDK_ROOT ?? path.join(env.HOME ?? '', 'Library/Android/sdk')
  const dataDir = absoluteDataDir(env)
  const deviceSerial = env.ADB_SERIAL?.trim() || undefined

  return {
    host: loopbackHost(env),
    port: positiveInteger(env, 'API_PORT', 3000),
    rootDir: projectRoot,
    dataDir,
    databasePath: path.join(dataDir, 'cloud-test.sqlite'),
    artifactsDir: path.join(dataDir, 'artifacts'),
    tasksDir: path.join(dataDir, 'tasks'),
    quarantineDir: path.join(dataDir, '.quarantine'),
    trashDir: path.join(dataDir, '.trash'),
    adbPath: env.ADB_PATH?.trim() || path.join(androidSdk, 'platform-tools/adb'),
    aaptPath: env.AAPT_PATH?.trim() || path.join(androidSdk, 'build-tools/36.0.0/aapt'),
    ffmpegPath: env.FFMPEG_PATH?.trim() || bundledMediaTools.ffmpegPath,
    ffprobePath: env.FFPROBE_PATH?.trim() || bundledMediaTools.ffprobePath,
    deviceSerial,
    maxApkBytes: positiveInteger(env, 'MAX_APK_BYTES', 1024 * 1024 * 1024),
    maxVideoBytes: positiveInteger(env, 'MAX_VIDEO_BYTES', 4 * 1024 * 1024 * 1024),
    maxTaskVideos: positiveInteger(env, 'MAX_TASK_VIDEOS', 10),
    maxTaskInputVideoBytes: positiveInteger(env, 'MAX_TASK_INPUT_VIDEO_BYTES', 10 * 1024 * 1024 * 1024),
    minFreeDiskBytes: positiveInteger(env, 'MIN_FREE_DISK_BYTES', 10 * 1024 * 1024 * 1024),
    maxConcurrentUploads: positiveInteger(env, 'MAX_CONCURRENT_UPLOADS', 2),
    maxProcessOutputBytes: positiveInteger(env, 'MAX_PROCESS_OUTPUT_BYTES', 4 * 1024 * 1024),
    maxLogcatBytes: positiveInteger(env, 'MAX_LOGCAT_BYTES', 256 * 1024 * 1024),
    processKillGraceMs: positiveInteger(env, 'PROCESS_KILL_GRACE_MS', 3000),
    pollIntervalMs: positiveInteger(env, 'POLL_INTERVAL_MS', 1000),
  }
}

export const config = loadConfig()
export const databasePath = config.databasePath
export const artifactsDir = config.artifactsDir
export const tasksDir = config.tasksDir
