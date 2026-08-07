import { describe, expect, it, vi } from 'vitest'

import type { Artifact, DeviceProfile, TestPlatformClient } from '../../types'
import {
  createTaskWithUploads,
  getDefaultDeviceIds,
  getSelectableDevices,
  isDeviceAvailableForMode,
  validateCreateTaskForm,
} from './createTaskModel'

const devices: DeviceProfile[] = [
  {
    platform: 'android', id: 'honor-magic-v3', name: '荣耀 Magic V3', manufacturer: 'HONOR', model: 'FCP-AN10',
    osVersion: 'Android 16', apiLevel: 36, architecture: 'arm64-v8a',
    executionMode: 'adb', eligible: true, connectionStatus: 'offline',
    endpoints: {
      usb: { id: 'usb-honor', deviceId: 'honor-magic-v3', kind: 'usb', adbSerial: 'HONOR-USB', status: 'offline' },
      network: { id: 'network-honor', deviceId: 'honor-magic-v3', kind: 'network', adbSerial: '192.0.2.10:5555', host: '192.0.2.10', port: 5555, status: 'online' },
    },
  },
  {
    platform: 'android', id: 'pixel-8', name: 'Pixel 8', manufacturer: 'Google',
    osVersion: 'Android 14', apiLevel: 34, architecture: 'arm64-v8a',
    executionMode: 'adb', eligible: true, connectionStatus: 'online',
    endpoints: {
      usb: { id: 'usb-pixel', deviceId: 'pixel-8', kind: 'usb', adbSerial: 'PIXEL-USB', status: 'online' },
    },
    queueStatus: 'running',
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
  it('根据 auto、usb、network 模式计算物理设备可用性，忙碌设备仍可排队', () => {
    expect(isDeviceAvailableForMode(devices[0], 'auto', 'real')).toBe(true)
    expect(isDeviceAvailableForMode(devices[0], 'usb', 'real')).toBe(false)
    expect(isDeviceAvailableForMode(devices[0], 'network', 'real')).toBe(true)
    expect(isDeviceAvailableForMode(devices[1], 'usb', 'real')).toBe(true)
    expect(isDeviceAvailableForMode(devices[1], 'network', 'real')).toBe(false)
    expect(devices[1].queueStatus).toBe('running')
  })

  it('默认选择所有 auto 模式可用的 Android 物理设备', () => {
    expect(getSelectableDevices(devices, 'real').filter((device) => device.selectable).map((device) => device.id)).toEqual(['honor-magic-v3', 'pixel-8'])
    expect(getDefaultDeviceIds(devices, 'real')).toEqual(['honor-magic-v3', 'pixel-8'])
  })

  it('Mock 无 Endpoint 的旧设备仍保持兼容', () => {
    const legacyMock = [{ ...devices[1], endpoints: undefined, executionMode: 'simulated' as const, connectionStatus: 'unknown' as const }]
    expect(getDefaultDeviceIds(legacyMock, 'mock')).toEqual(['pixel-8'])
  })

  it('Mock 有 Endpoint 时默认只选择 auto 模式可用设备', () => {
    expect(getDefaultDeviceIds(devices, 'mock')).toEqual(['honor-magic-v3', 'pixel-8'])
  })

  it('校验必填项，并阻止已选设备与连接模式冲突', () => {
    const base = { devices, devicesLoading: false, platformMode: 'real' as const, connectionMode: 'usb' as const }
    expect(validateCreateTaskForm({ ...base, apkFile: undefined, videoFile: file('a.mp4', 'video/mp4'), deviceIds: ['pixel-8'] })).toBe('请先选择 APK 测试应用')
    expect(validateCreateTaskForm({ ...base, apkFile: file('a.apk', 'application/vnd.android.package-archive'), videoFile: undefined, deviceIds: ['pixel-8'] })).toBe('请先上传 MP4 视频素材')
    expect(validateCreateTaskForm({ ...base, apkFile: file('a.apk', 'application/vnd.android.package-archive'), videoFile: file('a.mp4', 'video/mp4'), deviceIds: ['honor-magic-v3'] })).toContain('当前没有可用的USB连接')
    expect(validateCreateTaskForm({ ...base, apkFile: file('a.apk', 'application/vnd.android.package-archive'), videoFile: file('a.mp4', 'video/mp4'), deviceIds: ['pixel-8'] })).toBeUndefined()
  })

  it('上传 APK、MP4 后创建带 connectionMode 的任务', async () => {
    const steps: number[] = []
    const client: TestPlatformClient = {
      mode: 'real',
      listDevices: vi.fn(), refreshDevices: vi.fn(), discoverDevices: vi.fn(), discoverNetworkDevices: vi.fn(), registerDevice: vi.fn(),
      connectNetworkDevice: vi.fn(), disconnectNetworkDevice: vi.fn(), refreshNetworkDevice: vi.fn(), removeNetworkDevice: vi.fn(),
      uploadArtifact: vi.fn(async (_file, kind) => artifact(kind, `${kind}-1`)),
      createTask: vi.fn(async (input) => ({
        id: 'task-1', platform: 'android' as const, name: input.name,
        apk: artifact('apk', input.apkArtifactId), asset: artifact('video', input.videoArtifactId),
        deviceIds: input.deviceIds, connectionMode: input.connectionMode,
        status: 'queued' as const, progress: 0, createdAt: new Date().toISOString(), runs: {},
        capabilities: { canCancel: true, canDelete: false, deleteBlockedReason: '任务正在排队，请先取消任务' },
      })),
      listTasks: vi.fn(), getTask: vi.fn(), subscribeTask: vi.fn(), getReport: vi.fn(), cancelTask: vi.fn(), deleteTask: vi.fn(),
    }

    const task = await createTaskWithUploads(client, {
      name: 'test', apkFile: file('test.apk', 'application/vnd.android.package-archive'),
      videoFile: file('test.mp4', 'video/mp4'), deviceIds: ['honor-magic-v3'], connectionMode: 'network',
    }, { onStep: (step) => steps.push(step) })

    expect(steps).toEqual([0, 1, 2, 3])
    expect(client.uploadArtifact).toHaveBeenNthCalledWith(1, expect.any(File), 'apk')
    expect(client.uploadArtifact).toHaveBeenNthCalledWith(2, expect.any(File), 'video')
    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({
      apkArtifactId: 'apk-1', videoArtifactId: 'video-1', connectionMode: 'network',
    }))
    expect(task.id).toBe('task-1')
  })
})
