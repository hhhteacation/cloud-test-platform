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
    listNetworkObservations: vi.fn(() => []),
    listNetworkObservationDecisions: vi.fn(() => []),
    reconcileManagedNetworkObservations: vi.fn(async () => []),
    adoptManagedNetworkObservation: vi.fn(),
    register: vi.fn(),
    connectNetwork: vi.fn(),
    disconnectNetwork: vi.fn(),
    refreshNetwork: vi.fn(),
    removeNetworkEndpoint: vi.fn(),
    startNetworkConnectionOperation: vi.fn(),
    getNetworkConnectionOperation: vi.fn(),
    cancelNetworkConnectionOperation: vi.fn(),
    setNetworkManagementMode: vi.fn(),
    ...overrides,
  } as unknown as DeviceRegistryService
}

describe('device routes', () => {
  it('GET Observation 决策只读返回 Shadow 结果，不触发连接调度', async () => {
    const decisions = [{
      observation: {
        id: 'observation-1', source: 'mdns', serviceInstance: 'adb-SERIAL-1-candidate',
        transportType: 'wireless_tls', host: '192.0.2.10', port: 37123,
        observedAt: '2026-08-25T00:00:00.000Z', expiresAt: '2026-08-25T00:01:00.000Z',
        verificationStatus: 'unverified',
      },
      deviceId: 'device-1', deviceName: '测试机', managementMode: 'shadow',
      status: 'shadow_only', reasonCode: 'SHADOW_MODE_NO_ACTION',
    }]
    const registry = registryStub({
      listNetworkObservationDecisions: vi.fn(() => decisions as never),
    })
    const app = Fastify()
    registerDeviceRoutes(app, registry)

    const response = await app.inject({ method: 'GET', url: '/api/devices/network/observation-decisions' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(decisions)
    expect(registry.listNetworkObservationDecisions).toHaveBeenCalledTimes(1)
    expect(registry.reconcileManagedNetworkObservations).not.toHaveBeenCalled()
    expect(registry.adoptManagedNetworkObservation).not.toHaveBeenCalled()
    await app.close()
  })

  it('GET Managed Adoption 状态只读返回 Gate 快照，不触发连接调度', async () => {
    const status = {
      enabled: false, running: false, cyclesStarted: 0, cyclesCompleted: 0,
      adoptionFailures: 0, discoveryFailures: 0,
    }
    const getManagedObservationAdoptionStatus = vi.fn(() => status)
    const registry = registryStub()
    const app = Fastify()
    registerDeviceRoutes(app, registry, { getManagedObservationAdoptionStatus })

    const response = await app.inject({
      method: 'GET', url: '/api/devices/network/managed-adoption-status',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(status)
    expect(getManagedObservationAdoptionStatus).toHaveBeenCalledTimes(1)
    expect(registry.reconcileManagedNetworkObservations).not.toHaveBeenCalled()
    expect(registry.adoptManagedNetworkObservation).not.toHaveBeenCalled()
    await app.close()
  })

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

  it('批量联网连接支持创建、查询和取消', async () => {
    const operation = { id: 'network-connect-1', status: 'queued', totalCount: 2, succeeded: 0, failed: 0, skipped: 0, cancelled: 0, cancelRequested: false, items: [] }
    const registry = registryStub({
      startNetworkConnectionOperation: vi.fn(() => ({ operationId: operation.id, status: operation.status, totalCount: operation.totalCount })),
      getNetworkConnectionOperation: vi.fn(() => operation),
      cancelNetworkConnectionOperation: vi.fn(() => ({ ...operation, cancelRequested: true })),
    })
    const app = Fastify()
    registerDeviceRoutes(app, registry)

    const created = await app.inject({ method: 'POST', url: '/api/devices/network/connect-all' })
    expect(created.statusCode).toBe(202)
    expect(created.json()).toEqual({ operationId: 'network-connect-1', status: 'queued', totalCount: 2 })
    expect((await app.inject({ method: 'GET', url: '/api/devices/network/connect-operations/network-connect-1' })).statusCode).toBe(200)
    const cancelled = await app.inject({ method: 'POST', url: '/api/devices/network/connect-operations/network-connect-1/cancel' })
    expect(cancelled.json()).toMatchObject({ cancelRequested: true })
    await app.close()
  })

  it('PATCH 联网管理模式只接受 manual、shadow、managed 并返回结构化状态', async () => {
    const state = {
      deviceId: 'device-1', managementMode: 'managed' as const,
      desiredNetworkState: 'connected' as const, observedNetworkState: 'online' as const,
      connectionGeneration: 2, retryCount: 0, consecutiveFailures: 0,
      updatedAt: '2026-08-25T00:00:00.000Z',
    }
    const registry = registryStub({ setNetworkManagementMode: vi.fn(() => state) })
    const app = Fastify()
    registerDeviceRoutes(app, registry)

    const updated = await app.inject({
      method: 'PATCH', url: '/api/devices/device-1/network-management', payload: { mode: 'managed' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ deviceId: 'device-1', managementMode: 'managed' })
    expect(registry.setNetworkManagementMode).toHaveBeenCalledWith('device-1', 'managed')

    const invalid = await app.inject({
      method: 'PATCH', url: '/api/devices/device-1/network-management', payload: { mode: 'automatic' },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toEqual({
      code: 'INVALID_NETWORK_MANAGEMENT_MODE', message: '联网管理模式必须是 manual、shadow 或 managed',
    })
    expect(registry.setNetworkManagementMode).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it.each([
    ['NO_NETWORK_ENDPOINTS', '没有配置联网 Endpoint 的设备', 409],
    ['NETWORK_CONNECT_OPERATION_ALREADY_RUNNING', '已有联网批量连接操作正在执行', 409],
  ] as const)('批量启动错误 %s 映射为明确响应', async (code, message, statusCode) => {
    const registry = registryStub({
      startNetworkConnectionOperation: vi.fn(() => { throw new DeviceRegistrationError(message, code, statusCode) }),
    })
    const app = Fastify()
    registerDeviceRoutes(app, registry)

    const response = await app.inject({ method: 'POST', url: '/api/devices/network/connect-all' })
    expect(response.statusCode).toBe(statusCode)
    expect(response.json()).toEqual({ code, message })
    await app.close()
  })

  it('批量查询不存在的操作返回 404', async () => {
    const registry = registryStub({
      getNetworkConnectionOperation: vi.fn(() => { throw new DeviceRegistrationError('联网批量连接操作不存在', 'NETWORK_CONNECT_OPERATION_NOT_FOUND', 404) }),
    })
    const app = Fastify()
    registerDeviceRoutes(app, registry)

    const response = await app.inject({ method: 'GET', url: '/api/devices/network/connect-operations/not-found' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ code: 'NETWORK_CONNECT_OPERATION_NOT_FOUND', message: '联网批量连接操作不存在' })
    await app.close()
  })

  it('批量取消已完成操作保持原结果不变', async () => {
    const operation = { id: 'network-connect-done', status: 'completed', totalCount: 1, succeeded: 1, failed: 0, skipped: 0, cancelled: 0, cancelRequested: false, items: [{ id: 'item-1', operationId: 'network-connect-done', deviceId: 'device-1', endpointId: 'endpoint-1', host: '192.0.2.1', port: 5555, status: 'succeeded' }] }
    const registry = registryStub({
      getNetworkConnectionOperation: vi.fn(() => operation),
      cancelNetworkConnectionOperation: vi.fn(() => operation),
    })
    const app = Fastify()
    registerDeviceRoutes(app, registry)

    const response = await app.inject({ method: 'POST', url: '/api/devices/network/connect-operations/network-connect-done/cancel' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(operation)
    expect(registry.cancelNetworkConnectionOperation).toHaveBeenCalledWith('network-connect-done')
    await app.close()
  })

  it('身份不能确认时返回明确 409 错误而不伪装成成功', async () => {
    const registry = registryStub({
      connectNetwork: vi.fn(async () => {
        throw new DeviceRegistrationError('需要人工确认', 'DEVICE_IDENTITY_MISMATCH', 409, {
          adbExitCode: 1,
          adbStdout: 'adb stdout',
          adbStderr: 'identity mismatch',
          adbStdoutTruncated: false,
          adbStderrTruncated: false,
        })
      }),
    })
    const app = Fastify()
    registerDeviceRoutes(app, registry)

    const response = await app.inject({ method: 'POST', url: '/api/devices/device-1/endpoints/network', payload: { host: '192.168.1.30', port: 5555 } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      code: 'DEVICE_IDENTITY_MISMATCH',
      message: '需要人工确认',
      evidence: {
        adbExitCode: 1,
        adbStdout: 'adb stdout',
        adbStderr: 'identity mismatch',
        adbStdoutTruncated: false,
        adbStderrTruncated: false,
      },
    })
    await app.close()
  })
})
