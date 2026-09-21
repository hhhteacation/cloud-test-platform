import type { FastifyInstance } from 'fastify'

import { DeviceRegistrationError, type DeviceRegistryService } from '../devices/device-registry.js'
import type { DevicePlatform } from '../types.js'

function handleDeviceError(request: { log: { error: (error: unknown) => void } }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown, fallback: string) {
  if (error instanceof DeviceRegistrationError) {
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
      ...(error.evidence ? { evidence: error.evidence } : {}),
    })
  }
  request.log.error(error)
  return reply.code(500).send({ code: 'DEVICE_OPERATION_FAILED', message: fallback })
}

export interface DeviceRouteObservability {
  getManagedObservationAdoptionStatus(): unknown
}

export function registerDeviceRoutes(
  app: FastifyInstance,
  deviceRegistry: DeviceRegistryService,
  observability?: DeviceRouteObservability,
) {
  // HarmonyOS has no provider yet; unknown/absent values stay on Android.
  const platformQuery = (value: unknown): DevicePlatform =>
    value === 'ios' ? 'ios' : 'android'

  app.get<{ Querystring: { platform?: string } }>('/api/devices', async (request) =>
    deviceRegistry.listRegisteredSnapshot(platformQuery(request.query?.platform)))

  app.post<{ Querystring: { platform?: string } }>('/api/devices/refresh', async (request, reply) => {
    const platform = platformQuery(request.query?.platform)
    try { return await deviceRegistry.refreshRegistered(platform) }
    catch (error) { return handleDeviceError(request, reply, error, 'ADB 设备状态刷新失败，请检查 adb 路径和设备连接') }
  })

  app.post<{ Querystring: { platform?: string } }>('/api/devices/discover', async (request, reply) => {
    const platform = platformQuery(request.query?.platform)
    try { return await deviceRegistry.discover(platform) }
    catch (error) { return handleDeviceError(request, reply, error, 'ADB 设备扫描失败，请检查 adb 路径和 USB 连接') }
  })

  app.post<{ Querystring: { platform?: string } }>('/api/devices/network/discover', async (request, reply) => {
    const platform = platformQuery(request.query?.platform)
    try { return await deviceRegistry.discoverNetwork(platform) }
    catch (error) { return handleDeviceError(request, reply, error, '联网 ADB 服务发现失败') }
  })

  app.get('/api/devices/network/observations', async () => (
    deviceRegistry.listNetworkObservations()
  ))

  app.get('/api/devices/network/observation-decisions', async () => (
    deviceRegistry.listNetworkObservationDecisions()
  ))

  if (observability) {
    app.get('/api/devices/network/managed-adoption-status', async () => (
      observability.getManagedObservationAdoptionStatus()
    ))
  }

  app.post<{ Body: { serial?: string; platform?: string } }>('/api/devices/register', async (request, reply) => {
    try {
      const device = await deviceRegistry.register(request.body?.serial ?? '', platformQuery(request.body?.platform))
      return reply.code(201).send({ ...device, connectionStatus: 'online' })
    } catch (error) {
      return handleDeviceError(request, reply, error, '设备录入失败')
    }
  })

  app.post<{ Params: { deviceId: string }; Body: { host?: string; port?: number } }>('/api/devices/:deviceId/endpoints/network', async (request, reply) => {
    try {
      const endpoint = await deviceRegistry.connectNetwork(request.params.deviceId, request.body?.host ?? '', Number(request.body?.port ?? 5555))
      return reply.code(201).send(endpoint)
    } catch (error) {
      return handleDeviceError(request, reply, error, '联网 ADB 连接失败')
    }
  })

  app.post<{ Params: { deviceId: string } }>('/api/devices/:deviceId/network/recover', async (request, reply) => {
    try {
      return reply.send(await deviceRegistry.recoverNetworkConnection(request.params.deviceId))
    } catch (error) {
      return handleDeviceError(request, reply, error, '人工恢复联网 ADB 失败')
    }
  })

  app.post<{ Params: { deviceId: string; endpointId: string } }>('/api/devices/:deviceId/endpoints/network/:endpointId/connect', async (request, reply) => {
    try {
      const endpoint = await deviceRegistry.refreshNetwork(request.params.deviceId, request.params.endpointId)
      return reply.send(endpoint)
    } catch (error) {
      return handleDeviceError(request, reply, error, '联网 ADB 连接失败')
    }
  })

  app.post('/api/devices/network/connect-all', async (request, reply) => {
    try {
      return reply.code(202).send(deviceRegistry.startNetworkConnectionOperation())
    } catch (error) {
      return handleDeviceError(request, reply, error, '批量联网 ADB 连接启动失败')
    }
  })

  app.patch<{ Params: { deviceId: string }; Body: { mode?: string } }>('/api/devices/:deviceId/network-management', async (request, reply) => {
    const mode = request.body?.mode
    if (mode !== 'manual' && mode !== 'shadow' && mode !== 'managed') {
      return reply.code(400).send({
        code: 'INVALID_NETWORK_MANAGEMENT_MODE',
        message: '联网管理模式必须是 manual、shadow 或 managed',
      })
    }
    try {
      return reply.send(deviceRegistry.setNetworkManagementMode(request.params.deviceId, mode))
    } catch (error) {
      return handleDeviceError(request, reply, error, '联网管理模式更新失败')
    }
  })

  app.get<{ Params: { operationId: string } }>('/api/devices/network/connect-operations/:operationId', async (request, reply) => {
    try {
      return reply.send(deviceRegistry.getNetworkConnectionOperation(request.params.operationId))
    } catch (error) {
      return handleDeviceError(request, reply, error, '批量联网 ADB 连接状态查询失败')
    }
  })

  app.post<{ Params: { operationId: string } }>('/api/devices/network/connect-operations/:operationId/cancel', async (request, reply) => {
    try {
      return reply.send(deviceRegistry.cancelNetworkConnectionOperation(request.params.operationId))
    } catch (error) {
      return handleDeviceError(request, reply, error, '批量联网 ADB 连接取消失败')
    }
  })

  app.post<{ Params: { deviceId: string; endpointId: string } }>('/api/devices/:deviceId/endpoints/network/:endpointId/disconnect', async (request, reply) => {
    try {
      return reply.send(await deviceRegistry.disconnectNetwork(request.params.deviceId, request.params.endpointId))
    } catch (error) {
      return handleDeviceError(request, reply, error, '联网 ADB 断开失败')
    }
  })

  app.post<{ Params: { deviceId: string; endpointId: string } }>('/api/devices/:deviceId/endpoints/network/:endpointId/refresh', async (request, reply) => {
    try {
      return reply.send(await deviceRegistry.refreshNetwork(request.params.deviceId, request.params.endpointId))
    } catch (error) {
      return handleDeviceError(request, reply, error, '联网 ADB 刷新失败')
    }
  })

  app.delete<{ Params: { deviceId: string; endpointId: string } }>('/api/devices/:deviceId/endpoints/network/:endpointId', async (request, reply) => {
    try {
      await deviceRegistry.removeNetworkEndpoint(request.params.deviceId, request.params.endpointId)
      return reply.code(204).send()
    } catch (error) {
      return handleDeviceError(request, reply, error, '联网 Endpoint 移除失败')
    }
  })
}
