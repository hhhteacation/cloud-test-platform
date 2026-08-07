import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AdbDeviceClient } from './adb-client.js'
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
