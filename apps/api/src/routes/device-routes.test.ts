import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { DeviceRegistrationError, type DeviceRegistryService } from '../devices/device-registry.js'
import { registerDeviceRoutes } from './device-routes.js'

function registryStub(overrides: Partial<DeviceRegistryService> = {}) {
  return {
    listRegisteredSnapshot: vi.fn(async () => []),
    refreshRegistered: vi.fn(async () => []),
    discover: vi.fn(async () => []),
    discoverNetwork: vi.fn(async () => []),
    register: vi.fn(),
    connectNetwork: vi.fn(),
    disconnectNetwork: vi.fn(),
    refreshNetwork: vi.fn(),
    removeNetworkEndpoint: vi.fn(),
    ...overrides,
  } as unknown as DeviceRegistryService
}

describe('device routes', () => {
  it('GET /api/devices 返回物理设备与 Endpoint 汇总', async () => {
    const registry = registryStub({
      listRegisteredSnapshot: vi.fn(async () => [{
        id: 'device-1', platform: 'android', name: '测试机', manufacturer: 'Example', model: 'EX-1',
        osVersion: 'Android 15', apiLevel: 35, architecture: 'arm64-v8a', executionMode: 'adb', eligible: true,
        endpoints: { usb: { id: 'usb-1', deviceId: 'device-1', kind: 'usb', adbSerial: 'SERIAL-1', status: 'online' } },
        overallConnectionStatus: 'online', selectable: true, queueStatus: 'idle',
      }]),
    })
    const app = Fastify()
    registerDeviceRoutes(app, registry)

    const response = await app.inject({ method: 'GET', url: '/api/devices' })
    expect(response.statusCode).toBe(200)
    expect(registry.listRegisteredSnapshot).toHaveBeenCalledWith('android')
    expect(registry.refreshRegistered).not.toHaveBeenCalled()
    expect(response.json()).toEqual([expect.objectContaining({
      id: 'device-1', overallConnectionStatus: 'online', selectable: true,
      endpoints: { usb: expect.objectContaining({ kind: 'usb', adbSerial: 'SERIAL-1' }) },
    })])
    await app.close()
  })

  it('POST /api/devices/refresh 执行真实刷新并返回刷新后的设备列表', async () => {
    const refreshed = [{ id: 'device-1', platform: 'android', name: '测试机' }] as never[]
    const registry = registryStub({ refreshRegistered: vi.fn(async () => refreshed) })
    const app = Fastify()
    registerDeviceRoutes(app, registry)

    const response = await app.inject({ method: 'POST', url: '/api/devices/refresh' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(refreshed)
    expect(registry.refreshRegistered).toHaveBeenCalledWith('android')
    await app.close()
  })

  it('POST /api/devices/refresh 扫描失败时返回明确错误', async () => {
    const registry = registryStub({
      refreshRegistered: vi.fn(async () => { throw new Error('adb daemon unavailable') }),
    })
    const app = Fastify({ logger: false })
    registerDeviceRoutes(app, registry)

    const response = await app.inject({ method: 'POST', url: '/api/devices/refresh' })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ code: 'DEVICE_OPERATION_FAILED', message: 'ADB 设备状态刷新失败，请检查 adb 路径和设备连接' })
    await app.close()
  })

  it('联网 Endpoint 支持创建、断开、刷新和移除', async () => {
    const endpoint = { id: 'network-1', deviceId: 'device-1', kind: 'network' as const, adbSerial: '192.168.1.20:5555', host: '192.168.1.20', port: 5555, status: 'online' as const }
    const registry = registryStub({
      connectNetwork: vi.fn(async () => endpoint),
      disconnectNetwork: vi.fn(async () => ({ ...endpoint, status: 'offline' as const })),
      refreshNetwork: vi.fn(async () => endpoint),
      removeNetworkEndpoint: vi.fn(() => true),
    })
    const app = Fastify()
    registerDeviceRoutes(app, registry)

    const created = await app.inject({ method: 'POST', url: '/api/devices/device-1/endpoints/network', payload: { host: '192.168.1.20', port: 5555 } })
    expect(created.statusCode).toBe(201)
    expect(registry.connectNetwork).toHaveBeenCalledWith('device-1', '192.168.1.20', 5555)

    expect((await app.inject({ method: 'POST', url: '/api/devices/device-1/endpoints/network/network-1/disconnect' })).json()).toMatchObject({ status: 'offline' })
    expect((await app.inject({ method: 'POST', url: '/api/devices/device-1/endpoints/network/network-1/refresh' })).json()).toMatchObject({ status: 'online' })
    expect((await app.inject({ method: 'DELETE', url: '/api/devices/device-1/endpoints/network/network-1' })).statusCode).toBe(204)
    await app.close()
  })

  it('身份不能确认时返回明确 409 错误而不伪装成成功', async () => {
    const registry = registryStub({
      connectNetwork: vi.fn(async () => { throw new DeviceRegistrationError('需要人工确认', 'DEVICE_IDENTITY_MISMATCH', 409) }),
    })
    const app = Fastify()
    registerDeviceRoutes(app, registry)

    const response = await app.inject({ method: 'POST', url: '/api/devices/device-1/endpoints/network', payload: { host: '192.168.1.30', port: 5555 } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ code: 'DEVICE_IDENTITY_MISMATCH', message: '需要人工确认' })
    await app.close()
  })
})
