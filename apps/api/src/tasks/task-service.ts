import { findApkExecutionProtocol } from '../apk-protocols.js'
import type { AppConfig } from '../config.js'
import type { PlatformDatabase } from '../database.js'
import { TaskStoreError } from '../database/stores/task-store.js'
import { DeviceRegistrationError, type DeviceRegistryService } from '../devices/device-registry.js'
import type { DeviceQueueManager } from '../queue.js'
import { assertDiskSpace, estimateTaskDiskBudget } from '../storage-health.js'
import type { DevicePlatform, TaskConnectionMode } from '../types.js'

export interface CreateTaskCommand {
  platform?: DevicePlatform
  name?: string
  apkArtifactId?: string
  /** Legacy single-video input retained for existing clients. */
  videoArtifactId?: string
  /** Ordered input list; order becomes execution and report order. */
  videoArtifactIds?: string[]
  deviceIds?: string[]
  connectionMode?: TaskConnectionMode
  testPlan?: { type?: string; timeoutSeconds?: number }
}

export class TaskRequestError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message)
    this.name = 'TaskRequestError'
  }
}

export class TaskService {
  constructor(
    private readonly database: PlatformDatabase,
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly queue: DeviceQueueManager,
    private readonly config: AppConfig,
    private readonly diskCheck: typeof assertDiskSpace = assertDiskSpace,
  ) {}

  list() { return this.database.listTasks() }
  get(taskId: string) { return this.database.getTask(taskId) }
  report(taskId: string) { return this.database.getReport(taskId) }

  async create(body: CreateTaskCommand) {
    if ((body.platform ?? 'android') !== 'android') {
      throw new TaskRequestError(409, 'PLATFORM_NOT_AVAILABLE', '当前只开放 Android 兼容测试；iOS 与 HarmonyOS 正在规划中')
    }
    const name = body.name?.trim()
    if (!name) throw new TaskRequestError(400, 'TASK_NAME_REQUIRED', '请输入任务名称')

    const apk = body.apkArtifactId ? this.database.getArtifact(body.apkArtifactId) : undefined
    if (!apk || apk.kind !== 'apk') throw new TaskRequestError(400, 'APK_REQUIRED', '请选择已上传的 APK')
    const videoArtifactIds = this.resolveVideoArtifactIds(body)
    const videos = this.resolveVideoArtifacts(videoArtifactIds)
    if (!findApkExecutionProtocol(apk.packageName)) {
      throw new TaskRequestError(400, 'UNSUPPORTED_APK_PROTOCOL', `APK 包名 ${apk.packageName ?? '未知'} 尚未配置可执行协议`)
    }
    if (body.testPlan?.type !== 'sdk-video-processing-compatibility') {
      throw new TaskRequestError(400, 'INVALID_TEST_PLAN', '不支持此测试计划')
    }

    const deviceIds = body.deviceIds ?? []
    if (!deviceIds.length) throw new TaskRequestError(400, 'DEVICE_REQUIRED', '请至少选择一台在线 Android 真机')
    if (new Set(deviceIds).size !== deviceIds.length) {
      throw new TaskRequestError(400, 'DUPLICATE_DEVICE_ID', '设备列表中存在重复 ID')
    }

    const connectionMode = body.connectionMode ?? 'auto'
    if (!(['auto', 'usb', 'network'] as const).includes(connectionMode)) {
      throw new TaskRequestError(400, 'INVALID_CONNECTION_MODE', '连接模式只能是 auto、usb 或 network')
    }
    for (const deviceId of deviceIds) {
      try {
        // 创建时只验证当前模式至少存在一个可用连接；实际 Endpoint 在该 Run
        // 离开物理设备队列、真正开始执行前重新解析并固化，避免长时间排队后使用过期连接。
        await this.deviceRegistry.resolveExecutionEndpoint(deviceId, connectionMode)
      } catch (error) {
        if (error instanceof DeviceRegistrationError) {
          throw new TaskRequestError(error.statusCode, error.code, error.message)
        }
        throw error
      }
    }

    const inputVideoBytes = videos.reduce((total, video) => total + video.sizeBytes, 0)
    const budget = estimateTaskDiskBudget({
      inputVideoBytes,
      videoCount: videos.length,
      deviceCount: deviceIds.length,
      outputExpansionFactor: this.config.taskOutputExpansionFactor ?? 1.5,
      perVideoRunOverheadBytes: this.config.taskVideoRunOverheadBytes ?? (this.config.maxLogcatBytes + 64 * 1024 * 1024),
      safetyReserveBytes: this.config.minFreeDiskBytes,
    })
    await this.diskCheck(this.config.dataDir, budget.requiredAvailableBytes)

    const timeout = Number(body.testPlan?.timeoutSeconds ?? 300)
    const timeoutSeconds = Number.isFinite(timeout) ? Math.max(30, Math.min(1800, timeout)) : 300
    // 此处到 enqueueTask 之间没有 await；先检查可接收状态，避免关闭竞态留下 queued 任务。
    this.queue.assertAccepting()
    let task
    try {
      task = this.database.createTask({
        platform: 'android', name, apkArtifactId: apk.id, videoArtifactIds, deviceIds, timeoutSeconds,
        connectionMode,
      })
    } catch (error) {
      if (error instanceof TaskStoreError) throw mapTaskStoreError(error)
      throw error
    }
    this.queue.enqueueTask(task.id)
    return task
  }

  cancel(taskId: string) {
    if (!this.database.getTask(taskId)) throw new TaskRequestError(404, 'TASK_NOT_FOUND', '测试任务不存在')
    this.queue.cancel(taskId)
    return this.database.getTask(taskId)
  }

  private resolveVideoArtifactIds(body: CreateTaskCommand) {
    if (body.videoArtifactIds !== undefined && !Array.isArray(body.videoArtifactIds)) {
      throw new TaskRequestError(400, 'INVALID_VIDEO_ARTIFACT_IDS', 'videoArtifactIds 必须是有序字符串数组')
    }
    const ids = body.videoArtifactIds?.length
      ? body.videoArtifactIds
      : body.videoArtifactId ? [body.videoArtifactId] : []
    if (!ids.length) throw new TaskRequestError(400, 'VIDEO_REQUIRED', '请至少选择一个已上传的 MP4')
    if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new TaskRequestError(400, 'INVALID_VIDEO_ARTIFACT_IDS', 'videoArtifactIds 只能包含有效字符串 ID')
    }
    if (ids.length > this.config.maxTaskVideos) {
      throw new TaskRequestError(400, 'VIDEO_LIMIT_EXCEEDED', `单任务最多允许 ${this.config.maxTaskVideos} 个视频`)
    }
    if (new Set(ids).size !== ids.length) {
      throw new TaskRequestError(400, 'DUPLICATE_VIDEO_ID', '同一任务不能重复加入相同的视频 Artifact')
    }
    return [...ids]
  }

  private resolveVideoArtifacts(ids: string[]) {
    const videos = ids.map((id) => {
      const artifact = this.database.getArtifact(id)
      if (!artifact) throw new TaskRequestError(400, 'VIDEO_NOT_FOUND', `视频 Artifact ${id} 不存在`)
      if (artifact.kind !== 'video') throw new TaskRequestError(400, 'INVALID_VIDEO_ARTIFACT', `Artifact ${id} 不是视频`)
      if (artifact.sizeBytes > this.config.maxVideoBytes) {
        throw new TaskRequestError(413, 'VIDEO_TOO_LARGE', `视频 ${artifact.originalName} 超过单视频大小上限`)
      }
      return artifact
    })
    if (videos.reduce((total, video) => total + video.sizeBytes, 0) > this.config.maxTaskInputVideoBytes) {
      throw new TaskRequestError(413, 'TASK_VIDEO_BYTES_EXCEEDED', '任务输入视频总大小超过上限')
    }
    return videos
  }
}

function mapTaskStoreError(error: TaskStoreError) {
  const statusCode = error.code === 'VIDEO_TOO_LARGE' || error.code === 'TASK_VIDEO_BYTES_EXCEEDED' ? 413 : 400
  return new TaskRequestError(statusCode, error.code, error.message)
}
