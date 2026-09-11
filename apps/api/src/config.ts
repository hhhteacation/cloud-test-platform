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
  taskOutputExpansionFactor?: number
  taskVideoRunOverheadBytes?: number
  maxProcessOutputBytes: number
  maxLogcatBytes: number
  processKillGraceMs: number
  endpointResolutionDeadlineMs: number
  attemptRecoveryDeadlineMs: number
  pollIntervalMs: number
  managedObservationAdoptionEnabled: boolean
  managedObservationAdoptionDeviceIds?: string[]
  /**
   * Files in this directory are pushed into the Morpho VideoStabilizerDataPack
   * directory before every attempt (the demo batch_process.sh only pushes the
   * MP4; vendor configs such as morpho_video_denoiser_setting.xml are pushed
   * by hand in manual tests). A missing directory means stabilizer-only runs.
   */
  morphoDataPackAssetsDir: string
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

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} 必须是大于 0 的数字，当前值：${raw}`)
  }
  return value
}

function strictBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean) {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = raw.trim().toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ConfigError(`${name} 必须显式配置为 true 或 false，当前值：${raw}`)
}

function csvValues(env: NodeJS.ProcessEnv, name: string) {
  return (env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean)
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

function absoluteDirectory(env: NodeJS.ProcessEnv, name: string, fallback: string) {
  const configured = env[name]?.trim()
  if (!configured) return fallback
  if (!path.isAbsolute(configured)) {
    throw new ConfigError(`${name} 必须是绝对路径，当前值：${configured}`)
  }
  return path.normalize(configured)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const androidSdk = env.ANDROID_SDK_ROOT ?? path.join(env.HOME ?? '', 'Library/Android/sdk')
  const dataDir = absoluteDataDir(env)
  const deviceSerial = env.ADB_SERIAL?.trim() || undefined
  const maxLogcatBytes = positiveInteger(env, 'MAX_LOGCAT_BYTES', 256 * 1024 * 1024)

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
    taskOutputExpansionFactor: positiveNumber(env, 'TASK_OUTPUT_EXPANSION_FACTOR', 1.5),
    taskVideoRunOverheadBytes: positiveInteger(env, 'TASK_VIDEO_RUN_OVERHEAD_BYTES', maxLogcatBytes + 64 * 1024 * 1024),
    maxProcessOutputBytes: positiveInteger(env, 'MAX_PROCESS_OUTPUT_BYTES', 4 * 1024 * 1024),
    maxLogcatBytes,
    processKillGraceMs: positiveInteger(env, 'PROCESS_KILL_GRACE_MS', 3000),
    endpointResolutionDeadlineMs: positiveInteger(env, 'ENDPOINT_RESOLUTION_DEADLINE_MS', 15_000),
    attemptRecoveryDeadlineMs: positiveInteger(env, 'ATTEMPT_RECOVERY_DEADLINE_MS', 15_000),
    pollIntervalMs: positiveInteger(env, 'POLL_INTERVAL_MS', 1000),
    managedObservationAdoptionEnabled: strictBoolean(env, 'MANAGED_OBSERVATION_ADOPTION_ENABLED', false),
    managedObservationAdoptionDeviceIds: csvValues(env, 'MANAGED_OBSERVATION_ADOPTION_DEVICE_IDS'),
    morphoDataPackAssetsDir: absoluteDirectory(
      env,
      'MORPHO_DATA_PACK_ASSETS_DIR',
      path.join(dataDir, 'morpho-data-pack-assets'),
    ),
  }
}

export const config = loadConfig()
export const databasePath = config.databasePath
export const artifactsDir = config.artifactsDir
export const tasksDir = config.tasksDir
