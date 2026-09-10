import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'

export interface TrackedNetworkTransport {
  serviceInstance: string
  /** track-devices exposes host:port, but not the ADB service type. */
  transportType: 'tcp_legacy' | 'wireless_tls' | 'unknown'
  host: string
  port: number
}

export interface TrackDevicesFailure {
  code: 'ADB_TRACK_DEVICES_FAILED' | 'ADB_TRACK_DEVICES_EXITED'
  message: string
}

export interface TrackDevicesChild {
  stdout: Pick<Readable, 'on'>
  stderr: Pick<Readable, 'on'>
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

type TrackDevicesSpawn = (command: string, args: string[]) => TrackDevicesChild

interface AdbTrackDevicesWatcherHandlers {
  onObservation(observation: TrackedNetworkTransport): void
  onFailure(failure: TrackDevicesFailure): void
}

interface AdbTrackDevicesWatcherOptions {
  spawn?: TrackDevicesSpawn
  scheduleRestart?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearRestart?: (timer: ReturnType<typeof setTimeout>) => void
  scheduleHeartbeat?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>
  clearHeartbeat?: (timer: ReturnType<typeof setInterval>) => void
  heartbeatMs?: number
  killGraceMs?: number
}

export function parseTrackedNetworkTransport(line: string): TrackedNetworkTransport | undefined {
  const [serial = '', state = ''] = line.trim().split(/\s+/)
  if (state !== 'device') return undefined
  const ipv6 = serial.match(/^\[([^\]]+)\]:(\d{1,5})$/)
  const hostPort = ipv6 ?? serial.match(/^(.+):(\d{1,5})$/)
  if (!hostPort) return undefined
  const host = hostPort[1]
  const port = Number(hostPort[2])
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return {
    serviceInstance: serial,
    transportType: port === 5555 ? 'tcp_legacy' : 'unknown',
    host,
    port,
  }
}

function defaultSpawn(command: string, args: string[]): TrackDevicesChild {
  return spawn(command, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Passive, read-only ADB transport event source. It never runs a device command. */
export class AdbTrackDevicesWatcher {
  private readonly spawn: TrackDevicesSpawn
  private readonly scheduleRestart: NonNullable<AdbTrackDevicesWatcherOptions['scheduleRestart']>
  private readonly clearRestart: NonNullable<AdbTrackDevicesWatcherOptions['clearRestart']>
  private readonly scheduleHeartbeat: NonNullable<AdbTrackDevicesWatcherOptions['scheduleHeartbeat']>
  private readonly clearHeartbeat: NonNullable<AdbTrackDevicesWatcherOptions['clearHeartbeat']>
  private readonly heartbeatMs: number
  private readonly killGraceMs: number
  private child?: TrackDevicesChild
  private restartTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private killTimer?: ReturnType<typeof setTimeout>
  private stopping = true
  private stdoutBuffer = Buffer.alloc(0)
  private pendingSnapshot = new Map<string, TrackedNetworkTransport>()
  private currentSnapshot = new Map<string, TrackedNetworkTransport>()
  private restartAttempt = 0
  private closeWaiters: Array<() => void> = []

  constructor(
    private readonly adbPath: string,
    private readonly handlers: AdbTrackDevicesWatcherHandlers,
    options: AdbTrackDevicesWatcherOptions = {},
  ) {
    this.spawn = options.spawn ?? defaultSpawn
    this.scheduleRestart = options.scheduleRestart ?? setTimeout
    this.clearRestart = options.clearRestart ?? clearTimeout
    this.scheduleHeartbeat = options.scheduleHeartbeat ?? setInterval
    this.clearHeartbeat = options.clearHeartbeat ?? clearInterval
    this.heartbeatMs = options.heartbeatMs ?? 15_000
    this.killGraceMs = options.killGraceMs ?? 3_000
  }

  start() {
    if (!this.stopping || this.child || this.restartTimer) return
    this.stopping = false
    this.launch()
  }

  isStarted() {
    return !this.stopping
  }

  async stop(): Promise<void> {
    if (this.stopping && !this.child) return
    this.stopping = true
    if (this.restartTimer) {
      this.clearRestart(this.restartTimer)
      this.restartTimer = undefined
    }
    this.stopHeartbeat()
    const child = this.child
    if (!child) return
    const closed = new Promise<void>((resolve) => this.closeWaiters.push(resolve))
    if (!child.kill('SIGTERM')) {
      if (this.child === child) this.child = undefined
      for (const resolve of this.closeWaiters.splice(0)) resolve()
      return
    }
    this.killTimer = setTimeout(() => {
      child.kill('SIGKILL')
      if (this.child === child) this.child = undefined
      this.killTimer = undefined
      for (const resolve of this.closeWaiters.splice(0)) resolve()
    }, this.killGraceMs)
    this.killTimer.unref()
    await closed
  }

  private launch() {
    if (this.stopping) return
    let child: TrackDevicesChild
    try {
      child = this.spawn(this.adbPath, ['track-devices', '-l'])
    } catch (error) {
      this.publishFailure({
        code: 'ADB_TRACK_DEVICES_FAILED',
        message: error instanceof Error ? error.message : String(error),
      })
      this.scheduleNextRestart()
      return
    }
    this.child = child
    this.stdoutBuffer = Buffer.alloc(0)
    this.pendingSnapshot.clear()
    this.currentSnapshot.clear()
    this.heartbeatTimer = this.scheduleHeartbeat(() => {
      if (this.stopping || this.child !== child) return
      for (const observation of this.currentSnapshot.values()) {
        this.publishObservation(observation)
      }
    }, this.heartbeatMs)
    this.heartbeatTimer.unref()
    let failureReported = false
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (this.stopping || this.child !== child) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes])
      this.processFrames()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (this.stopping || this.child !== child) return
      stderr = `${stderr}${chunk.toString()}`.slice(-16_384)
    })
    child.once('error', (error) => {
      if (this.stopping || this.child !== child) return
      failureReported = true
      this.publishFailure({ code: 'ADB_TRACK_DEVICES_FAILED', message: error.message })
    })
    child.once('close', (code) => {
      if (this.child !== child) return
      this.stdoutBuffer = Buffer.alloc(0)
      this.stopHeartbeat()
      if (this.killTimer) clearTimeout(this.killTimer)
      this.killTimer = undefined
      if (this.child === child) this.child = undefined
      for (const resolve of this.closeWaiters.splice(0)) resolve()
      if (this.stopping) return
      if (!failureReported) {
        this.publishFailure({
          code: 'ADB_TRACK_DEVICES_EXITED',
          message: `adb track-devices 意外退出：code=${code ?? 'unknown'}${stderr.trim() ? `；${stderr.trim()}` : ''}`,
        })
      }
      this.scheduleNextRestart()
    })
  }

  private processFrames() {
    while (this.stdoutBuffer.length >= 4) {
      const lengthPrefix = this.stdoutBuffer.subarray(0, 4).toString('ascii')
      if (!/^[0-9a-fA-F]{4}$/.test(lengthPrefix)) {
        // Older platform-tools may expose line-oriented output. Keep that
        // compatibility path isolated from the framed protocol.
        const newline = this.stdoutBuffer.indexOf(0x0a)
        if (newline < 0) {
          if (this.stdoutBuffer.length > 65_536) this.stdoutBuffer = Buffer.alloc(0)
          return
        }
        const line = this.stdoutBuffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')
        this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
        if (!line.trim()) this.commitSnapshot()
        else this.collectLine(line)
        continue
      }
      const payloadLength = Number.parseInt(lengthPrefix, 16)
      if (this.stdoutBuffer.length < payloadLength + 4) return
      const payload = this.stdoutBuffer.subarray(4, payloadLength + 4).toString('utf8')
      this.stdoutBuffer = this.stdoutBuffer.subarray(payloadLength + 4)
      this.commitPayload(payload)
    }
  }

  private commitPayload(payload: string) {
    this.pendingSnapshot = new Map()
    for (const line of payload.split(/\r?\n/)) this.collectLine(line)
    this.commitSnapshot()
  }

  private collectLine(line: string) {
    const observation = parseTrackedNetworkTransport(line)
    if (!observation) return
    const key = `${observation.serviceInstance}\u0000${observation.host}\u0000${observation.port}`
    this.pendingSnapshot.set(key, observation)
  }

  private commitSnapshot() {
    this.currentSnapshot = this.pendingSnapshot
    this.pendingSnapshot = new Map()
    for (const observation of this.currentSnapshot.values()) {
      this.publishObservation(observation)
    }
  }

  private publishObservation(observation: TrackedNetworkTransport) {
    this.restartAttempt = 0
    try { this.handlers.onObservation(observation) } catch { /* passive telemetry cannot crash the watcher */ }
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) return
    this.clearHeartbeat(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    this.pendingSnapshot.clear()
    this.currentSnapshot.clear()
  }

  private publishFailure(failure: TrackDevicesFailure) {
    try { this.handlers.onFailure(failure) } catch { /* logging failures cannot crash discovery */ }
  }

  private scheduleNextRestart() {
    if (this.stopping || this.restartTimer) return
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000]
    const delayMs = delays[Math.min(this.restartAttempt, delays.length - 1)]
    this.restartAttempt += 1
    this.restartTimer = this.scheduleRestart(() => {
      this.restartTimer = undefined
      this.launch()
    }, delayMs)
    this.restartTimer.unref()
  }
}
