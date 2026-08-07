import type { FastifyInstance } from 'fastify'

import { DeviceRegistrationError, type DeviceRegistryService } from '../devices/device-registry.js'

function handleDeviceError(request: { log: { error: (error: unknown) => void } }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown, fallback: string) {
  if (error instanceof DeviceRegistrationError) return reply.code(error.statusCode).send({ code: error.code, message: error.message })
  request.log.error(error)
  return reply.code(500).send({ code: 'DEVICE_OPERATION_FAILED', message: fallback })
}

export function registerDeviceRoutes(app: FastifyInstance, deviceRegistry: DeviceRegistryService) {
  app.get('/api/devices', async () => deviceRegistry.listRegisteredSnapshot('android'))

  app.post('/api/devices/refresh', async (request, reply) => {
    try { return await deviceRegistry.refreshRegistered('android') }
    catch (error) { return handleDeviceError(request, reply, error, 'ADB 设备状态刷新失败，请检查 adb 路径和设备连接') }
  })

  app.post('/api/devices/discover', async (request, reply) => {
    try { return await deviceRegistry.discover('android') }
    catch (error) { return handleDeviceError(request, reply, error, 'ADB 设备扫描失败，请检查 adb 路径和 USB 连接') }
  })

  app.post('/api/devices/network/discover', async (request, reply) => {
    try { return await deviceRegistry.discoverNetwork('android') }
    catch (error) { return handleDeviceError(request, reply, error, '联网 ADB 服务发现失败') }
  })

  app.post<{ Body: { serial?: string } }>('/api/devices/register', async (request, reply) => {
    try {
      const device = await deviceRegistry.register(request.body?.serial ?? '', 'android')
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

  app.post<{ Params: { deviceId: string; endpointId: string } }>('/api/devices/:deviceId/endpoints/network/:endpointId/connect', async (request, reply) => {
    try {
      const endpoint = await deviceRegistry.refreshNetwork(request.params.deviceId, request.params.endpointId)
      return reply.send(endpoint)
    } catch (error) {
      return handleDeviceError(request, reply, error, '联网 ADB 连接失败')
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
