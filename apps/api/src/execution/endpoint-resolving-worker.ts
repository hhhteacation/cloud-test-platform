import type { PlatformDatabase } from '../database.js'
import { DeviceRegistrationError, type DeviceRegistryService } from '../devices/device-registry.js'
import type { DeviceRunWorker } from '../queue.js'
import type { TaskConnectionMode } from '../types.js'

class EndpointResolutionDeadlineError extends Error {
  readonly code = 'ENDPOINT_RESOLUTION_DEADLINE_EXCEEDED'

  constructor(readonly deadlineMs: number) {
    super(`首次 Endpoint 解析超过 ${deadlineMs}ms 预算`)
    this.name = 'EndpointResolutionDeadlineError'
  }
}

class EndpointResolutionCancelledError extends Error {
  constructor() {
    super('任务已取消，停止首次 Endpoint 解析')
    this.name = 'EndpointResolutionCancelledError'
  }
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new EndpointResolutionCancelledError()
}

function waitForResolution<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(abortReason(signal)))
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

/**
 * Resolves and freezes the ADB Endpoint at the physical-device queue seam.
 * The platform Worker receives execution-ready context and never decides between USB and network.
 */
export class EndpointResolvingWorker implements DeviceRunWorker {
  private readonly activeResolutions = new Map<string, Set<AbortController>>()

  constructor(
    private readonly database: PlatformDatabase,
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly delegate: DeviceRunWorker,
    private readonly resolutionDeadlineMs = 15_000,
  ) {}

  async execute(job: Parameters<DeviceRunWorker['execute']>[0]) {
    const task = this.database.getTask(job.taskId)
    if (!task || task.status === 'cancelled') return

    const controller = new AbortController()
    let taskControllers = this.activeResolutions.get(job.taskId)
    if (!taskControllers) {
      taskControllers = new Set()
      this.activeResolutions.set(job.taskId, taskControllers)
    }
    taskControllers.add(controller)
    const deadlineError = new EndpointResolutionDeadlineError(this.resolutionDeadlineMs)
    const deadlineTimer = setTimeout(() => controller.abort(deadlineError), this.resolutionDeadlineMs)
    deadlineTimer.unref()

    let endpoint
    try {
      const resolution = this.deviceRegistry.resolveExecutionEndpoint(
        job.deviceId,
        (task.connectionMode ?? 'auto') as TaskConnectionMode,
        { signal: controller.signal },
      )
      endpoint = await waitForResolution(resolution, controller.signal)
    } catch (error) {
      if (error instanceof EndpointResolutionCancelledError) return
      if (error instanceof EndpointResolutionDeadlineError) {
        this.database.failDeviceRun(job, error.code, error.message)
        return
      }
      if (error instanceof DeviceRegistrationError) {
        this.database.failDeviceRun(job, error.code, error.message)
        return
      }
      throw error
    } finally {
      clearTimeout(deadlineTimer)
      taskControllers.delete(controller)
      if (taskControllers.size === 0) this.activeResolutions.delete(job.taskId)
    }

    const assigned = this.database.assignDeviceRunEndpoint(job, {
      endpointId: endpoint.id,
      connectionKind: endpoint.kind,
      adbSerial: endpoint.adbSerial,
    })
    // 解析期间任务可能被取消；Store 的 guarded update 是最终仲裁点。
    if (!assigned) return
    await this.delegate.execute(job)
  }

  cancelTask(taskId: string) {
    for (const controller of this.activeResolutions.get(taskId) ?? []) {
      controller.abort(new EndpointResolutionCancelledError())
    }
    this.delegate.cancelTask(taskId)
  }
}
