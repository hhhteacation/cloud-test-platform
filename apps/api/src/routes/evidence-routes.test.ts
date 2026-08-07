import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import type { AppConfig } from '../config.js'
import { registerEvidenceRoutes } from './evidence-routes.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function config(tasksDir: string) {
  return { tasksDir } as AppConfig
}

function fakeDatabase(execution?: { deviceId: string }) {
  return {
    hasDeviceRun: (taskId: string, runId: string) => taskId === 'task-1' && runId === 'run-1',
    getDeviceRunExecution: () => execution,
  } as never
}

describe('evidence routes logcat download', () => {
  it('downloads only the requested run and uses a device/run-specific filename', async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), 'evidence-route-'))
    directories.push(tasksDir)
    const filePath = path.join(tasksDir, 'task-1', 'device-runs', 'run-1', 'logcat.txt')
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'device log line\n')

    const app = Fastify()
    registerEvidenceRoutes(app, fakeDatabase({ deviceId: 'Pixel 8 / shared' }), config(tasksDir))
    const response = await app.inject({ method: 'GET', url: '/api/tasks/task-1/device-runs/run-1/logcat' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('device log line\n')
    expect(response.headers['content-disposition']).toBe('attachment; filename="logcat-Pixel_8___shared-run-1.txt"')
    await app.close()
  })

  it('returns LOGCAT_NOT_FOUND when the run exists but the file is absent', async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), 'evidence-route-missing-'))
    directories.push(tasksDir)
    const app = Fastify()
    registerEvidenceRoutes(app, fakeDatabase({ deviceId: 'Pixel' }), config(tasksDir))
    const response = await app.inject({ method: 'GET', url: '/api/tasks/task-1/device-runs/run-1/logcat' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'LOGCAT_NOT_FOUND' })
    await app.close()
  })

  it('returns DEVICE_RUN_NOT_FOUND for another task/run', async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), 'evidence-route-not-found-'))
    directories.push(tasksDir)
    const app = Fastify()
    registerEvidenceRoutes(app, fakeDatabase({ deviceId: 'Pixel' }), config(tasksDir))
    const response = await app.inject({ method: 'GET', url: '/api/tasks/task-2/device-runs/run-2/logcat' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'DEVICE_RUN_NOT_FOUND' })
    await app.close()
  })
})
