import type { PlatformDatabase } from '../database.js'
import { DeviceRegistrationError, type DeviceRegistryService } from '../devices/device-registry.js'
import type { DeviceRunWorker } from '../queue.js'
import type { TaskConnectionMode } from '../types.js'

/**
 * Resolves and freezes the ADB Endpoint at the physical-device queue seam.
 * The platform Worker receives execution-ready context and never decides between USB and network.
 */
export class EndpointResolvingWorker implements DeviceRunWorker {
  constructor(
    private readonly database: PlatformDatabase,
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly delegate: DeviceRunWorker,
  ) {}

  async execute(job: Parameters<DeviceRunWorker['execute']>[0]) {
    const task = this.database.getTask(job.taskId)
    if (!task || task.status === 'cancelled') return

    try {
      const endpoint = await this.deviceRegistry.resolveExecutionEndpoint(
        job.deviceId,
        (task.connectionMode ?? 'auto') as TaskConnectionMode,
      )
      const assigned = this.database.assignDeviceRunEndpoint(job, {
        endpointId: endpoint.id,
        connectionKind: endpoint.kind,
        adbSerial: endpoint.adbSerial,
      })
      // 解析期间任务可能被取消；Store 的 guarded update 是最终仲裁点。
      if (!assigned) return
      await this.delegate.execute(job)
    } catch (error) {
      if (error instanceof DeviceRegistrationError) {
        this.database.failDeviceRun(job, error.code, error.message)
        return
      }
      throw error
    }
  }

  cancelTask(taskId: string) {
    this.delegate.cancelTask(taskId)
  }
}
