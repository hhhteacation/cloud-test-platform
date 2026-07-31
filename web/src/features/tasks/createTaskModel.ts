import type { TestPlatformClient, DeviceProfile, Artifact, CreateTaskInput, TestTask } from '../../types'

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
}

export interface CreateTaskSubmissionInput {
  name: string
  apkFile: File
  videoFile: File
  deviceIds: string[]
}

export interface CreateTaskSubmissionHooks {
  onStep?: (step: number) => void
  onApkUploaded?: (artifact: Artifact) => void
  onVideoUploaded?: (artifact: Artifact) => void
}

export function getSelectableDevices(
  devices: DeviceProfile[],
  mode: TestPlatformClient['mode'],
) {
  return devices
    .filter((device) => device.platform === 'android')
    .map((device) => ({
      ...device,
      selectable: device.eligible && (
        mode === 'mock'
        || (device.executionMode === 'adb' && device.connectionStatus === 'online')
      ),
    }))
}

export function getDefaultDeviceIds(
  devices: DeviceProfile[],
  mode: TestPlatformClient['mode'],
) {
  if (mode === 'real') {
    return devices
      .filter((device) => (
        device.platform === 'android'
        && device.eligible
        && device.executionMode === 'adb'
        && device.connectionStatus === 'online'
      ))
      .map((device) => device.id)
  }

  return devices
    .filter((device) => device.platform === 'android' && device.eligible)
    .map((device) => device.id)
}

export function validateCreateTaskForm(state: CreateTaskFormState): string | undefined {
  if (!state.apkFile) return '请先选择 APK 测试应用'
  if (!state.videoFile) return '请先上传 MP4 视频素材'
  if (state.devicesLoading) return '设备列表仍在加载，请稍后再试'
  if (state.devicesError) return `设备列表加载失败：${state.devicesError}`
  if (!state.deviceIds.length) return '请至少选择一台 Android 设备'
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
    testPlan: TEST_PLAN,
  })

  hooks.onStep?.(3)
  return task
}
