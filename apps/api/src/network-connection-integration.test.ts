import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { config } from './config.js'
import { PlatformDatabase } from './database.js'
import { buildServer } from './server.js'

/**
 * Cross-seam test: HTTP route -> Registry -> ADB provider -> ProcessRunner -> SQLite stores.
 * The shell script is a deterministic fake adb executable, not a replacement for the real-device Gate.
 */
describe('network connection cross-seam', () => {
  let rootDir: string
  let adbPath: string
  let databasePath: string
  let endpointOneId: string

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'sdk-network-cross-seam-'))
    adbPath = path.join(rootDir, 'fake-adb.sh')
    databasePath = path.join(rootDir, 'cloud-test.sqlite')
    await writeFile(adbPath, `#!/bin/sh
set -eu
case "\${1:-}" in
  connect)
    serial="$2"
    case "$serial" in
      192.0.2.2:5555)
        printf '%s\\n' 'failed to connect to 192.0.2.2:5555: Connection refused' >&2
        exit 1
        ;;
      *)
        printf 'connected to %s\\n' "$serial"
        exit 0
        ;;
    esac
    ;;
  devices)
    printf '%s\\n' 'List of devices attached' '192.0.2.1:5555 device product:example model:EX_1 device:example'
    ;;
  -s)
    serial="$2"
    if [ "$serial" = '192.0.2.1:5555' ]; then
      cat <<'PROPS'
[ro.serialno]: [SERIAL-1]
[ro.product.manufacturer]: [Example]
[ro.product.model]: [EX-1]
[ro.build.version.release]: [15]
[ro.build.version.sdk]: [35]
[ro.product.cpu.abi]: [arm64-v8a]
[ro.build.display.id]: [EXAMPLE.1]
PROPS
    else
      printf '%s\\n' 'unknown serial' >&2
      exit 1
    fi
    ;;
  *)
    printf '%s\\n' 'unsupported fake adb command' >&2
    exit 1
    ;;
esac
`)
    await chmod(adbPath, 0o755)

    const database = new PlatformDatabase({ databasePath, seedDevice: false, markInterruptedTasks: false })
    database.upsertAdbDevice({
      id: 'device-1', serial: 'SERIAL-1', name: '测试机 1', manufacturer: 'Example', model: 'EX-1',
      osVersion: 'Android 15', apiLevel: 35, architecture: 'arm64-v8a',
    })
    database.upsertAdbDevice({
      id: 'device-2', serial: 'SERIAL-2', name: '测试机 2', manufacturer: 'Example', model: 'EX-1',
      osVersion: 'Android 15', apiLevel: 35, architecture: 'arm64-v8a',
    })
    endpointOneId = database.upsertDeviceEndpoint({
      deviceId: 'device-1', kind: 'network', adbSerial: '192.0.2.1:5555', host: '192.0.2.1', port: 5555, status: 'offline',
    }).id
    database.upsertDeviceEndpoint({
      deviceId: 'device-2', kind: 'network', adbSerial: '192.0.2.2:5555', host: '192.0.2.2', port: 5555, status: 'offline',
    })
    database.close()
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('部分成功时 HTTP、SQLite、旧单台接口和 ADB Evidence 保持一致', async () => {
    const testConfig = {
      ...config,
      dataDir: rootDir,
      databasePath,
      artifactsDir: path.join(rootDir, 'artifacts'),
      tasksDir: path.join(rootDir, 'tasks'),
      quarantineDir: path.join(rootDir, '.quarantine'),
      trashDir: path.join(rootDir, '.trash'),
      adbPath,
    }
    const app = await buildServer({ config: testConfig, skipPreflight: true })

    const single = await app.inject({
      method: 'POST',
      url: `/api/devices/device-1/endpoints/network/${endpointOneId}/connect`,
    })
    expect(single.statusCode).toBe(200)
    expect(single.json()).toMatchObject({ deviceId: 'device-1', status: 'online', host: '192.0.2.1', port: 5555 })

    const created = await app.inject({ method: 'POST', url: '/api/devices/network/connect-all', payload: {} })
    expect(created.statusCode).toBe(202)
    const operationId = created.json().operationId as string

    let operation: any
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: `/api/devices/network/connect-operations/${operationId}` })
      operation = response.json()
      if (!['queued', 'running'].includes(operation.status)) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(operation).toMatchObject({ status: 'completed', totalCount: 2, succeeded: 1, failed: 1, skipped: 0, cancelled: 0 })
    expect(operation.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: 'device-1', status: 'succeeded' }),
      expect.objectContaining({
        deviceId: 'device-2', status: 'failed', failureCode: 'ADB_PORT_REFUSED',
        adbExitCode: 1, adbStderr: expect.stringContaining('Connection refused'),
      }),
    ]))

    const database = new PlatformDatabase({ databasePath, seedDevice: false, markInterruptedTasks: false })
    const stored = database.getNetworkConnectionOperation(operationId)
    expect(stored).toEqual(operation)
    expect(database.getDeviceEndpointByKind('device-1', 'network')).toMatchObject({ status: 'online' })
    expect(database.getDeviceEndpointByKind('device-2', 'network')).toMatchObject({ status: 'offline', lastError: expect.stringContaining('Connection refused') })
    database.close()
    await app.close()
  })
})
