import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AdbDeviceClient, type AdbCommandHealthEvidence, type AdbObservation } from './adb-client.js'
import { ProcessError, type ProcessRunner } from '../process.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

async function createFakeAdb() {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloud-test-fake-adb-'))
  temporaryDirectories.push(directory)
  const executable = path.join(directory, 'adb')
  await writeFile(executable, `#!/bin/sh
if [ "$3" = "shell" ] && [ "$4" = "pm" ] && [ "$5" = "path" ]; then
  # vivo returns exit code 1 with no stdout/stderr when the package is absent.
  exit 1
fi
exit 0
`, 'utf8')
  await chmod(executable, 0o755)
  return executable
}

describe('AdbDeviceClient package detection', () => {
  it('does not confuse vivo\'s absent-package result with an ADB install failure', async () => {
    const adbPath = await createFakeAdb()
    const device = new AdbDeviceClient(adbPath, 'vivo-serial')

    await expect(device.isPackageInstalled(
      'com.morphoinc.videopostprocessor',
      new AbortController().signal,
    )).resolves.toBe(false)
  })
})


describe('AdbDeviceClient observations', () => {
  it('does not reinterpret an aborted connection observation as device offline', async () => {
    const controller = new AbortController()
    const runner: ProcessRunner = {
      async run() {
        controller.abort(new DOMException('Attempt deadline reached', 'AbortError'))
        throw controller.signal.reason
      },
    }
    const device = new AdbDeviceClient('/adb', 'serial-1', runner)

    await expect(device.connectionStatus(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Attempt deadline reached',
    })
  })

  it('distinguishes an absent path from an ADB observation failure', async () => {
    const results = [
      { code: 1, stdout: '', stderr: 'stat: /missing.mp4: No such file or directory' },
      { code: 2, stdout: '', stderr: 'stat: permission denied' },
    ]
    const runner: ProcessRunner = {
      async run() {
        return results.shift()!
      },
    }
    const device = new AdbDeviceClient('/adb', 'serial-1', runner)

    await expect(device.stat('/missing.mp4', new AbortController().signal)).resolves.toMatchObject({
      kind: 'absent',
    } satisfies Partial<AdbObservation<number>>)
    await expect(device.stat('/protected.mp4', new AbortController().signal)).resolves.toMatchObject({
      kind: 'failed',
      error: expect.objectContaining({ code: 'ADB_OBSERVATION_FAILED' }),
    } satisfies Partial<AdbObservation<number>>)
  })

  it('treats pidof exit code 1 as absent but preserves other failures', async () => {
    const results = [
      { code: 1, stdout: '', stderr: '' },
      { code: 2, stdout: '', stderr: 'permission denied' },
    ]
    const runner: ProcessRunner = {
      async run() {
        return results.shift()!
      },
    }
    const device = new AdbDeviceClient('/adb', 'serial-1', runner)

    await expect(device.isPackageRunning('com.example.app', new AbortController().signal)).resolves.toMatchObject({
      kind: 'absent',
    })
    await expect(device.isPackageRunning('com.example.app', new AbortController().signal)).resolves.toMatchObject({
      kind: 'failed',
      error: expect.objectContaining({ code: 'ADB_OBSERVATION_FAILED' }),
    })
  })

  it('does not swallow cancellation while observing device state', async () => {
    const controller = new AbortController()
    const runner: ProcessRunner = {
      async run(_command, _args, options) {
        options?.signal && controller.abort()
        throw new DOMException('任务已取消', 'AbortError')
      },
    }
    const device = new AdbDeviceClient('/adb', 'serial-1', runner)

    await expect(device.isPackageRunning('com.example.app', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})

describe('AdbDeviceClient passive connection health', () => {
  it('records a successful business command as passive health evidence', async () => {
    const evidence: AdbCommandHealthEvidence[] = []
    const runner: ProcessRunner = {
      async run() { return { code: 0, stdout: 'ok', stderr: '' } },
    }
    const device = new AdbDeviceClient('/adb', '192.0.2.10:5555', runner, {
      onHealthEvidence: (item) => evidence.push(item),
    })

    await device.run(['shell', 'echo', 'ok'], new AbortController().signal)

    expect(evidence).toEqual([{ kind: 'healthy' }])
  })

  it('does not confuse an application or permission failure with a transport failure', async () => {
    const evidence: AdbCommandHealthEvidence[] = []
    const runner: ProcessRunner = {
      async run(command, args) {
        throw new ProcessError('permission denied', command, args, {
          code: 1, stdout: '', stderr: 'java.lang.SecurityException: permission denied',
        })
      },
    }
    const device = new AdbDeviceClient('/adb', '192.0.2.10:5555', runner, {
      onHealthEvidence: (item) => evidence.push(item),
    })

    await expect(device.run(['shell', 'pm', 'grant'], new AbortController().signal)).rejects.toThrow()

    expect(evidence).toEqual([{ kind: 'healthy' }])
  })

  it('records only an explicit ADB transport failure as unhealthy evidence', async () => {
    const evidence: AdbCommandHealthEvidence[] = []
    const runner: ProcessRunner = {
      async run(command, args) {
        throw new ProcessError('device offline', command, args, {
          code: 1, stdout: '', stderr: 'error: device offline',
        })
      },
    }
    const device = new AdbDeviceClient('/adb', '192.0.2.10:5555', runner, {
      onHealthEvidence: (item) => evidence.push(item),
    })

    await expect(device.run(['push', 'input.mp4', '/sdcard/input.mp4'], new AbortController().signal)).rejects.toThrow()

    expect(evidence).toEqual([{ kind: 'transport_failed', failureCode: 'ADB_DEVICE_OFFLINE' }])
  })

  it('does not publish health evidence after cancellation', async () => {
    const evidence: AdbCommandHealthEvidence[] = []
    const controller = new AbortController()
    const runner: ProcessRunner = {
      async run() {
        controller.abort()
        throw new DOMException('cancelled', 'AbortError')
      },
    }
    const device = new AdbDeviceClient('/adb', '192.0.2.10:5555', runner, {
      onHealthEvidence: (item) => evidence.push(item),
    })

    await expect(device.run(['shell', 'echo', 'ok'], controller.signal)).rejects.toThrow()

    expect(evidence).toEqual([])
  })

  it('keeps a generic slow-command timeout neutral because it does not prove transport loss', async () => {
    const evidence: AdbCommandHealthEvidence[] = []
    const runner: ProcessRunner = {
      async run(command, args) {
        throw new ProcessError('命令执行超时：adb', command, args, {
          code: -1, stdout: '', stderr: '',
        })
      },
    }
    const device = new AdbDeviceClient('/adb', '192.0.2.10:5555', runner, {
      onHealthEvidence: (item) => evidence.push(item),
    })

    await expect(device.run(['shell', 'slow-command'], new AbortController().signal)).rejects.toThrow()

    expect(evidence).toEqual([])
  })

  it('does not let telemetry callback failures break the ADB business command', async () => {
    const runner: ProcessRunner = {
      async run() { return { code: 0, stdout: 'ok', stderr: '' } },
    }
    const device = new AdbDeviceClient('/adb', '192.0.2.10:5555', runner, {
      onHealthEvidence: () => { throw new Error('telemetry unavailable') },
    })

    await expect(device.run(
      ['shell', 'echo', 'ok'],
      new AbortController().signal,
    )).resolves.toMatchObject({ code: 0, stdout: 'ok' })
  })
})

describe('AdbDeviceClient logcat clearing', () => {
  it('clears all buffers on the explicitly selected device', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const runner: ProcessRunner = {
      async run(command, args) {
        calls.push({ command, args })
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const device = new AdbDeviceClient('/adb', 'serial-1', runner)

    await device.clearLogcat(new AbortController().signal)

    expect(calls).toEqual([{ command: '/adb', args: ['-s', 'serial-1', 'logcat', '-b', 'all', '-c'] }])
  })


  it('returns non-zero ProcessResult through the observation seam without converting it to a business failure', async () => {
    const runner: ProcessRunner = {
      async run(command, args) {
        throw new ProcessError('adb probe failed', command, args, {
          code: 1,
          stdout: 'partial observation',
          stderr: 'permission denied',
          stdoutBytes: 19,
          stderrBytes: 17,
        })
      },
    }
    const device = new AdbDeviceClient('/adb', 'serial-1', runner)

    await expect(device.observe(
      ['shell', 'dumpsys', 'power'],
      new AbortController().signal,
      10_000,
    )).resolves.toMatchObject({
      code: 1,
      stdout: 'partial observation',
      stderr: 'permission denied',
    })
  })

  it('maps a clear failure to LOGCAT_CLEAR_FAILED', async () => {
    const runner: ProcessRunner = {
      async run(command, args) {
        throw new ProcessError('adb failed', command, args, { code: 1, stdout: '', stderr: 'permission denied' })
      },
    }
    const device = new AdbDeviceClient('/adb', 'serial-1', runner)

    await expect(device.clearLogcat(new AbortController().signal)).rejects.toMatchObject({
      code: 'LOGCAT_CLEAR_FAILED',
      message: expect.stringContaining('permission denied'),
    })
  })
})
