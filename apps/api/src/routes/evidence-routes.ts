import { createReadStream } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'

import type { AppConfig } from '../config.js'
import type { PlatformDatabase } from '../database.js'
import { sendVideoFile } from '../http-file.js'

export function registerEvidenceRoutes(app: FastifyInstance, database: PlatformDatabase, config: AppConfig) {
  app.get<{ Params: { taskId: string; runId: string } }>('/api/tasks/:taskId/device-runs/:runId/logcat', async (request, reply) => {
    const { taskId, runId } = request.params
    if (!database.hasDeviceRun(taskId, runId)) return reply.code(404).send({ code: 'DEVICE_RUN_NOT_FOUND', message: '设备执行记录不存在' })
    const filePath = path.join(config.tasksDir, taskId, 'device-runs', runId, 'logcat.txt')
    try {
      await access(filePath)
      reply.header('Content-Type', 'text/plain; charset=utf-8')
      const execution = database.getDeviceRunExecution(taskId, runId)
      const deviceId = execution?.deviceId?.replace(/[^A-Za-z0-9._-]/g, '_') || 'device'
      reply.header('Content-Disposition', `attachment; filename="logcat-${deviceId}-${runId}.txt"`)
      return reply.send(createReadStream(filePath))
    } catch { return reply.code(404).send({ code: 'LOGCAT_NOT_FOUND', message: '当前任务尚未收集到 logcat.txt' }) }
  })

  app.get<{ Params: { taskId: string; runId: string } }>('/api/tasks/:taskId/device-runs/:runId/screenshots/final', async (request, reply) => {
    const { taskId, runId } = request.params
    if (!database.hasDeviceRun(taskId, runId)) return reply.code(404).send({ code: 'DEVICE_RUN_NOT_FOUND', message: '设备执行记录不存在' })
    const filePath = path.join(config.tasksDir, taskId, 'device-runs', runId, 'screenshots', 'final.png')
    try {
      await access(filePath)
      reply.header('Content-Type', 'image/png')
      reply.header('Content-Disposition', 'inline; filename="final.png"')
      return reply.send(createReadStream(filePath))
    } catch { return reply.code(404).send({ code: 'SCREENSHOT_NOT_FOUND', message: '当前任务尚未收集到最终截图' }) }
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
