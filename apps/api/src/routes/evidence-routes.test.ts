import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import type { AppConfig } from '../config.js'
import { registerEvidenceRoutes, resolveEvidenceFilePath } from './evidence-routes.js'

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


describe('evidence routes generic Attempt download', () => {
  async function createApp(tasksDir: string) {
    const app = Fastify()
    registerEvidenceRoutes(app, fakeDatabase({ deviceId: 'Pixel' }), config(tasksDir))
    return app
  }

  it('downloads the current Attempt manifest with its JSON content type', async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), 'evidence-route-manifest-'))
    directories.push(tasksDir)
    const filePath = path.join(tasksDir, 'task-1', 'device-runs', 'run-1', 'attempt-manifest.json')
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, '{"attemptId":"attempt-1"}\n')

    const app = await createApp(tasksDir)
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks/task-1/device-runs/run-1/evidence/attempt-manifest.json',
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('{"attemptId":"attempt-1"}\n')
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['content-disposition']).toBe('attachment; filename="attempt-manifest.json"')
    await app.close()
  })

  it('downloads nested Evidence paths without widening the run directory', async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), 'evidence-route-nested-'))
    directories.push(tasksDir)
    const filePath = path.join(tasksDir, 'task-1', 'device-runs', 'run-1', 'diagnostics', 'ui.xml')
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, '<hierarchy />\n')

    const app = await createApp(tasksDir)
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks/task-1/device-runs/run-1/evidence/diagnostics/ui.xml',
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('<hierarchy />\n')
    expect(response.headers['content-type']).toContain('application/xml')
    await app.close()
  })

  it('distinguishes a missing Evidence file from a missing Device Run', async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), 'evidence-route-missing-generic-'))
    directories.push(tasksDir)
    await mkdir(path.join(tasksDir, 'task-1', 'device-runs', 'run-1'), { recursive: true })

    const app = await createApp(tasksDir)
    const missingEvidence = await app.inject({
      method: 'GET',
      url: '/api/tasks/task-1/device-runs/run-1/evidence/result.json',
    })
    const missingRun = await app.inject({
      method: 'GET',
      url: '/api/tasks/task-2/device-runs/run-2/evidence/result.json',
    })

    expect(missingEvidence.statusCode).toBe(404)
    expect(missingEvidence.json()).toMatchObject({ code: 'EVIDENCE_NOT_FOUND' })
    expect(missingRun.statusCode).toBe(404)
    expect(missingRun.json()).toMatchObject({ code: 'DEVICE_RUN_NOT_FOUND' })
    await app.close()
  })

  it.each([
    '../secret.txt',
    '%2e%2e/secret.txt',
  ])('rejects traversal path %s at the HTTP seam', async (relativePath) => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), 'evidence-route-traversal-'))
    directories.push(tasksDir)
    const runDirectory = path.join(tasksDir, 'task-1', 'device-runs', 'run-1')
    await mkdir(path.join(runDirectory, 'diagnostics'), { recursive: true })
    await writeFile(path.join(runDirectory, 'secret.txt'), 'must not be served')

    const app = await createApp(tasksDir)
    const response = await app.inject({
      method: 'GET',
      url: `/api/tasks/task-1/device-runs/run-1/evidence/${relativePath}`,
    })

    expect(response.statusCode).not.toBe(200)
    if (response.statusCode === 400) expect(response.json()).toMatchObject({ code: 'INVALID_EVIDENCE_PATH' })
    await app.close()
  })

  it.each([
    '../secret.txt',
    'diagnostics/../secret.txt',
    'diagnostics\\..\\secret.txt',
    '/absolute/secret.txt',
  ])('rejects unsafe raw Evidence path %s before filesystem access', (relativePath) => {
    expect(resolveEvidenceFilePath('/attempt/task-1/run-1', relativePath)).toBeUndefined()
  })

  it('does not stream directories as Evidence files', async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), 'evidence-route-directory-'))
    directories.push(tasksDir)
    await mkdir(path.join(tasksDir, 'task-1', 'device-runs', 'run-1', 'diagnostics'), { recursive: true })

    const app = await createApp(tasksDir)
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks/task-1/device-runs/run-1/evidence/diagnostics',
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'EVIDENCE_NOT_FOUND' })
    await app.close()
  })

  it('rejects a symlink whose real target leaves the current Attempt directory', async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), 'evidence-route-symlink-'))
    directories.push(tasksDir)
    const runDirectory = path.join(tasksDir, 'task-1', 'device-runs', 'run-1')
    const outsideFile = path.join(tasksDir, 'outside-secret.txt')
    await mkdir(runDirectory, { recursive: true })
    await writeFile(outsideFile, 'must not be served')
    await symlink(outsideFile, path.join(runDirectory, 'leak.txt'))

    const app = await createApp(tasksDir)
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks/task-1/device-runs/run-1/evidence/leak.txt',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'INVALID_EVIDENCE_PATH' })
    await app.close()
  })

  it('does not expose Evidence belonging to another task or run', async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), 'evidence-route-cross-run-'))
    directories.push(tasksDir)
    const otherFile = path.join(tasksDir, 'task-2', 'device-runs', 'run-2', 'attempt-manifest.json')
    await mkdir(path.dirname(otherFile), { recursive: true })
    await writeFile(otherFile, '{"attemptId":"other"}')

    const app = await createApp(tasksDir)
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks/task-2/device-runs/run-2/evidence/attempt-manifest.json',
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'DEVICE_RUN_NOT_FOUND' })
    await app.close()
  })
})
