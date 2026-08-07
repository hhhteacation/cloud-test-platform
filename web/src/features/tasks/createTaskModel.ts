import type { TestPlatformClient, DeviceProfile, Artifact, CreateTaskInput, TestTask, TaskConnectionMode } from '../../types'

export const TEST_NOTES = [
  '真实模式可同时选择多台已录入、在线并授权的 Android USB 真机',
  '后端会根据 APK 包名选择对应的输入、启动、进度、输出和取消协议',
  '当前已识别 com.sdktest.platform 与 com.morphoinc.videopostprocessor',
] as const

export const TEST_PLAN: CreateTaskInput['testPlan'] = {
  type: 'sdk-video-processing-compatibility',
  // Morpho 官方 Demo 脚本没有短超时；平台采用兼容测试脚本的 15 分钟上限。
  timeoutSeconds: 900,
}

export interface CreateTaskFormState {
  apkFile?: File
  videoFile?: File
  deviceIds: string[]
  devices: DeviceProfile[]
  devicesLoading: boolean
  devicesError?: string
  connectionMode?: TaskConnectionMode
  platformMode?: TestPlatformClient['mode']
}

export interface CreateTaskSubmissionInput {
  name: string
  apkFile: File
  videoFile: File
  deviceIds: string[]
  connectionMode: TaskConnectionMode
}

export interface CreateTaskSubmissionHooks {
  onStep?: (step: number) => void
  onApkUploaded?: (artifact: Artifact) => void
  onVideoUploaded?: (artifact: Artifact) => void
}


export function isDeviceAvailableForMode(
  device: DeviceProfile,
  connectionMode: TaskConnectionMode,
  platformMode: TestPlatformClient['mode'],
) {
  if (!device.eligible) return false
  if (platformMode === 'real' && device.executionMode !== 'adb') return false
  if (platformMode === 'mock' && !device.endpoints) return true
  const legacyOnline = device.connectionStatus === 'online'
  const usbOnline = device.endpoints?.usb?.status === 'online' || (!device.endpoints && legacyOnline)
  const networkOnline = device.endpoints?.network?.status === 'online'
  return connectionMode === 'usb' ? usbOnline : connectionMode === 'network' ? networkOnline : usbOnline || networkOnline
}

export function getSelectableDevices(
  devices: DeviceProfile[],
  mode: TestPlatformClient['mode'],
) {
  return devices
    .filter((device) => device.platform === 'android')
    .map((device) => ({
      ...device,
      selectable: isDeviceAvailableForMode(device, 'auto', mode),
    }))
}

export function getDefaultDeviceIds(
  devices: DeviceProfile[],
  mode: TestPlatformClient['mode'],
) {
  return devices
    .filter((device) => (
      device.platform === 'android'
      && device.eligible
      && isDeviceAvailableForMode(device, 'auto', mode)
    ))
    .map((device) => device.id)
}

export function validateCreateTaskForm(state: CreateTaskFormState): string | undefined {
  if (!state.apkFile) return '请先选择 APK 测试应用'
  if (!state.videoFile) return '请先上传 MP4 视频素材'
  if (state.devicesLoading) return '设备列表仍在加载，请稍后再试'
  if (state.devicesError) return `设备列表加载失败：${state.devicesError}`
  if (!state.deviceIds.length) return '请至少选择一台 Android 设备'
  const connectionMode = state.connectionMode ?? 'auto'
  const platformMode = state.platformMode ?? 'real'
  const unavailable = state.deviceIds
    .map((deviceId) => state.devices.find((device) => device.id === deviceId))
    .find((device) => !device || !isDeviceAvailableForMode(device, connectionMode, platformMode))
  if (unavailable === undefined && state.deviceIds.some((deviceId) => !state.devices.some((device) => device.id === deviceId))) {
    return '已选择的设备已不存在，请刷新设备列表后重新确认'
  }
  if (unavailable) {
    const modeLabel = connectionMode === 'usb' ? 'USB' : connectionMode === 'network' ? '联网' : 'USB 或联网'
    return `${unavailable.name} 当前没有可用的${modeLabel}连接，请调整连接方式或刷新设备状态`
  }
  return undefined
}

export async function createTaskWithUploads(
  client: TestPlatformClient,
  input: CreateTaskSubmissionInput,
  hooks: CreateTaskSubmissionHooks = {},
): Promise<TestTask> {
  hooks.onStep?.(0)
  const apk: Artifact = await client.uploadArtifact(input.apkFile, 'apk')
  hooks.onApkUploaded?.(apk)

  hooks.onStep?.(1)
  const video: Artifact = await client.uploadArtifact(input.videoFile, 'video')
  hooks.onVideoUploaded?.(video)

  hooks.onStep?.(2)
  const task = await client.createTask({
    platform: 'android',
    name: input.name,
    apkArtifactId: apk.id,
    videoArtifactId: video.id,
    deviceIds: input.deviceIds,
    connectionMode: input.connectionMode,
    testPlan: TEST_PLAN,
  })

  hooks.onStep?.(3)
  return task
}
