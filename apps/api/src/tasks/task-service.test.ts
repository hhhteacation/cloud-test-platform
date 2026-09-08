import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { AppConfig } from '../config.js'
import { PlatformDatabase } from '../database.js'
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
  taskVideoRunOverheadBytes: 50, endpointResolutionDeadlineMs: 15_000,
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

  it('连接操作已开始时原子拒绝新任务，不遗留 queued Task', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'sdk-task-connection-lease-'))
    const database = new PlatformDatabase({
      databasePath: path.join(rootDir, 'cloud-test.sqlite'),
      seedDevice: false,
      markInterruptedTasks: false,
    })
    try {
      const device = database.upsertAdbDevice({
        id: 'device-connection-busy', serial: 'SERIAL-BUSY', name: 'Busy Phone',
        manufacturer: 'Example', model: 'EX-1', osVersion: 'Android 15',
        apiLevel: 35, architecture: 'arm64-v8a',
      })
      const apk = database.insertArtifact({
        kind: 'apk', originalName: 'test.apk', mimeType: 'application/vnd.android.package-archive',
        storagePath: '/tmp/test.apk', sizeBytes: 1, sha256: 'apk-task-connection-busy',
        packageName: 'com.sdktest.platform',
      })
      const video = database.insertArtifact({
        kind: 'video', originalName: 'test.mp4', mimeType: 'video/mp4',
        storagePath: '/tmp/test.mp4', sizeBytes: 1, sha256: 'video-task-connection-busy',
      })
      database.beginDeviceConnectionOperation({
        deviceId: device.id,
        operationId: 'connection-operation-in-flight',
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      })
      const registry = {
        resolveExecutionEndpoint: vi.fn(async () => ({
          id: 'endpoint-network', kind: 'network', adbSerial: '192.0.2.10:5555', status: 'online',
        })),
      } as unknown as DeviceRegistryService
      const queue = {
        assertAccepting: vi.fn(),
        enqueueTask: vi.fn(),
      } as unknown as DeviceQueueManager
      const service = new TaskService(database, registry, queue, config, diskCheck)

      await expect(service.create({
        name: '连接竞态任务', apkArtifactId: apk.id, videoArtifactId: video.id,
        deviceIds: [device.id], connectionMode: 'network',
        testPlan: { type: 'sdk-video-processing-compatibility' },
      })).rejects.toMatchObject({ statusCode: 409, code: 'DEVICE_CONNECTION_BUSY' })

      expect(database.listTasks()).toEqual([])
      expect(queue.enqueueTask).not.toHaveBeenCalled()
    } finally {
      database.close()
      await rm(rootDir, { recursive: true, force: true })
    }
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

    expect(registry.resolveExecutionEndpoint).toHaveBeenCalledWith('device-1', 'auto', { signal: expect.any(AbortSignal) })
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

    expect(resolveExecutionEndpoint).toHaveBeenNthCalledWith(1, 'device-1', 'network', { signal: expect.any(AbortSignal) })
    expect(resolveExecutionEndpoint).toHaveBeenNthCalledWith(2, 'device-2', 'network', { signal: expect.any(AbortSignal) })
  })

  it('创建任务前的 Endpoint 预校验超时时不写入 queued 任务', async () => {
    const database = artifactsDatabase()
    let observedSignal: AbortSignal | undefined
    const registry = {
      resolveExecutionEndpoint: vi.fn(async (
        _deviceId: string,
        _mode: string,
        options?: { signal?: AbortSignal },
      ) => {
        observedSignal = options?.signal
        await new Promise((resolve) => setTimeout(resolve, 80))
        return { id: 'late-endpoint', kind: 'usb', adbSerial: 'serial-1', status: 'online' }
      }),
    } as unknown as DeviceRegistryService
    const createTask = vi.fn()
    const queue = { assertAccepting: vi.fn(), enqueueTask: vi.fn() } as unknown as DeviceQueueManager
    const service = new TaskService(
      { ...database, createTask } as unknown as PlatformDatabase,
      registry,
      queue,
      { ...config, endpointResolutionDeadlineMs: 10 },
      diskCheck,
    )

    await expect(service.create({
      name: '预校验超时', apkArtifactId: 'apk', videoArtifactId: 'video', deviceIds: ['device-1'],
      testPlan: { type: 'sdk-video-processing-compatibility' },
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ENDPOINT_RESOLUTION_DEADLINE_EXCEEDED',
    })
    expect(observedSignal?.aborted).toBe(true)
    expect(createTask).not.toHaveBeenCalled()
    expect(queue.enqueueTask).not.toHaveBeenCalled()
  })
})
