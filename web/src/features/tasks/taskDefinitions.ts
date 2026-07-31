import type { CheckDefinition, CheckResult, DeviceProfile } from '../../types'

/**
 * The checks are part of the video-processing test plan, not a UI constant.
 * Keeping them in the task feature makes the plan reusable by pages and runners.
 */
export const CHECKS: CheckDefinition[] = [
  { key: 'launch', name: '应用启动' },
  { key: 'load', name: '视频文件加载' },
  { key: 'first-frame', name: '首帧展示' },
  { key: 'play', name: '开始播放' },
  { key: 'continuous', name: '连续播放' },
  { key: 'pause', name: '暂停 / 恢复' },
  { key: 'seek', name: '进度拖动' },
  { key: 'loop', name: '循环播放' },
  { key: 'rotation', name: '横竖屏旋转' },
  { key: 'complete', name: '播放完成' },
]

/** Device profiles shown by the first version of the task feature. */
export const DEVICES: DeviceProfile[] = [
  {
    platform: 'android', id: 'honor-magic-v3', name: '荣耀 Magic V3', manufacturer: 'HONOR',
    osVersion: 'Android 16', apiLevel: 36, architecture: 'arm64-v8a',
    executionMode: 'adb', eligible: true,
  },
  {
    platform: 'android', id: 'honor-x50', name: '荣耀 X50', manufacturer: 'HONOR',
    osVersion: 'Android 15 / MagicOS 9.0', apiLevel: 35, architecture: 'arm64-v8a',
    executionMode: 'simulated', eligible: true,
  },
  {
    platform: 'android', id: 'xiaomi-15-pro', name: '小米 15 Pro', manufacturer: 'Xiaomi',
    osVersion: 'Android 15', apiLevel: 35, architecture: 'arm64-v8a',
    executionMode: 'simulated', eligible: true,
  },
  {
    platform: 'android', id: 'vivo-x200-pro', name: 'vivo X200 Pro', manufacturer: 'vivo',
    osVersion: 'Android 15 / OriginOS 5', apiLevel: 35, architecture: 'arm64-v8a',
    executionMode: 'simulated', eligible: true,
  },
  {
    platform: 'harmonyos', id: 'huawei-mate-x5', name: '华为 Mate X5', manufacturer: 'HUAWEI',
    osVersion: 'HarmonyOS 4.2', apiLevel: 34, architecture: 'arm64-v8a',
    executionMode: 'simulated', eligible: false,
  },
  {
    platform: 'android', id: 'pixel-8', name: 'Pixel 8', manufacturer: 'Google',
    osVersion: 'Android 14', apiLevel: 34, architecture: 'arm64-v8a',
    executionMode: 'simulated', eligible: true,
  },
]

export const DEFAULT_DEVICE_IDS = DEVICES.filter((device) => device.eligible).map((device) => device.id)

export function createSeedRun(deviceId: string) {
  return {
    deviceId,
    status: 'passed' as const,
    progress: 100,
    checks: CHECKS.map((check): CheckResult => ({
      ...check,
      status: 'passed',
      durationMs: 320,
    })),
    logs: ['任务已完成', '所有播放链路检查通过'],
    outputs: [],
    mode: '模拟结果' as const,
  }
}
