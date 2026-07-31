import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AdbDeviceClient } from './adb-client.js'

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
