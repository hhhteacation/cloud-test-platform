import { MockTestRunner } from '../runner/mockRunner'
import type {
  ApkAsset,
  Artifact,
  ArtifactKind,
  CreateTaskInput,
  TestPlatformClient,
  TaskDeletionReceipt,
  VideoAsset,
} from '../types'
import { DEVICES } from '../features/tasks/taskDefinitions'

import { readTasks, writeTasks } from '../runner/mockStorage'
import { PlatformApiError } from './errors'

export class MockTestPlatformClient implements TestPlatformClient {
  readonly mode = 'mock' as const
  private readonly runner = new MockTestRunner()
  private readonly artifacts = new Map<string, Artifact>()

  async listDevices() {
    return DEVICES.map((device) => ({
      ...device,
      connectionStatus:
        device.id === 'honor-magic-v3' ? ('online' as const) : ('unknown' as const),
    }))
  }

  async discoverDevices() {
    const devices = await this.listDevices()
    return devices
      .filter((device) => device.platform === 'android' && device.serial)
      .map((device) => ({
        serial: device.serial!,
        platform: 'android' as const,
        manufacturer: device.manufacturer,
        name: device.name,
        model: device.model,
        androidVersion: device.osVersion.replace(/^Android\s*/i, ''),
        apiLevel: device.apiLevel,
        architecture: device.architecture,
        connectionStatus: device.connectionStatus ?? ('unknown' as const),
        registeredDeviceId: device.id,
      }))
  }

  async registerDevice(): Promise<import('../types').DeviceProfile> {
    throw new PlatformApiError('Mock 模式不连接真实 ADB，请使用真实后端模式录入设备', 'MOCK_DEVICE_REGISTRATION_UNAVAILABLE', 409)
  }

  async uploadArtifact(file: File, kind: ArtifactKind) {
    const artifact: Artifact = {
      id: `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      kind,
      name: file.name,
      sizeBytes: file.size,
      mimeType:
        file.type ||
        (kind === 'apk'
          ? 'application/vnd.android.package-archive'
          : 'video/mp4'),
      previewUrl: kind === 'video' ? URL.createObjectURL(file) : undefined,
      packageName: kind === 'apk' ? 'com.sdktest.platform' : undefined,
    }
    this.artifacts.set(artifact.id, artifact)
    return artifact
  }

  async createTask(input: CreateTaskInput) {
    const apk = this.artifacts.get(input.apkArtifactId) as ApkAsset | undefined
    const video = this.artifacts.get(input.videoArtifactId) as VideoAsset | undefined
    if (!apk || !video?.previewUrl) throw new Error('Mock 上传文件记录不存在')

    return this.runner.createTask({
      name: input.name,
      apk,
      asset: video,
      deviceIds: input.deviceIds,
    })
  }

  async listTasks() {
    try {
      return readTasks()
    } catch {
      return []
    }
  }

  getTask(taskId: string) {
    return this.runner.getTask(taskId)
  }

  subscribeTask = this.runner.subscribeTask.bind(this.runner)
  getReport = this.runner.getReport.bind(this.runner)
  cancelTask = this.runner.cancelTask.bind(this.runner)

  async deleteTask(taskId: string): Promise<TaskDeletionReceipt> {
    const tasks = readTasks()
    const task = tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new PlatformApiError('测试任务不存在', 'TASK_NOT_FOUND', 404)
    if (!task.capabilities.canDelete) {
      throw new PlatformApiError(
        task.capabilities.deleteBlockedReason ?? '当前任务不能删除',
        'TASK_NOT_DELETABLE',
        409,
      )
    }

    const remainingTasks = tasks.filter((candidate) => candidate.id !== taskId)
    const referencedArtifactIds = new Set(
      remainingTasks.flatMap((candidate) => [candidate.apk?.id, candidate.asset.id].filter(Boolean) as string[]),
    )
    const taskArtifactIds = Array.from(new Set([task.apk?.id, task.asset.id].filter(Boolean) as string[]))
    const deletedArtifactIds = taskArtifactIds.filter((id) => !referencedArtifactIds.has(id))
    const retainedArtifactIds = taskArtifactIds.filter((id) => referencedArtifactIds.has(id))

    for (const artifactId of deletedArtifactIds) {
      const artifact = this.artifacts.get(artifactId)
      if (artifact?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(artifact.previewUrl)
      this.artifacts.delete(artifactId)
    }

    writeTasks(remainingTasks)
    const runs = Object.values(task.runs)
    return {
      taskId,
      deletedAt: new Date().toISOString(),
      deletedRecordCounts: {
        tasks: 1,
        deviceRuns: runs.length,
        checkResults: runs.reduce((total, run) => total + run.checks.length, 0),
        logs: runs.reduce((total, run) => total + run.logs.length, 0),
        outputs: runs.reduce((total, run) => total + run.outputs.length, 0),
      },
      deletedArtifactIds,
      retainedArtifactIds,
      fileCleanupWarnings: [],
    }
  }
}
