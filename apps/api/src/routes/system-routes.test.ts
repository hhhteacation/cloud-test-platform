import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { PlatformDatabase } from '../database.js'
import type { DeviceDiscoveryProvider } from '../devices/device-provider.js'
import { DeviceRegistryService } from '../devices/device-registry.js'
import { registerSystemRoutes } from './system-routes.js'

describe('system routes', () => {
  it('GET /api/health 只读取设备快照，即使 Provider 永不返回也不会触发真实扫描', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'sdk-system-routes-'))
    const database = new PlatformDatabase({
      databasePath: path.join(rootDir, 'cloud-test.sqlite'),
      seedDevice: false,
      markInterruptedTasks: false,
    })
    database.upsertAdbDevice({
      id: 'device-1', serial: 'SERIAL-1', name: '测试机', manufacturer: 'Example', model: 'EX-1',
      osVersion: 'Android 15', apiLevel: 35, architecture: 'arm64-v8a',
    })
    const discover = vi.fn(() => new Promise<never>(() => undefined))
    const provider = { platform: 'android', discover } satisfies DeviceDiscoveryProvider
    const registry = new DeviceRegistryService(database, [provider])
    const app = Fastify()
    registerSystemRoutes(app, registry)

    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        status: 'ok',
        devices: { registered: 1, online: 1 },
      })
      expect(discover).not.toHaveBeenCalled()
    } finally {
      await app.close()
      database.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
