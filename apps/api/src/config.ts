import path from 'node:path'

const rootDir = process.cwd()
const androidSdk = process.env.ANDROID_SDK_ROOT ?? path.join(process.env.HOME ?? '', 'Library/Android/sdk')

export const config = {
  host: '127.0.0.1',
  port: Number(process.env.API_PORT ?? 3000),
  rootDir,
  dataDir: path.resolve(process.env.CLOUD_TEST_DATA_DIR ?? path.join(rootDir, 'data')),
  adbPath: process.env.ADB_PATH ?? path.join(androidSdk, 'platform-tools/adb'),
  aaptPath: process.env.AAPT_PATH ?? path.join(androidSdk, 'build-tools/36.0.0/aapt'),
  deviceSerial: process.env.ADB_SERIAL ?? 'A2AV024719001034',
  maxApkBytes: Number(process.env.MAX_APK_BYTES ?? 1024 * 1024 * 1024),
  maxVideoBytes: Number(process.env.MAX_VIDEO_BYTES ?? 4 * 1024 * 1024 * 1024),
  pollIntervalMs: 1000,
} as const

export const databasePath = path.join(config.dataDir, 'cloud-test.sqlite')
export const artifactsDir = path.join(config.dataDir, 'artifacts')
export const tasksDir = path.join(config.dataDir, 'tasks')
