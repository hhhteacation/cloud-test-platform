import multipart from '@fastify/multipart'
import Fastify from 'fastify'

import { AdbWorker } from './adb.js'
import { ArtifactService } from './artifacts.js'
import { config as defaultConfig, type AppConfig } from './config.js'
import { PlatformDatabase } from './database.js'
import { AndroidAdbDeviceProvider } from './devices/android-adb-provider.js'
import { DeviceRegistryService } from './devices/device-registry.js'
import { registerLocalAccessGuard } from './local-access.js'
import { MediaIntegrityChecker } from './media-integrity.js'
import { BoundedProcessRunner } from './process.js'
import { DeviceQueueManager } from './queue.js'
import { EndpointResolvingWorker } from './execution/endpoint-resolving-worker.js'
import { registerArtifactRoutes } from './routes/artifact-routes.js'
import { registerDeviceRoutes } from './routes/device-routes.js'
import { registerEvidenceRoutes } from './routes/evidence-routes.js'
import { registerSystemRoutes } from './routes/system-routes.js'
import { registerTaskDeletionRoute } from './routes/task-deletion-route.js'
import { registerTaskRoutes } from './routes/task-routes.js'
import { assertRuntimeReady } from './runtime-preflight.js'
import { TaskDeletionService } from './task-deletion.js'
import { TaskService } from './tasks/task-service.js'

export interface BuildServerOptions {
  config?: AppConfig
  /** 仅用于不具备真实 Android/FFmpeg 工具的自动化测试。生产启动不得关闭。 */
  skipPreflight?: boolean
}

/** Composition Root：只负责创建对象、连接 Module、注册路由和生命周期。 */
export async function buildServer(options: BuildServerOptions = {}) {
  const config = options.config ?? defaultConfig
  const processRunner = new BoundedProcessRunner({
    maxOutputBytes: config.maxProcessOutputBytes,
    killGraceMs: config.processKillGraceMs,
  })
  if (!options.skipPreflight) await assertRuntimeReady(config, processRunner)

  const database = new PlatformDatabase({
    databasePath: config.databasePath,
    deviceSerial: config.deviceSerial,
  })
  const androidDeviceProvider = new AndroidAdbDeviceProvider(
    config.adbPath,
    (command, args, runOptions) => processRunner.run(command, args, runOptions),
  )
  const deviceRegistry = new DeviceRegistryService(database, [androidDeviceProvider])
  const mediaIntegrityChecker = new MediaIntegrityChecker({ runner: processRunner, config })
  const adbWorker = new AdbWorker(
    database,
    mediaIntegrityChecker,
    config,
    processRunner,
    async (job) => {
      const task = database.getTask(job.taskId)
      if (!task || task.status === 'cancelled') return undefined
      const endpoint = await deviceRegistry.resolveExecutionEndpoint(
        job.deviceId,
        task.connectionMode ?? 'auto',
      )
      const assigned = database.assignDeviceRunEndpoint(job, {
        endpointId: endpoint.id,
        connectionKind: endpoint.kind,
        adbSerial: endpoint.adbSerial,
      })
      return assigned ? database.getDeviceRunExecution(job.taskId, job.runId) : undefined
    },
  )
  const endpointResolvingWorker = new EndpointResolvingWorker(database, deviceRegistry, adbWorker)
  const queue = new DeviceQueueManager(database, endpointResolvingWorker)
  const artifactService = new ArtifactService(database, { config, processRunner })
  const taskService = new TaskService(database, deviceRegistry, queue, config)
  const taskDeletionService = new TaskDeletionService(database, {
    tasksDir: config.tasksDir,
    artifactsDir: config.artifactsDir,
    trashDir: config.trashDir,
  })

  const app = Fastify({
    logger: true,
    bodyLimit: Math.max(config.maxApkBytes, config.maxVideoBytes),
  })

  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: Math.max(config.maxApkBytes, config.maxVideoBytes),
      fields: 5,
    },
  })
  registerLocalAccessGuard(app)
  registerSystemRoutes(app, deviceRegistry)
  registerDeviceRoutes(app, deviceRegistry)
  registerArtifactRoutes(app, database, artifactService)
  registerTaskRoutes(app, taskService)
  registerTaskDeletionRoute(app, taskDeletionService)
  registerEvidenceRoutes(app, database, config)

  const orphanDirectories = await artifactService.reportOrphans()
  if (orphanDirectories.length) {
    app.log.warn({ orphanDirectories }, '发现未登记 Artifact 目录；Phase 0 仅报告，不自动删除')
  }

  queue.restore()
  app.addHook('onClose', async () => {
    queue.stopAccepting()
    const drained = await queue.shutdown(Math.max(config.processKillGraceMs * 2, 5_000))
    if (!drained) app.log.error('队列在关闭时限内未完全清理，数据库将关闭')
    database.close()
  })

  return app
}
