import type { DeviceRunJob, PlatformDatabase } from './database.js'

/** Worker interface shared by platform-specific executors. */
export interface DeviceRunWorker {
  execute(job: DeviceRunJob): Promise<void>
  cancelTask(taskId: string): void
}

interface DeviceLane {
  pending: DeviceRunJob[]
  knownRunIds: Set<string>
  running?: DeviceRunJob
  draining: boolean
}

export class QueueNotAcceptingError extends Error {
  readonly code = 'QUEUE_NOT_ACCEPTING'
  constructor() {
    super('服务正在关闭，暂不接受新的测试任务')
    this.name = 'QueueNotAcceptingError'
  }
}

/**
 * Schedules one serial lane per physical device.
 * Runs on the same device are sequential; different device lanes drain concurrently.
 */
export class DeviceQueueManager {
  private readonly lanes = new Map<string, DeviceLane>()
  private accepting = true

  constructor(
    private readonly database: PlatformDatabase,
    private readonly worker: DeviceRunWorker,
  ) {}

  restore() {
    if (!this.accepting) return
    this.enqueueJobs(this.database.listQueuedDeviceRunJobs())
  }

  enqueueTask(taskId: string) {
    this.assertAccepting()
    this.enqueueJobs(this.database.listQueuedDeviceRunJobs(taskId))
  }

  isAccepting() {
    return this.accepting
  }

  assertAccepting() {
    if (!this.accepting) throw new QueueNotAcceptingError()
  }

  stopAccepting() {
    this.accepting = false
  }

  isIdle() {
    return this.lanes.size === 0
  }

  async shutdown(timeoutMs = 15_000, cancellationGraceMs = 3_000) {
    this.stopAccepting()
    if (await this.waitUntilIdle(timeoutMs)) return true

    // 正常排空超时后，主动取消仍在运行或等待的任务，触发 Worker 的设备与进程清理。
    const activeTaskIds = new Set<string>()
    for (const lane of this.lanes.values()) {
      if (lane.running) activeTaskIds.add(lane.running.taskId)
      for (const job of lane.pending) activeTaskIds.add(job.taskId)
    }
    for (const taskId of activeTaskIds) this.cancel(taskId)

    return this.waitUntilIdle(cancellationGraceMs)
  }

  private async waitUntilIdle(timeoutMs: number) {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (!this.isIdle() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return this.isIdle()
  }

  cancel(taskId: string) {
    this.database.cancelTask(taskId)
    for (const lane of this.lanes.values()) {
      lane.pending = lane.pending.filter((job) => {
        if (job.taskId !== taskId) return true
        lane.knownRunIds.delete(job.runId)
        return false
      })
    }
    this.worker.cancelTask(taskId)
  }

  private enqueueJobs(jobs: DeviceRunJob[]) {
    for (const job of jobs) {
      const lane = this.getLane(job.deviceId)
      if (lane.knownRunIds.has(job.runId) || lane.running?.runId === job.runId) continue
      lane.knownRunIds.add(job.runId)
      lane.pending.push(job)
      void this.drain(job.deviceId, lane)
    }
  }

  private getLane(deviceId: string) {
    let lane = this.lanes.get(deviceId)
    if (!lane) {
      lane = { pending: [], knownRunIds: new Set(), draining: false }
      this.lanes.set(deviceId, lane)
    }
    return lane
  }

  private async drain(deviceId: string, lane: DeviceLane) {
    if (lane.draining) return
    lane.draining = true
    try {
      while (lane.pending.length > 0) {
        const job = lane.pending.shift()!
        lane.running = job
        try {
          if (!this.database.isCancelled(job.taskId)) await this.worker.execute(job)
        } catch (error) {
          console.error(`设备队列执行失败：${job.deviceId}/${job.runId}`, error)
          this.database.failDeviceRun(
            job,
            'WORKER_UNEXPECTED_ERROR',
            error instanceof Error ? error.message : '设备执行器发生未预期错误',
          )
        } finally {
          lane.knownRunIds.delete(job.runId)
          lane.running = undefined
        }
      }
    } finally {
      lane.draining = false
      if (lane.pending.length === 0 && !lane.running) this.lanes.delete(deviceId)
    }
  }
}
