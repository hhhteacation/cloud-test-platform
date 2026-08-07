import type { FastifyInstance } from 'fastify'

import { APK_EXECUTION_PROTOCOLS, toPublicApkProtocol } from '../apk-protocols.js'
import type { DeviceRegistryService } from '../devices/device-registry.js'

export function registerSystemRoutes(app: FastifyInstance, deviceRegistry: DeviceRegistryService) {
  app.get('/api/health', async () => {
    const devices = await deviceRegistry.listRegisteredSnapshot('android')
    return {
      status: 'ok',
      service: 'sdk-video-compat-api',
      accessMode: 'local-single-user',
      platforms: { android: 'available', ios: 'planned', harmonyos: 'planned' },
      devices: {
        registered: devices.length,
        online: devices.filter((device) => device.connectionStatus === 'online').length,
      },
      time: new Date().toISOString(),
    }
  })

  app.get('/api/apk-protocols', async () => APK_EXECUTION_PROTOCOLS.map(toPublicApkProtocol))
  app.get<{ Params: { id: string } }>('/api/apk-protocols/:id', async (request, reply) => {
    const protocol = APK_EXECUTION_PROTOCOLS.find((candidate) => candidate.id === request.params.id)
    return protocol ? toPublicApkProtocol(protocol) : reply.code(404).send({ code: 'APK_PROTOCOL_NOT_FOUND', message: 'APK 执行协议不存在' })
  })
}
