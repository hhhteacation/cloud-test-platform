import { createReadStream } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import path from 'node:path'

import multipart from '@fastify/multipart'
import Fastify from 'fastify'

import { AdbWorker } from './adb.js'
import { APK_EXECUTION_PROTOCOLS, findApkExecutionProtocol, toPublicApkProtocol } from './apk-protocols.js'
import { ArtifactService, ArtifactValidationError } from './artifacts.js'
import { artifactsDir, config, tasksDir } from './config.js'
import { PlatformDatabase } from './database.js'
import { AndroidAdbDeviceProvider } from './devices/android-adb-provider.js'
import { DeviceRegistrationError, DeviceRegistryService } from './devices/device-registry.js'
import { sendVideoFile } from './http-file.js'
import { DeviceQueueManager } from './queue.js'
import { registerTaskDeletionRoute } from './routes/task-deletion-route.js'
import { TaskDeletionService } from './task-deletion.js'
import type { ArtifactKind, DevicePlatform } from './types.js'

interface CreateTaskBody {
  platform?: DevicePlatform
  name?: string
  apkArtifactId?: string
  videoArtifactId?: string
  deviceIds?: string[]
  testPlan?: {
    type?: string
    timeoutSeconds?: number
  }
}

function artifactResponse(artifact: ReturnType<PlatformDatabase['insertArtifact']>) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    name: artifact.originalName,
    sizeBytes: artifact.sizeBytes,
    mimeType: artifact.mimeType,
    sha256: artifact.sha256,
    packageName: artifact.packageName,
    protocol: artifact.kind === 'apk'
      ? findApkExecutionProtocol(artifact.packageName)
        ? toPublicApkProtocol(findApkExecutionProtocol(artifact.packageName)!)
        : undefined
      : undefined,
    previewUrl: artifact.kind === 'video' ? `/api/artifacts/${artifact.id}/content` : undefined,
  }
}

export async function buildServer() {
  await mkdir(artifactsDir, { recursive: true })
  await mkdir(tasksDir, { recursive: true })

  const database = new PlatformDatabase()
  const androidDeviceProvider = new AndroidAdbDeviceProvider()
  const deviceRegistry = new DeviceRegistryService(database, [androidDeviceProvider])
  const adbWorker = new AdbWorker(database)
  const queue = new DeviceQueueManager(database, adbWorker)
  const artifactService = new ArtifactService(database)
  const taskDeletionService = new TaskDeletionService(database)
  const app = Fastify({
    logger: true,
    // multipart 文件以流方式读取；bodyLimit 仍需覆盖计划允许的最大单文件。
    bodyLimit: Math.max(config.maxApkBytes, config.maxVideoBytes),
  })

  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: Math.max(config.maxApkBytes, config.maxVideoBytes),
      fields: 5,
    },
  })

  app.get('/api/health', async () => {
    const devices = await deviceRegistry.listRegistered('android')
    return {
      status: 'ok',
      service: 'sdk-video-compat-api',
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
    return protocol
      ? toPublicApkProtocol(protocol)
      : reply.code(404).send({ code: 'APK_PROTOCOL_NOT_FOUND', message: 'APK 执行协议不存在' })
  })

  app.get('/api/devices', async () => deviceRegistry.listRegistered('android'))

  app.post('/api/devices/discover', async (request, reply) => {
    try {
      return await deviceRegistry.discover('android')
    } catch (error) {
      if (error instanceof DeviceRegistrationError) {
        return reply.code(error.statusCode).send({ code: error.code, message: error.message })
      }
      request.log.error(error)
      return reply.code(500).send({ code: 'DEVICE_DISCOVERY_FAILED', message: 'ADB 设备扫描失败，请检查 adb 路径和 USB 连接' })
    }
  })

  app.post<{ Body: { serial?: string } }>('/api/devices/register', async (request, reply) => {
    try {
      const device = await deviceRegistry.register(request.body?.serial ?? '', 'android')
      return reply.code(201).send({ ...device, connectionStatus: 'online' })
    } catch (error) {
      if (error instanceof DeviceRegistrationError) {
        return reply.code(error.statusCode).send({ code: error.code, message: error.message })
      }
      request.log.error(error)
      return reply.code(500).send({ code: 'DEVICE_REGISTER_FAILED', message: '设备录入失败' })
    }
  })

  app.post<{ Querystring: { kind?: string } }>('/api/artifacts', async (request, reply) => {
    const kind = request.query.kind as ArtifactKind | undefined
    if (kind !== 'apk' && kind !== 'video') {
      return reply.code(400).send({ code: 'INVALID_ARTIFACT_KIND', message: 'kind 必须是 apk 或 video' })
    }
    const part = await request.file()
    if (!part) return reply.code(400).send({ code: 'FILE_REQUIRED', message: '请选择要上传的文件' })
    try {
      const artifact = await artifactService.saveUpload(part, kind)
      return reply.code(201).send(artifactResponse(artifact))
    } catch (error) {
      if (error instanceof ArtifactValidationError) {
        return reply.code(400).send({ code: error.code, message: error.message })
      }
      request.log.error(error)
      return reply.code(500).send({ code: 'ARTIFACT_UPLOAD_FAILED', message: error instanceof Error ? error.message : '文件上传失败' })
    }
  })

  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request, reply) => {
    const artifact = database.getArtifact(request.params.id)
    if (!artifact) return reply.code(404).send({ code: 'ARTIFACT_NOT_FOUND', message: '文件记录不存在' })
    return artifactResponse(artifact)
  })

  app.get<{ Params: { id: string } }>('/api/artifacts/:id/content', async (request, reply) => {
    const artifact = database.getArtifact(request.params.id)
    if (!artifact || artifact.kind !== 'video') return reply.code(404).send({ code: 'ARTIFACT_NOT_FOUND', message: '视频素材不存在' })
    return sendVideoFile(request, reply, artifact.storagePath)
  })

  app.post<{ Body: CreateTaskBody }>('/api/tasks', async (request, reply) => {
    const body = request.body ?? {}
    if ((body.platform ?? 'android') !== 'android') {
      return reply.code(409).send({ code: 'PLATFORM_NOT_AVAILABLE', message: '当前只开放 Android 兼容测试；iOS 与 HarmonyOS 正在规划中' })
    }
    const name = body.name?.trim()
    if (!name) return reply.code(400).send({ code: 'TASK_NAME_REQUIRED', message: '请输入任务名称' })

    const apk = body.apkArtifactId ? database.getArtifact(body.apkArtifactId) : undefined
    const video = body.videoArtifactId ? database.getArtifact(body.videoArtifactId) : undefined
    if (!apk || apk.kind !== 'apk') return reply.code(400).send({ code: 'APK_REQUIRED', message: '请选择已上传的 APK' })
    if (!video || video.kind !== 'video') return reply.code(400).send({ code: 'VIDEO_REQUIRED', message: '请选择已上传的 MP4' })
    const apkProtocol = findApkExecutionProtocol(apk.packageName)
    if (!apkProtocol) {
      return reply.code(400).send({
        code: 'UNSUPPORTED_APK_PROTOCOL',
        message: `APK 包名 ${apk.packageName ?? '未知'} 尚未配置可执行协议`,
      })
    }
    if (body.testPlan?.type !== 'sdk-video-processing-compatibility') {
      return reply.code(400).send({ code: 'INVALID_TEST_PLAN', message: '不支持此测试计划' })
    }

    const submittedDeviceIds = body.deviceIds ?? []
    if (!submittedDeviceIds.length) {
      return reply.code(400).send({ code: 'DEVICE_REQUIRED', message: '请至少选择一台在线 Android 真机' })
    }
    if (new Set(submittedDeviceIds).size !== submittedDeviceIds.length) {
      return reply.code(400).send({ code: 'DUPLICATE_DEVICE_ID', message: '设备列表中存在重复 ID' })
    }

    const liveDevices = await deviceRegistry.listRegistered('android')
    const liveById = new Map(liveDevices.map((device) => [device.id, device]))
    for (const deviceId of submittedDeviceIds) {
      const device = liveById.get(deviceId)
      if (!device) return reply.code(400).send({ code: 'DEVICE_NOT_REGISTERED', message: `设备 ${deviceId} 尚未录入` })
      if (device.platform !== 'android' || device.executionMode !== 'adb' || !device.eligible || !device.serial) {
        return reply.code(400).send({ code: 'DEVICE_NOT_ELIGIBLE', message: `${device.name} 不能执行 Android ADB 真机任务` })
      }
      if (device.connectionStatus !== 'online') {
        return reply.code(409).send({ code: 'DEVICE_NOT_ONLINE', message: `${device.name} 当前未连接或未授权，请重新扫描设备` })
      }
    }

    const timeoutSeconds = Math.max(30, Math.min(1800, Number(body.testPlan?.timeoutSeconds ?? 300)))
    const task = database.createTask({
      platform: 'android',
      name,
      apkArtifactId: apk.id,
      videoArtifactId: video.id,
      deviceIds: submittedDeviceIds,
      timeoutSeconds,
    })
    queue.enqueueTask(task.id)
    return reply.code(201).send(task)
  })

  app.get('/api/tasks', async () => database.listTasks())

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const task = database.getTask(request.params.id)
    return task ?? reply.code(404).send({ code: 'TASK_NOT_FOUND', message: '测试任务不存在' })
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (request, reply) => {
    const task = database.getTask(request.params.id)
    if (!task) return reply.code(404).send({ code: 'TASK_NOT_FOUND', message: '测试任务不存在' })
    queue.cancel(task.id)
    return reply.code(202).send(database.getTask(task.id))
  })

  registerTaskDeletionRoute(app, taskDeletionService)

  app.get<{ Params: { id: string } }>('/api/tasks/:id/report', async (request, reply) => {
    const report = database.getReport(request.params.id)
    return report ?? reply.code(404).send({ code: 'TASK_NOT_FOUND', message: '测试任务不存在' })
  })


  app.get<{ Params: { taskId: string; runId: string } }>(
    '/api/tasks/:taskId/device-runs/:runId/logcat',
    async (request, reply) => {
      const { taskId, runId } = request.params
      if (!database.hasDeviceRun(taskId, runId)) {
        return reply.code(404).send({ code: 'DEVICE_RUN_NOT_FOUND', message: '设备执行记录不存在' })
      }
      const filePath = path.join(tasksDir, taskId, 'device-runs', runId, 'logcat.txt')
      try {
        await access(filePath)
        reply.header('Content-Type', 'text/plain; charset=utf-8')
        reply.header('Content-Disposition', 'attachment; filename="logcat.txt"')
        return reply.send(createReadStream(filePath))
      } catch {
        return reply.code(404).send({ code: 'LOGCAT_NOT_FOUND', message: '当前任务尚未收集到 logcat.txt' })
      }
    },
  )

  app.get<{ Params: { taskId: string; runId: string } }>(
    '/api/tasks/:taskId/device-runs/:runId/screenshots/final',
    async (request, reply) => {
      const { taskId, runId } = request.params
      if (!database.hasDeviceRun(taskId, runId)) {
        return reply.code(404).send({ code: 'DEVICE_RUN_NOT_FOUND', message: '设备执行记录不存在' })
      }
      const filePath = path.join(tasksDir, taskId, 'device-runs', runId, 'screenshots', 'final.png')
      try {
        await access(filePath)
        reply.header('Content-Type', 'image/png')
        reply.header('Content-Disposition', 'inline; filename="final.png"')
        return reply.send(createReadStream(filePath))
      } catch {
        return reply.code(404).send({ code: 'SCREENSHOT_NOT_FOUND', message: '当前任务尚未收集到最终截图' })
      }
    },
  )

  app.get<{ Params: { id: string } }>('/api/outputs/:id/content', async (request, reply) => {
    const output = database.getOutputRecord(request.params.id)
    if (!output) return reply.code(404).send({ code: 'OUTPUT_NOT_FOUND', message: '输出视频不存在' })
    const filePath = String(output.storage_path)
    try {
      await access(filePath)
      return sendVideoFile(request, reply, filePath)
    } catch {
      return reply.code(404).send({ code: 'OUTPUT_FILE_MISSING', message: '输出视频记录存在，但磁盘文件不存在' })
    }
  })

  app.get<{ Params: { id: string } }>('/api/outputs/:id/download', async (request, reply) => {
    const output = database.getOutputRecord(request.params.id)
    if (!output) return reply.code(404).send({ code: 'OUTPUT_NOT_FOUND', message: '输出视频不存在' })
    const filePath = String(output.storage_path)
    try {
      await access(filePath)
      return sendVideoFile(request, reply, filePath, { downloadName: String(output.name) })
    } catch {
      return reply.code(404).send({ code: 'OUTPUT_FILE_MISSING', message: '输出视频记录存在，但磁盘文件不存在' })
    }
  })

  app.addHook('onClose', async () => database.close())
  queue.restore()
  return app
}
