import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PlatformDatabase } from './database.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Device Connection generation fencing', () => {
  it('新的连接周期成功后拒绝旧周期迟到失败覆盖 online 状态', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cloud-test-connection-control-'))
    roots.push(root)
    const database = new PlatformDatabase({
      databasePath: path.join(root, 'cloud-test.sqlite'),
      seedDevice: false,
      markInterruptedTasks: false,
    })
    database.upsertAdbDevice({
      id: 'device-1', serial: 'SERIAL-1', name: 'Device 1', manufacturer: 'Example',
      model: 'MODEL-1', osVersion: 'Android 15', apiLevel: 35, architecture: 'arm64-v8a',
    })

    const first = database.beginDeviceConnectionOperation({
      deviceId: 'device-1', operationId: 'operation-1', deadlineAt: '2099-01-01T00:00:00.000Z',
    })
    const second = database.beginDeviceConnectionOperation({
      deviceId: 'device-1', operationId: 'operation-2', deadlineAt: '2099-01-01T00:00:00.000Z',
    })

    expect(second.connectionGeneration).toBe(first.connectionGeneration + 1)
    expect(database.commitDeviceConnectionOperation({
      deviceId: 'device-1', operationId: second.operationId,
      generation: second.connectionGeneration, observedState: 'online',
    })).toBe(true)
    expect(database.commitDeviceConnectionOperation({
      deviceId: 'device-1', operationId: first.operationId,
      generation: first.connectionGeneration, observedState: 'offline', reasonCode: 'ADB_CONNECT_TIMEOUT',
    })).toBe(false)
    expect(database.getDeviceConnectionState('device-1')).toMatchObject({
      operationId: 'operation-2', connectionGeneration: second.connectionGeneration,
      observedNetworkState: 'online', reasonCode: undefined,
    })
    database.close()
  })

  it('仅当前 generation 能在一个事务中激活 Endpoint、更新档案和追加事件', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cloud-test-connection-activation-'))
    roots.push(root)
    const database = new PlatformDatabase({
      databasePath: path.join(root, 'cloud-test.sqlite'), seedDevice: false, markInterruptedTasks: false,
    })
    database.upsertAdbDevice({
      id: 'device-1', serial: 'SERIAL-1', name: 'Old Name', manufacturer: 'Example',
      model: 'MODEL-1', osVersion: 'Android 15', apiLevel: 35, architecture: 'arm64-v8a',
    })
    const stale = database.beginDeviceConnectionOperation({
      deviceId: 'device-1', operationId: 'stale-operation', deadlineAt: '2099-01-01T00:00:00.000Z',
    })
    const current = database.beginDeviceConnectionOperation({
      deviceId: 'device-1', operationId: 'current-operation', deadlineAt: '2099-01-01T00:00:00.000Z',
    })
    const activation = {
      deviceId: 'device-1',
      endpoint: {
        deviceId: 'device-1', kind: 'network' as const, adbSerial: '192.0.2.10:5555',
        host: '192.0.2.10', port: 5555, status: 'online' as const,
      },
      profile: { name: 'Verified Name', model: 'MODEL-2' },
      event: {
        eventType: 'endpoint_activated', source: 'manual', transportType: 'tcp_legacy' as const,
        endpointSummary: { host: '192.0.2.10', port: 5555, transportType: 'tcp_legacy' as const },
        result: 'succeeded',
      },
    }

    expect(database.activateVerifiedNetworkEndpoint({
      ...activation, operationId: stale.operationId!, generation: stale.connectionGeneration,
    })).toBeUndefined()
    expect(database.getDevice('device-1')).toMatchObject({ name: 'Old Name', model: 'MODEL-1' })
    expect(database.getDeviceEndpointByKind('device-1', 'network')).toBeUndefined()
    expect(database.listConnectionEvents('device-1')).toHaveLength(0)

    expect(database.activateVerifiedNetworkEndpoint({
      ...activation, operationId: current.operationId!, generation: current.connectionGeneration,
    })).toMatchObject({ adbSerial: '192.0.2.10:5555', status: 'online' })
    expect(database.getDevice('device-1')).toMatchObject({ name: 'Verified Name', model: 'MODEL-2' })
    expect(database.getDeviceConnectionState('device-1')).toMatchObject({
      desiredNetworkState: 'connected', observedNetworkState: 'online', activeEndpointId: expect.any(String),
    })
    expect(database.listConnectionEvents('device-1')).toEqual([
      expect.objectContaining({ eventType: 'endpoint_activated', operationId: 'current-operation' }),
    ])
    database.close()
  })

  it('服务重启会终结遗留的连接中状态并记录可解释事件', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cloud-test-connection-restart-'))
    roots.push(root)
    const databasePath = path.join(root, 'cloud-test.sqlite')
    const first = new PlatformDatabase({ databasePath, seedDevice: false, markInterruptedTasks: false })
    first.upsertAdbDevice({
      id: 'device-1', serial: 'SERIAL-1', name: 'Device 1', manufacturer: 'Example',
      model: 'MODEL-1', osVersion: 'Android 15', apiLevel: 35, architecture: 'arm64-v8a',
    })
    const operation = first.beginDeviceConnectionOperation({
      deviceId: 'device-1', operationId: 'interrupted-operation', deadlineAt: '2099-01-01T00:00:00.000Z',
      observedState: 'recovering',
    })
    first.close()

    const restarted = new PlatformDatabase({ databasePath, seedDevice: false, markInterruptedTasks: false })
    expect(restarted.getDeviceConnectionState('device-1')).toMatchObject({
      connectionGeneration: operation.connectionGeneration,
      observedNetworkState: 'offline',
      activeEndpointId: undefined,
      deadlineAt: undefined,
      reasonCode: 'SERVICE_RESTARTED',
    })
    expect(restarted.listConnectionEvents('device-1')).toEqual([
      expect.objectContaining({
        operationId: 'interrupted-operation', generation: operation.connectionGeneration,
        eventType: 'operation_interrupted', source: 'service_startup', result: 'cancelled',
        failureCode: 'SERVICE_RESTARTED',
      }),
    ])
    restarted.close()
  })

  it('仅当前联网 Endpoint 和 generation 接受 ADB 业务命令的被动健康证据', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cloud-test-passive-health-'))
    roots.push(root)
    const database = new PlatformDatabase({
      databasePath: path.join(root, 'cloud-test.sqlite'), seedDevice: false, markInterruptedTasks: false,
    })
    database.upsertAdbDevice({
      id: 'device-1', serial: 'SERIAL-1', name: 'Device 1', manufacturer: 'Example',
      model: 'MODEL-1', osVersion: 'Android 15', apiLevel: 35, architecture: 'arm64-v8a',
    })
    const operation = database.beginDeviceConnectionOperation({
      deviceId: 'device-1', operationId: 'operation-1', deadlineAt: '2099-01-01T00:00:00.000Z',
    })
    const endpoint = database.upsertDeviceEndpoint({
      deviceId: 'device-1', kind: 'network', adbSerial: '192.0.2.10:5555',
      host: '192.0.2.10', port: 5555, status: 'online',
    })
    expect(database.commitDeviceConnectionOperation({
      deviceId: 'device-1', operationId: operation.operationId!,
      generation: operation.connectionGeneration, observedState: 'online',
      desiredState: 'connected', activeEndpointId: endpoint.id,
    })).toBe(true)

    expect(database.recordPassiveDeviceConnectionHealth({
      deviceId: 'device-1', endpointId: 'stale-endpoint',
      generation: operation.connectionGeneration, kind: 'transport_failed',
      failureCode: 'ADB_DEVICE_OFFLINE',
    })).toBe(false)
    expect(database.recordPassiveDeviceConnectionHealth({
      deviceId: 'device-1', endpointId: endpoint.id,
      generation: operation.connectionGeneration - 1, kind: 'transport_failed',
      failureCode: 'ADB_DEVICE_OFFLINE',
    })).toBe(false)
    expect(database.getDeviceConnectionState('device-1')).toMatchObject({
      observedNetworkState: 'online', consecutiveFailures: 0,
    })

    expect(database.recordPassiveDeviceConnectionHealth({
      deviceId: 'device-1', endpointId: endpoint.id,
      generation: operation.connectionGeneration, kind: 'transport_failed',
      failureCode: 'ADB_DEVICE_OFFLINE',
    })).toBe(true)
    expect(database.getDeviceConnectionState('device-1')).toMatchObject({
      observedNetworkState: 'degraded', consecutiveFailures: 1,
      reasonCode: 'ADB_DEVICE_OFFLINE',
    })

    expect(database.recordPassiveDeviceConnectionHealth({
      deviceId: 'device-1', endpointId: endpoint.id,
      generation: operation.connectionGeneration, kind: 'healthy',
    })).toBe(true)
    expect(database.getDeviceConnectionState('device-1')).toMatchObject({
      observedNetworkState: 'online', consecutiveFailures: 0, retryCount: 0,
      reasonCode: undefined, actionRequired: undefined, nextRetryAt: undefined,
      lastHealthAt: expect.any(String),
    })
    database.close()
  })
})
