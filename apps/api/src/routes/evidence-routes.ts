import { createReadStream } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'

import type { AppConfig } from '../config.js'
import type { PlatformDatabase } from '../database.js'
import { sendVideoFile } from '../http-file.js'

export function resolveEvidenceFilePath(runDirectory: string, relativePath: string): string | undefined {
  const parts = relativePath.split(/[\\/]+/)
  if (!relativePath || path.isAbsolute(relativePath) || parts.some((part) => !part || part === '.' || part === '..')) {
    return undefined
  }
  const resolvedRunDirectory = path.resolve(runDirectory)
  const filePath = path.resolve(resolvedRunDirectory, relativePath)
  return filePath.startsWith(`${resolvedRunDirectory}${path.sep}`) ? filePath : undefined
}

export function registerEvidenceRoutes(app: FastifyInstance, database: PlatformDatabase, config: AppConfig) {
  app.get<{ Params: { taskId: string; runId: string; '*': string } }>('/api/tasks/:taskId/device-runs/:runId/evidence/*', async (request, reply) => {
    const { taskId, runId } = request.params
    if (!database.hasDeviceRun(taskId, runId)) {
      return reply.code(404).send({ code: 'DEVICE_RUN_NOT_FOUND', message: '设备执行记录不存在' })
    }

    const relativePath = request.params['*']
    const runDirectory = path.resolve(config.tasksDir, taskId, 'device-runs', runId)
    const filePath = resolveEvidenceFilePath(runDirectory, relativePath)
    if (!filePath) return reply.code(400).send({ code: 'INVALID_EVIDENCE_PATH', message: 'Evidence 路径不合法' })
    try {
      const [realRunDirectory, realFilePath] = await Promise.all([realpath(runDirectory), realpath(filePath)])
      if (!realFilePath.startsWith(`${realRunDirectory}${path.sep}`)) {
        return reply.code(400).send({ code: 'INVALID_EVIDENCE_PATH', message: 'Evidence 不得离开当前 Attempt 目录' })
      }
      await access(realFilePath)
      if (!(await stat(realFilePath)).isFile()) {
        return reply.code(404).send({ code: 'EVIDENCE_NOT_FOUND', message: '当前 Attempt 尚未收集该 Evidence' })
      }
      const extension = path.extname(realFilePath).toLowerCase()
      const contentType = extension === '.json' ? 'application/json; charset=utf-8'
        : extension === '.xml' ? 'application/xml; charset=utf-8'
          : extension === '.txt' ? 'text/plain; charset=utf-8'
            : extension === '.png' ? 'image/png' : 'application/octet-stream'
      reply.header('Content-Type', contentType)
      reply.header('Content-Disposition', `attachment; filename="${path.basename(realFilePath).replace(/[^A-Za-z0-9._-]/g, '_')}"`)
      return reply.send(createReadStream(realFilePath))
    } catch {
      return reply.code(404).send({ code: 'EVIDENCE_NOT_FOUND', message: '当前 Attempt 尚未收集该 Evidence' })
    }
  })
  /**
   * 多视频任务的 logcat/截图存放在每个视频 Attempt 的证据目录下，而不是 run 根目录；
   * 单视频任务与 legacy 任务仍使用 run 根目录。这里在两类布局之间解析出真实存在的文件。
   */
  async function resolveRunScopedFile(input: {
    taskId: string
    runId: string
    taskVideoId?: string
    relativePath: string
  }): Promise<string | undefined> {
    const runDirectory = path.resolve(config.tasksDir, input.taskId, 'device-runs', input.runId)
    let evidenceDirectory: string | undefined
    if (input.taskVideoId) {
      const result = database.getVideoRunResultForDeviceRun(input.taskId, input.runId, input.taskVideoId)
      evidenceDirectory = result ? database.getVideoResultLatestAttemptEvidenceDirectory(result.id) : undefined
    } else {
      evidenceDirectory = database.getDeviceRunLatestAttemptEvidenceDirectory(input.taskId, input.runId)
    }

    const candidateDirectories = evidenceDirectory ? [runDirectory, path.resolve(evidenceDirectory)] : [runDirectory]
    const seenDirectories = new Set<string>()
    for (const directory of candidateDirectories) {
      if (seenDirectories.has(directory)) continue
      seenDirectories.add(directory)
      if (directory !== runDirectory && !directory.startsWith(`${runDirectory}${path.sep}`)) continue
      const filePath = path.join(directory, input.relativePath)
      try {
        await access(filePath)
        if ((await stat(filePath)).isFile()) return filePath
      } catch { /* 尝试下一个候选目录 */ }
    }
    return undefined
  }

  app.get<{ Params: { taskId: string; runId: string }; Querystring: { video?: string } }>('/api/tasks/:taskId/device-runs/:runId/logcat', async (request, reply) => {
    const { taskId, runId } = request.params
    if (!database.hasDeviceRun(taskId, runId)) return reply.code(404).send({ code: 'DEVICE_RUN_NOT_FOUND', message: '设备执行记录不存在' })
    const taskVideoId = typeof request.query.video === 'string' && request.query.video ? request.query.video : undefined
    const filePath = await resolveRunScopedFile({ taskId, runId, taskVideoId, relativePath: 'logcat.txt' })
    if (!filePath) return reply.code(404).send({ code: 'LOGCAT_NOT_FOUND', message: '当前任务尚未收集到 logcat.txt' })
    reply.header('Content-Type', 'text/plain; charset=utf-8')
    const execution = database.getDeviceRunExecution(taskId, runId)
    const deviceId = execution?.deviceId?.replace(/[^A-Za-z0-9._-]/g, '_') || 'device'
    const videoSuffix = taskVideoId ? `-${taskVideoId.replace(/[^A-Za-z0-9._-]/g, '_')}` : ''
    reply.header('Content-Disposition', `attachment; filename="logcat-${deviceId}-${runId}${videoSuffix}.txt"`)
    return reply.send(createReadStream(filePath))
  })

  app.get<{ Params: { taskId: string; runId: string }; Querystring: { video?: string } }>('/api/tasks/:taskId/device-runs/:runId/screenshots/final', async (request, reply) => {
    const { taskId, runId } = request.params
    if (!database.hasDeviceRun(taskId, runId)) return reply.code(404).send({ code: 'DEVICE_RUN_NOT_FOUND', message: '设备执行记录不存在' })
    const taskVideoId = typeof request.query.video === 'string' && request.query.video ? request.query.video : undefined
    const filePath = await resolveRunScopedFile({ taskId, runId, taskVideoId, relativePath: path.join('screenshots', 'final.png') })
    if (!filePath) return reply.code(404).send({ code: 'SCREENSHOT_NOT_FOUND', message: '当前任务尚未收集到最终截图' })
    reply.header('Content-Type', 'image/png')
    reply.header('Content-Disposition', `inline; filename="final${taskVideoId ? `-${taskVideoId.replace(/[^A-Za-z0-9._-]/g, '_')}` : ''}.png"`)
    return reply.send(createReadStream(filePath))
  })

  for (const [suffix, download] of [['content', false], ['download', true]] as const) {
    app.get<{ Params: { id: string } }>(`/api/outputs/:id/${suffix}`, async (request, reply) => {
      const output = database.getOutputRecord(request.params.id)
      if (!output) return reply.code(404).send({ code: 'OUTPUT_NOT_FOUND', message: '输出视频不存在' })
      const filePath = String(output.storage_path)
      try {
        await access(filePath)
        return sendVideoFile(request, reply, filePath, download ? { downloadName: String(output.name) } : {})
      } catch { return reply.code(404).send({ code: 'OUTPUT_FILE_MISSING', message: '输出视频记录存在，但磁盘文件不存在' }) }
    })
  }
}
