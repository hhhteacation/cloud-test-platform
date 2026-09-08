import type { AppConfig } from '../config.js'
import type { ProcessRunner } from '../process.js'
import { AdbDeviceClient, type AdbCommandHealthEvidence } from './adb-client.js'
import { AdbStreams } from './adb-streams.js'
import { TaskProcessRegistry } from './process-registry.js'
import type { ProtocolExecutionDevice, ProtocolExecutionStreams } from './protocol-executor.js'

export interface AdbExecutionDevice extends ProtocolExecutionDevice {
  connectionStatus(signal?: AbortSignal): Promise<'online' | 'offline' | 'unauthorized'>
  isPackageInstalled(packageName: string, signal: AbortSignal): Promise<boolean>
}

export interface AdbExecutionStreams extends ProtocolExecutionStreams {
  captureScreenshot(taskId: string, targetPath: string, signal: AbortSignal): Promise<void>
}

export interface AdbExecutionActualConnection {
  deviceId: string
  endpointId: string
  kind: 'usb' | 'network'
  adbSerial: string
  generation: number
}

export interface AdbExecutionConnectionHealthEvidence {
  deviceId: string
  endpointId: string
  generation: number
  evidence: AdbCommandHealthEvidence
}

export interface AdbExecutionGatewaySession {
  device: AdbExecutionDevice
  streams: AdbExecutionStreams
}

export interface AdbExecutionGateway {
  open(input: {
    connection: AdbExecutionActualConnection
    processes: TaskProcessRegistry
    attempt: { signal: AbortSignal; deadlineAt: string }
    healthGeneration?: number
  }): AdbExecutionGatewaySession
}

/**
 * Deep execution module: callers provide one Actual Connection snapshot and
 * receive device commands plus streams bound to the same ADB serial.
 */
export class DefaultAdbExecutionGateway implements AdbExecutionGateway {
  constructor(
    private readonly adbPath: string,
    private readonly runner: ProcessRunner,
    private readonly options: Pick<AppConfig, 'maxLogcatBytes' | 'processKillGraceMs'>,
    private readonly recordConnectionHealth?: (input: AdbExecutionConnectionHealthEvidence) => void,
  ) {}

  open(input: {
    connection: AdbExecutionActualConnection
    processes: TaskProcessRegistry
    attempt: { signal: AbortSignal; deadlineAt: string }
    healthGeneration?: number
  }): AdbExecutionGatewaySession {
    const { connection } = input
    const device = new AdbDeviceClient(this.adbPath, connection.adbSerial, this.runner, {
      onHealthEvidence: connection.kind === 'network'
        && input.healthGeneration !== undefined
        && this.recordConnectionHealth
        ? (evidence) => this.recordConnectionHealth!({
            deviceId: connection.deviceId,
            endpointId: connection.endpointId,
            generation: input.healthGeneration!,
            evidence,
          })
        : undefined,
    })
    const streams = new AdbStreams(
      this.adbPath,
      connection.adbSerial,
      input.processes,
      {
        maxLogBytes: this.options.maxLogcatBytes,
        killGraceMs: this.options.processKillGraceMs,
      },
    )
    return { device, streams }
  }
}
