import { describe, expect, it, vi } from 'vitest'

import type { AppConfig } from '../config.js'
import type { PlatformDatabase } from '../database.js'
import type { DeviceRegistryService } from '../devices/device-registry.js'
import { DeviceQueueManager, QueueNotAcceptingError } from '../queue.js'
import { TaskService } from './task-service.js'

function artifactsDatabase(createTask = vi.fn((input) => ({ id: 'task-1', ...input }))) {
  return {
    getArtifact(id: string) {
      if (id === 'apk') return { id, kind: 'apk', packageName: 'com.sdktest.platform' }
      if (id === 'video' || id === 'video-2') return { id, kind: 'video', originalName: `${id}.mp4`, sizeBytes: id === 'video' ? 100 : 200, sha256: id }
      return undefined
    },
    createTask,
  } as unknown as PlatformDatabase
}

const config = {
  dataDir: '/tmp/cloud-test', minFreeDiskBytes: 1, maxTaskVideos: 10, maxVideoBytes: 4_000,
  maxTaskInputVideoBytes: 10_000, maxLogcatBytes: 100, taskOutputExpansionFactor: 2,
  taskVideoRunOverheadBytes: 50,
} as AppConfig
const diskCheck = async () => 1024

describe('TaskService', () => {
  it('拒绝来自 HTTP JSON 的非法 connectionMode', async () => {
    const database = artifactsDatabase()
    const registry = { resolveExecutionEndpoint: vi.fn() } as unknown as DeviceRegistryService
    const queue = { assertAccepting: vi.fn(), enqueueTask: vi.fn() } as unknown as DeviceQueueManager
    const service = new TaskService(database, registry, queue, config, diskCheck)

    await expect(service.create({
      name: '非法连接模式', apkArtifactId: 'apk', videoArtifactId: 'video', deviceIds: ['device-1'],
      connectionMode: 'bluetooth' as never,
      testPlan: { type: 'sdk-video-processing-compatibility' },
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_CONNECTION_MODE' })
    expect(registry.resolveExecutionEndpoint).not.toHaveBeenCalled()
  })

  it('队列停止接收时不会先写入 queued 任务', async () => {
    const createTask = vi.fn()
    const database = artifactsDatabase(createTask)
    const registry = {
      resolveExecutionEndpoint: vi.fn(async () => ({ id: 'endpoint-usb', kind: 'usb', adbSerial: 'serial-1', status: 'online' })),
    } as unknown as DeviceRegistryService
    const queue = {
      assertAccepting() { throw new QueueNotAcceptingError() },
      enqueueTask: vi.fn(),
    } as unknown as DeviceQueueManager
    const service = new TaskService(database, registry, queue, config, diskCheck)

    await expect(service.create({
      name: '关闭竞态测试',
      apkArtifactId: 'apk',
      videoArtifactId: 'video',
      deviceIds: ['device-1'],
      testPlan: { type: 'sdk-video-processing-compatibility' },
    })).rejects.toBeInstanceOf(QueueNotAcceptingError)
    expect(createTask).not.toHaveBeenCalled()
  })

  it('未传 connectionMode 时按 auto 验证设备，但把 Endpoint 留到 Run 开始前解析', async () => {
    const createTask = vi.fn((input) => ({ id: 'task-1', ...input }))
    const database = artifactsDatabase(createTask)
    const registry = {
      resolveExecutionEndpoint: vi.fn(async () => ({
        id: 'endpoint-network', kind: 'network', adbSerial: '192.168.1.20:5555', status: 'online',
      })),
    } as unknown as DeviceRegistryService
    const queue = { assertAccepting: vi.fn(), enqueueTask: vi.fn() } as unknown as DeviceQueueManager
    const service = new TaskService(database, registry, queue, config, diskCheck)

    await service.create({
      name: '默认模式任务', apkArtifactId: 'apk', videoArtifactId: 'video', deviceIds: ['device-1'],
      testPlan: { type: 'sdk-video-processing-compatibility' },
    })

    expect(registry.resolveExecutionEndpoint).toHaveBeenCalledWith('device-1', 'auto')
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      connectionMode: 'auto',
    }))
    expect(createTask.mock.calls[0]?.[0]).not.toHaveProperty('endpoints')
    expect(queue.enqueueTask).toHaveBeenCalledWith('task-1')
  })

  it('接受有序 videoArtifactIds，按动态预算检查磁盘并保持顺序写入领域层', async () => {
    const createTask = vi.fn((input) => ({ id: 'task-multi', ...input }))
    const database = artifactsDatabase(createTask)
    const registry = {
      resolveExecutionEndpoint: vi.fn(async (deviceId: string) => ({
        id: `usb-${deviceId}`, kind: 'usb', adbSerial: deviceId, status: 'online',
      })),
    } as unknown as DeviceRegistryService
    const queue = { assertAccepting: vi.fn(), enqueueTask: vi.fn() } as unknown as DeviceQueueManager
    const check = vi.fn(async () => 99_999)
    const service = new TaskService(database, registry, queue, config, check)

    await service.create({
      name: '多视频任务', apkArtifactId: 'apk', videoArtifactIds: ['video-2', 'video'],
      deviceIds: ['device-1', 'device-2'], testPlan: { type: 'sdk-video-processing-compatibility' },
    })

    // 300 输入 + 300*2*2 输出估算 + 2 视频*2 设备*50 运行开销 + 1 安全余量。
    expect(check).toHaveBeenCalledWith('/tmp/cloud-test', 1_701)
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      videoArtifactIds: ['video-2', 'video'],
    }))
    expect(queue.enqueueTask).toHaveBeenCalledWith('task-multi')
  })

  it('继续兼容旧 videoArtifactId，并归一化成 videoArtifactIds', async () => {
    const createTask = vi.fn((input) => ({ id: 'task-legacy', ...input }))
    const database = artifactsDatabase(createTask)
    const registry = {
      resolveExecutionEndpoint: vi.fn(async () => ({ id: 'usb-1', kind: 'usb', adbSerial: 'one', status: 'online' })),
    } as unknown as DeviceRegistryService
    const queue = { assertAccepting: vi.fn(), enqueueTask: vi.fn() } as unknown as DeviceQueueManager
    const service = new TaskService(database, registry, queue, config, diskCheck)

    await service.create({
      name: '旧客户端', apkArtifactId: 'apk', videoArtifactId: 'video', deviceIds: ['device-1'],
      testPlan: { type: 'sdk-video-processing-compatibility' },
    })

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ videoArtifactIds: ['video'] }))
  })

  it.each([
    [{ videoArtifactIds: [] }, 'VIDEO_REQUIRED'],
    [{ videoArtifactIds: ['video', 'video'] }, 'DUPLICATE_VIDEO_ID'],
    [{ videoArtifactIds: ['missing'] }, 'VIDEO_NOT_FOUND'],
  ])('拒绝非法多视频入参 %#', async (videoInput, code) => {
    const database = artifactsDatabase()
    const registry = { resolveExecutionEndpoint: vi.fn() } as unknown as DeviceRegistryService
    const queue = { assertAccepting: vi.fn(), enqueueTask: vi.fn() } as unknown as DeviceQueueManager
    const service = new TaskService(database, registry, queue, config, diskCheck)

    await expect(service.create({
      name: '非法多视频', apkArtifactId: 'apk', ...videoInput, deviceIds: ['device-1'],
      testPlan: { type: 'sdk-video-processing-compatibility' },
    })).rejects.toMatchObject({ statusCode: 400, code })
    expect(registry.resolveExecutionEndpoint).not.toHaveBeenCalled()
  })

  it('全任务 network 模式会统一传给每台物理设备的解析模块', async () => {
    const database = artifactsDatabase()
    const resolveExecutionEndpoint = vi.fn(async (deviceId: string) => ({
      id: `network-${deviceId}`, kind: 'network', adbSerial: `${deviceId}.local:5555`, status: 'online',
    }))
    const registry = { resolveExecutionEndpoint } as unknown as DeviceRegistryService
    const queue = { assertAccepting: vi.fn(), enqueueTask: vi.fn() } as unknown as DeviceQueueManager
    const service = new TaskService(database, registry, queue, config, diskCheck)

    await service.create({
      name: '联网多设备任务', apkArtifactId: 'apk', videoArtifactId: 'video', deviceIds: ['device-1', 'device-2'],
      connectionMode: 'network', testPlan: { type: 'sdk-video-processing-compatibility' },
    })

    expect(resolveExecutionEndpoint).toHaveBeenNthCalledWith(1, 'device-1', 'network')
    expect(resolveExecutionEndpoint).toHaveBeenNthCalledWith(2, 'device-2', 'network')
  })
})
