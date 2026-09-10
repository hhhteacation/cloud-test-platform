import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import {
  AdbTrackDevicesWatcher,
  parseTrackedNetworkTransport,
  type TrackDevicesChild,
} from './adb-track-devices-watcher.js'

function fakeChild(): TrackDevicesChild & { close(code?: number): void; killedSignals: NodeJS.Signals[] } {
  const events = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const killedSignals: NodeJS.Signals[] = []
  return {
    stdout,
    stderr,
    killedSignals,
    on: (event, listener) => { events.on(event, listener); return undefined as never },
    once: (event, listener) => { events.once(event, listener); return undefined as never },
    kill: (signal = 'SIGTERM') => { killedSignals.push(signal); queueMicrotask(() => events.emit('close', 0)); return true },
    close: (code = 0) => events.emit('close', code),
  }
}

function trackFrame(payload: string) {
  const body = Buffer.from(payload)
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0')), body])
}

describe('adb track-devices network parser', () => {
  it('accepts only online host:port transports and never treats USB as a network Endpoint', () => {
    expect(parseTrackedNetworkTransport(
      '192.0.2.10:5555 device product:demo model:Phone transport_id:2',
    )).toEqual({
      serviceInstance: '192.0.2.10:5555', transportType: 'tcp_legacy',
      host: '192.0.2.10', port: 5555,
    })
    expect(parseTrackedNetworkTransport('[2001:db8::10]:37123 device transport_id:3')).toEqual({
      serviceInstance: '[2001:db8::10]:37123', transportType: 'unknown',
      host: '2001:db8::10', port: 37123,
    })
    expect(parseTrackedNetworkTransport('USB-SERIAL device usb:1-2 transport_id:1')).toBeUndefined()
    expect(parseTrackedNetworkTransport('192.0.2.10:5555 offline transport_id:2')).toBeUndefined()
    expect(parseTrackedNetworkTransport('List of devices attached')).toBeUndefined()
  })
})

describe('AdbTrackDevicesWatcher lifecycle', () => {
  it('streams network observations without executing any device command and stops only its child', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const observations: unknown[] = []
    const failures: unknown[] = []
    const watcher = new AdbTrackDevicesWatcher('/fake/adb', {
      onObservation: (observation) => observations.push(observation),
      onFailure: (failure) => failures.push(failure),
    }, { spawn })

    watcher.start()
    child.stdout.write(trackFrame([
      'USB-SERIAL device usb:1-2 transport_id:1',
      '192.0.2.10:5555 device transport_id:2',
      '192.0.2.10:5555 device transport_id:2',
    ].join('\n')))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(spawn).toHaveBeenCalledWith('/fake/adb', ['track-devices', '-l'])
    expect(observations).toEqual([
      expect.objectContaining({ host: '192.0.2.10', port: 5555 }),
    ])
    expect(failures).toEqual([])

    await watcher.stop()
    expect(child.killedSignals).toEqual(['SIGTERM'])
  })

  it('renews the current snapshot before Observation TTL and stops renewing removed transports', async () => {
    const child = fakeChild()
    const observations: Array<{ host: string; port: number }> = []
    let heartbeat: (() => void) | undefined
    const clearHeartbeat = vi.fn()
    const watcher = new AdbTrackDevicesWatcher('/fake/adb', {
      onObservation: (observation) => observations.push(observation),
      onFailure: () => undefined,
    }, {
      spawn: () => child,
      scheduleHeartbeat: (callback, intervalMs) => {
        expect(intervalMs).toBeLessThan(30_000)
        heartbeat = callback
        return { unref: () => undefined } as never
      },
      clearHeartbeat,
    })

    watcher.start()
    const firstFrame = trackFrame('192.0.2.10:5555 device transport_id:2\n')
    child.stdout.write(firstFrame.subarray(0, 3))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(observations).toEqual([])
    child.stdout.write(firstFrame.subarray(3))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(observations).toHaveLength(1)

    heartbeat?.()
    expect(observations).toHaveLength(2)

    child.stdout.write(trackFrame('USB-SERIAL device usb:1-2 transport_id:1\n'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    heartbeat?.()
    expect(observations).toHaveLength(2)

    await watcher.stop()
    expect(clearHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('reports unexpected exit once and restarts with bounded backoff', async () => {
    const children = [fakeChild(), fakeChild()]
    const spawn = vi.fn(() => children.shift()!)
    const failures: Array<{ code: string }> = []
    let restart: (() => void) | undefined
    const watcher = new AdbTrackDevicesWatcher('/fake/adb', {
      onObservation: () => undefined,
      onFailure: (failure) => failures.push(failure),
    }, {
      spawn,
      scheduleRestart: (callback) => { restart = callback; return { unref: () => undefined } as never },
      clearRestart: () => undefined,
    })

    watcher.start()
    children[0]?.stderr.write('adb server unavailable')
    // The first child was removed from the array by spawn; close the active reference.
    const first = spawn.mock.results[0].value as ReturnType<typeof fakeChild>
    first.close(1)

    expect(failures).toEqual([
      expect.objectContaining({ code: 'ADB_TRACK_DEVICES_EXITED' }),
    ])
    expect(restart).toBeTypeOf('function')
    restart?.()
    expect(spawn).toHaveBeenCalledTimes(2)
    await watcher.stop()
  })

  it('does not restart or publish a failure when shutdown closes the child', async () => {
    const child = fakeChild()
    const failures: unknown[] = []
    const scheduleRestart = vi.fn()
    const watcher = new AdbTrackDevicesWatcher('/fake/adb', {
      onObservation: () => undefined,
      onFailure: (failure) => failures.push(failure),
    }, { spawn: () => child, scheduleRestart })

    watcher.start()
    await watcher.stop()

    expect(failures).toEqual([])
    expect(scheduleRestart).not.toHaveBeenCalled()
  })

  it('bounds shutdown even when the child never emits close and ignores late output', async () => {
    const child = fakeChild()
    child.kill = (signal = 'SIGTERM') => {
      child.killedSignals.push(signal)
      return true
    }
    const observations: unknown[] = []
    const watcher = new AdbTrackDevicesWatcher('/fake/adb', {
      onObservation: (observation) => observations.push(observation),
      onFailure: () => undefined,
    }, { spawn: () => child, killGraceMs: 1 })

    watcher.start()
    await expect(watcher.stop()).resolves.toBeUndefined()
    child.stdout.write(trackFrame('192.0.2.10:5555 device transport_id:2\n'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(child.killedSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(observations).toEqual([])
  })
})
