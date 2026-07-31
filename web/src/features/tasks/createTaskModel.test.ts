import { describe, expect, it, vi } from 'vitest'

import type { Artifact, DeviceProfile, TestPlatformClient } from '../../types'
import {
  createTaskWithUploads,
  getDefaultDeviceIds,
  getSelectableDevices,
  validateCreateTaskForm,
} from './createTaskModel'

const devices: DeviceProfile[] = [
  {
    platform: 'android', id: 'honor-magic-v3', name: '荣耀 Magic V3', manufacturer: 'HONOR',
    osVersion: 'Android 16', apiLevel: 36, architecture: 'arm64-v8a',
    executionMode: 'adb', eligible: true, connectionStatus: 'offline',
  },
  {
    platform: 'android', id: 'pixel-8', name: 'Pixel 8', manufacturer: 'Google',
    osVersion: 'Android 14', apiLevel: 34, architecture: 'arm64-v8a',
    executionMode: 'simulated', eligible: true, connectionStatus: 'unknown',
  },
  {
    platform: 'harmonyos', id: 'mate-x5', name: '华为 Mate X5', manufacturer: 'HUAWEI',
    osVersion: 'HarmonyOS 4.2', apiLevel: 34, architecture: 'arm64-v8a',
    executionMode: 'simulated', eligible: false, connectionStatus: 'unknown',
  },
]

function file(name: string, type: string) {
  return new File(['content'], name, { type })
}

function artifact(kind: 'apk' | 'video', id: string): Artifact {
  return { id, kind, name: `${id}.${kind === 'apk' ? 'apk' : 'mp4'}`, sizeBytes: 7, mimeType: kind === 'apk' ? 'application/vnd.android.package-archive' : 'video/mp4' }
}

describe('createTaskModel', () => {
  it('disables offline real devices and does not select them by default', () => {
    expect(getSelectableDevices(devices, 'real').filter((device) => device.selectable)).toEqual([])
    expect(getDefaultDeviceIds(devices, 'real')).toEqual([])
  })

  it('selects all eligible devices in mock mode', () => {
    expect(getDefaultDeviceIds(devices, 'mock')).toEqual(['honor-magic-v3', 'pixel-8'])
  })

  it('validates required inputs without checking physical connection', () => {
    expect(validateCreateTaskForm({ apkFile: undefined, videoFile: file('a.mp4', 'video/mp4'), deviceIds: ['honor-magic-v3'], devices, devicesLoading: false })).toBe('请先选择 APK 测试应用')
    expect(validateCreateTaskForm({ apkFile: file('a.apk', 'application/vnd.android.package-archive'), videoFile: undefined, deviceIds: ['honor-magic-v3'], devices, devicesLoading: false })).toBe('请先上传 MP4 视频素材')
    expect(validateCreateTaskForm({ apkFile: file('a.apk', 'application/vnd.android.package-archive'), videoFile: file('a.mp4', 'video/mp4'), deviceIds: ['honor-magic-v3'], devices, devicesLoading: false })).toBeUndefined()
  })

  it('uploads APK before MP4 and creates a task with returned artifact IDs', async () => {
    const steps: number[] = []
    const client: TestPlatformClient = {
      mode: 'real',
      listDevices: vi.fn(), discoverDevices: vi.fn(), registerDevice: vi.fn(),
      uploadArtifact: vi.fn(async (_file, kind) => artifact(kind, `${kind}-1`)),
      createTask: vi.fn(async (input) => ({
        id: 'task-1',
    platform: 'android' as const, name: input.name, apk: artifact('apk', input.apkArtifactId), asset: artifact('video', input.videoArtifactId),
        deviceIds: input.deviceIds, status: 'queued' as const, progress: 0, createdAt: new Date().toISOString(), runs: {},
        capabilities: { canCancel: true, canDelete: false, deleteBlockedReason: '任务正在排队，请先取消任务' },
      })),
      listTasks: vi.fn(), getTask: vi.fn(), subscribeTask: vi.fn(), getReport: vi.fn(), cancelTask: vi.fn(), deleteTask: vi.fn(),
    }

    const task = await createTaskWithUploads(client, {
      name: 'test', apkFile: file('test.apk', 'application/vnd.android.package-archive'), videoFile: file('test.mp4', 'video/mp4'), deviceIds: ['honor-magic-v3'],
    }, { onStep: (step) => steps.push(step) })

    expect(steps).toEqual([0, 1, 2, 3])
    expect(client.uploadArtifact).toHaveBeenNthCalledWith(1, expect.any(File), 'apk')
    expect(client.uploadArtifact).toHaveBeenNthCalledWith(2, expect.any(File), 'video')
    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({ apkArtifactId: 'apk-1', videoArtifactId: 'video-1' }))
    expect(task.id).toBe('task-1')
  })
})
