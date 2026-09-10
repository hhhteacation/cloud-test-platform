import { randomUUID } from 'node:crypto'

import type { PlatformDatabase } from '../database.js'
import type { AppendConnectionEventInput } from '../database/stores/connection-event-store.js'
import type { DesiredNetworkState, ObservedNetworkState } from '../database/stores/device-connection-state-store.js'

interface DeviceConnectionSlot {
  tail: Promise<void>
  inFlight: Map<string, Promise<unknown>>
}

export interface DeviceConnectionOperationContext {
  operationId: string
  generation: number
  deadlineAt: string
  source: string
  signal: AbortSignal
  isCurrent(): boolean
  commit(input: {
    observedState: ObservedNetworkState
    desiredState?: DesiredNetworkState
    activeEndpointId?: string
    clearActiveEndpoint?: boolean
    reasonCode?: string
  }): boolean
  restore(input: {
    observedState: ObservedNetworkState
    desiredState?: DesiredNetworkState
    activeEndpointId?: string
    clearActiveEndpoint?: boolean
    reasonCode?: string
    actionRequired?: string
  }): boolean
  recordHealthFailure(input: { reasonCode: string; nextRetryAt?: string; terminal: boolean; manualAction?: boolean }): boolean
  record(input: Omit<AppendConnectionEventInput, 'deviceId' | 'operationId' | 'generation' | 'source'>): void
}

export interface RunDeviceConnectionOptions {
  source?: string
  signal?: AbortSignal
  observedState?: 'connecting' | 'recovering'
  restoreStateOnAbort?: {
    observedState: ObservedNetworkState
    desiredState?: DesiredNetworkState
    activeEndpointId?: string
    clearActiveEndpoint?: boolean
    reasonCode?: string
    actionRequired?: string
  }
}

export interface PassiveDeviceConnectionHealthInput {
  deviceId: string
  endpointId: string
  generation: number
  evidence: { kind: 'healthy' } | { kind: 'transport_failed'; failureCode: string }
  transportType?: 'tcp_legacy' | 'wireless_tls'
  endpointSummary?: { host?: string; port?: number; transportType?: 'tcp_legacy' | 'wireless_tls'; serviceInstance?: string }
}

export class DeviceConnectionDeadlineExceededError extends Error {
  readonly code = 'NETWORK_RECOVERY_DEADLINE_EXCEEDED'

  constructor() {
    super('联网连接操作超过全局 deadline')
    this.name = 'DeviceConnectionDeadlineExceededError'
  }
}

export class DeviceConnectionControllerShutdownError extends Error {
  readonly code = 'DEVICE_CONNECTION_CONTROLLER_SHUTDOWN'

  constructor() {
    super('设备连接控制器正在关闭')
    this.name = 'DeviceConnectionControllerShutdownError'
  }
}

/**
 * Single-writer entry point for one Physical Device. Equal intents share the
 * same result; different intents are serialized in arrival order per device.
 */
export class DeviceConnectionController {
  private readonly slots = new Map<string, DeviceConnectionSlot>()
  private readonly activeControllers = new Set<AbortController>()
  private shuttingDown = false

  constructor(
    private readonly database: PlatformDatabase,
    private readonly operationDeadlineMs = 180_000,
  ) {}

  run<T>(
    deviceId: string,
    intentKey: string,
    operation: (context: DeviceConnectionOperationContext) => Promise<T>,
    options: RunDeviceConnectionOptions = {},
  ): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new DeviceConnectionControllerShutdownError())
    const slot = this.slots.get(deviceId) ?? {
      tail: Promise.resolve(),
      inFlight: new Map<string, Promise<unknown>>(),
    }
    this.slots.set(deviceId, slot)

    const existing = slot.inFlight.get(intentKey)
    if (existing) return existing as Promise<T>

    const execute = async () => {
      const operationId = `device-connection-${randomUUID()}`
      const deadlineAt = new Date(Date.now() + this.operationDeadlineMs).toISOString()
      const state = this.database.beginDeviceConnectionOperation({
        deviceId, operationId, deadlineAt, observedState: options.observedState,
      })
      const operationIdentity = {
        deviceId,
        operationId,
        generation: state.connectionGeneration,
      }
      this.database.appendConnectionEvent({
        ...operationIdentity,
        eventType: 'operation_started',
        source: options.source ?? 'manual',
        result: 'started',
      })
      const controller = new AbortController()
      this.activeControllers.add(controller)
      const operationSignal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal
      let timer: ReturnType<typeof setTimeout> | undefined
      let removeAbortListener: () => void = () => undefined
      const context: DeviceConnectionOperationContext = {
        operationId,
        generation: state.connectionGeneration,
        deadlineAt,
        source: options.source ?? 'manual',
        signal: operationSignal,
        isCurrent: () => this.database.isCurrentDeviceConnectionOperation(operationIdentity),
        commit: (input) => this.database.commitDeviceConnectionOperation({
          ...operationIdentity,
          observedState: input.observedState,
          desiredState: input.desiredState,
          activeEndpointId: input.activeEndpointId,
          clearActiveEndpoint: input.clearActiveEndpoint,
          reasonCode: input.reasonCode,
        }),
        restore: (input) => this.database.restoreDeviceConnectionOperationAfterAbort({
          ...operationIdentity,
          observedState: input.observedState,
          desiredState: input.desiredState,
          activeEndpointId: input.activeEndpointId,
          clearActiveEndpoint: input.clearActiveEndpoint,
          reasonCode: input.reasonCode,
          actionRequired: input.actionRequired,
        }),
        recordHealthFailure: (input) => this.database.recordDeviceConnectionHealthFailure({
          ...operationIdentity,
          ...input,
        }),
        record: (input) => {
          this.database.appendConnectionEvent({
            ...operationIdentity,
            ...input,
            source: options.source ?? 'manual',
          })
        },
      }
      const finalizeAbort = (reasonCode: string) => options.restoreStateOnAbort
        ? this.database.restoreDeviceConnectionOperationAfterAbort({
            ...operationIdentity,
            ...options.restoreStateOnAbort,
          })
        : this.database.expireDeviceConnectionOperation({
            ...operationIdentity,
            reasonCode,
          })
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new DeviceConnectionDeadlineExceededError())
          const expired = finalizeAbort('NETWORK_RECOVERY_DEADLINE_EXCEEDED')
          if (expired) {
            this.database.appendConnectionEvent({
              ...operationIdentity,
              eventType: 'operation_deadline_exceeded',
              source: 'controller',
              result: 'failed',
              failureCode: 'NETWORK_RECOVERY_DEADLINE_EXCEEDED',
              durationMs: this.operationDeadlineMs,
            })
          }
          reject(new DeviceConnectionDeadlineExceededError())
        }, this.operationDeadlineMs)
      })
      const cancellation = new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          const reason = controller.signal.reason
          if (reason instanceof DeviceConnectionDeadlineExceededError) {
            reject(reason)
            return
          }
          const error = reason instanceof Error ? reason : new Error('联网连接已取消')
          const failureCode = reason instanceof DeviceConnectionControllerShutdownError
            ? 'SERVICE_SHUTDOWN'
            : 'NETWORK_CONNECTION_CANCELLED'
          const expired = finalizeAbort(failureCode)
          if (expired) {
            this.database.appendConnectionEvent({
              ...operationIdentity,
              eventType: 'operation_cancelled',
              source: 'controller',
              result: 'cancelled',
              failureCode,
            })
          }
          reject(error)
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort)
        if (controller.signal.aborted) onAbort()
      })
      try {
        if (options.signal?.aborted) {
          finalizeAbort('NETWORK_CONNECTION_CANCELLED')
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error('联网连接已取消')
        }
        return await Promise.race([operation(context), deadline, cancellation])
      } finally {
        if (timer) clearTimeout(timer)
        removeAbortListener()
        this.activeControllers.delete(controller)
      }
    }
    const result = slot.inFlight.size === 0
      ? execute()
      : slot.tail.catch(() => undefined).then(execute)
    slot.inFlight.set(intentKey, result)
    slot.tail = result.then(() => undefined, () => undefined)
    void result.finally(() => {
      if (slot.inFlight.get(intentKey) === result) slot.inFlight.delete(intentKey)
      if (slot.inFlight.size === 0) {
        void slot.tail.then(() => {
          if (slot.inFlight.size === 0 && this.slots.get(deviceId) === slot) {
            this.slots.delete(deviceId)
          }
        })
      }
    }).catch(() => undefined)
    return result
  }

  recordPassiveHealth(input: PassiveDeviceConnectionHealthInput): boolean {
    if (this.shuttingDown) return false
    const updated = this.database.recordPassiveDeviceConnectionHealth({
      deviceId: input.deviceId,
      endpointId: input.endpointId,
      generation: input.generation,
      kind: input.evidence.kind,
      failureCode: input.evidence.kind === 'transport_failed'
        ? input.evidence.failureCode
        : undefined,
    })
    if (updated) {
      if (input.evidence.kind === 'healthy') {
        this.database.recordDeviceEndpointHealthSuccess(input.endpointId)
      } else {
        this.database.recordDeviceEndpointHealthFailure(input.endpointId, {
          failureCode: input.evidence.failureCode,
        })
      }
    }
    if (updated && input.evidence.kind === 'transport_failed') {
      this.database.appendConnectionEvent({
        deviceId: input.deviceId,
        generation: input.generation,
        eventType: 'adb_command_transport_failed',
        source: 'adb_worker',
        transportType: input.transportType ?? 'tcp_legacy',
        endpointSummary: {
          ...input.endpointSummary,
          transportType: input.transportType ?? 'tcp_legacy',
        },
        result: 'failed',
        failureCode: input.evidence.failureCode,
      })
    }
    return updated
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      await Promise.all([...this.slots.values()].map((slot) => slot.tail))
      return
    }
    this.shuttingDown = true
    for (const controller of this.activeControllers) {
      controller.abort(new DeviceConnectionControllerShutdownError())
    }
    await Promise.all([...this.slots.values()].map((slot) => slot.tail))
  }
}
