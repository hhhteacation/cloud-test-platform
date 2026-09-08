import { describe, expect, it, vi } from 'vitest'

import type { PlatformDatabase } from '../database.js'
import { DeviceRegistrationError, type DeviceRegistryService } from '../devices/device-registry.js'
import type { DeviceRunWorker } from '../queue.js'
import { EndpointResolvingWorker } from './endpoint-resolving-worker.js'

const job = { taskId: 'task-1', runId: 'run-1', deviceId: 'device-1' }

describe('EndpointResolvingWorker', () => {
  it('在 Run 开始前按任务模式解析并持久化 Endpoint，再调用 ADB Worker', async () => {
    const order: string[] = []
    const database = {
      getTask: vi.fn(() => ({ connectionMode: 'network', status: 'queued' })),
      assignDeviceRunEndpoint: vi.fn(() => { order.push('assign'); return true }),
      failDeviceRun: vi.fn(),
    } as unknown as PlatformDatabase
    const registry = {
      resolveExecutionEndpoint: vi.fn(async () => ({
        id: 'endpoint-network', kind: 'network', adbSerial: '192.168.1.20:5555', status: 'online',
      })),
    } as unknown as DeviceRegistryService
    const delegate = {
      execute: vi.fn(async () => { order.push('execute') }),
      cancelTask: vi.fn(),
    } satisfies DeviceRunWorker

    const worker = new EndpointResolvingWorker(database, registry, delegate)
    await worker.execute(job)

    expect(registry.resolveExecutionEndpoint).toHaveBeenCalledWith(
      'device-1',
      'network',
      { signal: expect.any(AbortSignal) },
    )
    expect(database.assignDeviceRunEndpoint).toHaveBeenCalledWith(job, {
      endpointId: 'endpoint-network', connectionKind: 'network', adbSerial: '192.168.1.20:5555',
    })
    expect(order).toEqual(['assign', 'execute'])
  })

  it('Run 开始前连接不可用时记录明确失败，不调用 ADB Worker', async () => {
    const database = {
      getTask: vi.fn(() => ({ connectionMode: 'usb', status: 'queued' })),
      assignDeviceRunEndpoint: vi.fn(),
      failDeviceRun: vi.fn(),
    } as unknown as PlatformDatabase
    const registry = {
      resolveExecutionEndpoint: vi.fn(async () => {
        throw new DeviceRegistrationError('测试机当前没有可用的 USB ADB 连接', 'DEVICE_NOT_ONLINE', 409)
      }),
    } as unknown as DeviceRegistryService
    const delegate = { execute: vi.fn(), cancelTask: vi.fn() } satisfies DeviceRunWorker

    const worker = new EndpointResolvingWorker(database, registry, delegate)
    await worker.execute(job)

    expect(database.failDeviceRun).toHaveBeenCalledWith(
      job, 'DEVICE_NOT_ONLINE', '测试机当前没有可用的 USB ADB 连接',
    )
    expect(database.assignDeviceRunEndpoint).not.toHaveBeenCalled()
    expect(delegate.execute).not.toHaveBeenCalled()
  })

  it('Endpoint 写入时任务已取消则不启动 ADB Worker', async () => {
    const database = {
      getTask: vi.fn(() => ({ connectionMode: 'auto', status: 'queued' })),
      assignDeviceRunEndpoint: vi.fn(() => false),
      failDeviceRun: vi.fn(),
    } as unknown as PlatformDatabase
    const registry = {
      resolveExecutionEndpoint: vi.fn(async () => ({
        id: 'endpoint-usb', kind: 'usb', adbSerial: 'serial-1', status: 'online',
      })),
    } as unknown as DeviceRegistryService
    const delegate = { execute: vi.fn(), cancelTask: vi.fn() } satisfies DeviceRunWorker

    const worker = new EndpointResolvingWorker(database, registry, delegate)
    await worker.execute(job)

    expect(delegate.execute).not.toHaveBeenCalled()
  })

  it('首次 Endpoint 解析超过 deadline 时终止扫描并记录结构化失败', async () => {
    let observedSignal: AbortSignal | undefined
    const database = {
      getTask: vi.fn(() => ({ connectionMode: 'auto', status: 'queued' })),
      assignDeviceRunEndpoint: vi.fn(),
      failDeviceRun: vi.fn(),
    } as unknown as PlatformDatabase
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
    const delegate = { execute: vi.fn(), cancelTask: vi.fn() } satisfies DeviceRunWorker

    const worker = new EndpointResolvingWorker(database, registry, delegate, 10)
    await worker.execute(job)

    expect(observedSignal?.aborted).toBe(true)
    expect(database.failDeviceRun).toHaveBeenCalledWith(
      job,
      'ENDPOINT_RESOLUTION_DEADLINE_EXCEEDED',
      '首次 Endpoint 解析超过 10ms 预算',
    )
    expect(database.assignDeviceRunEndpoint).not.toHaveBeenCalled()
    expect(delegate.execute).not.toHaveBeenCalled()
  })

  it('任务取消会终止正在进行的首次 Endpoint 解析且拒绝迟到绑定', async () => {
    let observedSignal: AbortSignal | undefined
    const database = {
      getTask: vi.fn(() => ({ connectionMode: 'network', status: 'queued' })),
      assignDeviceRunEndpoint: vi.fn(),
      failDeviceRun: vi.fn(),
    } as unknown as PlatformDatabase
    const registry = {
      resolveExecutionEndpoint: vi.fn(async (
        _deviceId: string,
        _mode: string,
        options?: { signal?: AbortSignal },
      ) => {
        observedSignal = options?.signal
        await new Promise((resolve) => setTimeout(resolve, 80))
        return { id: 'late-endpoint', kind: 'network', adbSerial: '192.0.2.1:5555', status: 'online' }
      }),
    } as unknown as DeviceRegistryService
    const delegate = { execute: vi.fn(), cancelTask: vi.fn() } satisfies DeviceRunWorker
    const worker = new EndpointResolvingWorker(database, registry, delegate, 1_000)

    const execution = worker.execute(job)
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    worker.cancelTask(job.taskId)
    await execution

    expect(observedSignal?.aborted).toBe(true)
    expect(database.failDeviceRun).not.toHaveBeenCalled()
    expect(database.assignDeviceRunEndpoint).not.toHaveBeenCalled()
    expect(delegate.execute).not.toHaveBeenCalled()
    expect(delegate.cancelTask).toHaveBeenCalledWith(job.taskId)
  })
})
