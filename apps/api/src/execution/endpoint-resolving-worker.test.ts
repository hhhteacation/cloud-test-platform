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

    expect(registry.resolveExecutionEndpoint).toHaveBeenCalledWith('device-1', 'network')
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
})
