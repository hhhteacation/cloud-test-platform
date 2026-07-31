import type { DeviceRunJob, PlatformDatabase } from './database.js'

/**
 * Worker seam shared by platform-specific executors.
 * Android uses AdbWorker today; future iOS/HarmonyOS workers can be routed here
 * without changing task routes or database scheduling rules.
 */
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

/**
 * Schedules one serial lane per physical device.
 * Runs on the same device are sequential; different device lanes drain concurrently.
 */
export class DeviceQueueManager {
  private readonly lanes = new Map<string, DeviceLane>()

  constructor(
    private readonly database: PlatformDatabase,
    private readonly worker: DeviceRunWorker,
  ) {}

  restore() {
    this.enqueueJobs(this.database.listQueuedDeviceRunJobs())
  }

  enqueueTask(taskId: string) {
    this.enqueueJobs(this.database.listQueuedDeviceRunJobs(taskId))
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
          // Platform workers normally persist their own domain-specific failure.
          // This queue-level fallback covers exceptions thrown before that logic
          // runs, while failDeviceRun protects terminal/cancelled records.
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
