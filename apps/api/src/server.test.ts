import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AppConfig } from './config.js'
import { buildServer } from './server.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function testConfig(): Promise<AppConfig> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cloud-test-server-'))
  directories.push(dataDir)
  return {
    host: '127.0.0.1', port: 3000, rootDir: dataDir, dataDir,
    databasePath: path.join(dataDir, 'cloud-test.sqlite'),
    artifactsDir: path.join(dataDir, 'artifacts'), tasksDir: path.join(dataDir, 'tasks'),
    quarantineDir: path.join(dataDir, '.quarantine'), trashDir: path.join(dataDir, '.trash'),
    adbPath: '/usr/bin/true', aaptPath: '/usr/bin/true',
    ffmpegPath: '/usr/bin/true', ffprobePath: '/usr/bin/true',
    maxApkBytes: 1024, maxVideoBytes: 1024, minFreeDiskBytes: 1,
    maxConcurrentUploads: 1, maxProcessOutputBytes: 1024, maxLogcatBytes: 4096,
    processKillGraceMs: 10, pollIntervalMs: 10,
    managedObservationAdoptionEnabled: false,
    managedObservationAdoptionDeviceIds: [],
  }
}

describe('API Composition Root', () => {
  it('注册本机访问保护和拆分后的健康检查路由', async () => {
    const app = await buildServer({ config: await testConfig(), skipPreflight: true })
    const local = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'localhost:3000' } })
    expect(local.statusCode).toBe(200)
    expect(local.json()).toMatchObject({ status: 'ok', accessMode: 'local-single-user' })

    const lan = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '192.168.1.20:3000' } })
    expect(lan.statusCode).toBe(403)
    await app.close()
  })
})
