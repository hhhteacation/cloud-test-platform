import type { TestTask } from '../types'
import { getTaskCapabilities } from '../features/tasks/taskCapabilities'
import { createSeedRun, CHECKS, DEFAULT_DEVICE_IDS, DEVICES } from '../features/tasks/taskDefinitions'

// Kept as a compatibility facade for existing imports. New task code should import
// from features/tasks/taskDefinitions instead.
export { CHECKS, DEFAULT_DEVICE_IDS, DEVICES }

export const seedTask: TestTask = {
  id: 'task-seed-001',
  platform: 'android',
  name: 'input.mp4 Android 播放链路兼容性',
  asset: {
    id: 'asset-input',
    kind: 'video',
    name: 'input.mp4',
    sizeBytes: 36 * 1024 * 1024,
    mimeType: 'video/mp4',
    previewUrl: '/input.mp4',
  },
  deviceIds: DEFAULT_DEVICE_IDS,
  status: 'passed',
  progress: 100,
  passRate: 100,
  createdAt: '2026-07-29T10:18:00.000Z',
  capabilities: getTaskCapabilities('passed'),
  runs: Object.fromEntries(DEFAULT_DEVICE_IDS.map((deviceId) => [deviceId, createSeedRun(deviceId)])),
}
