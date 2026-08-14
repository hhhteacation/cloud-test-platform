/* @vitest-environment jsdom */
import { act, StrictMode } from 'react'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
})
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeviceConnectionStatus, DeviceProfile, NetworkConnectionOperation, TestPlatformClient } from '../types'

const { client, listDevices, getOperation, startOperation } = vi.hoisted(() => {
  const listDevices = vi.fn()
  const getOperation = vi.fn()
  const startOperation = vi.fn()
  const client = {
    mode: 'real' as const,
    listDevices,
    getNetworkConnectionOperation: getOperation,
    startNetworkConnectionOperation: startOperation,
  }
  return { client, listDevices, getOperation, startOperation }
})

vi.mock('../platform/client', () => ({
  platformClient: client as unknown as TestPlatformClient,
  isRealPlatform: true,
}))

import { DevicesPage } from './DevicesPage'

function device(status: DeviceConnectionStatus): DeviceProfile {
  return {
    id: 'device-1',
    platform: 'android',
    name: 'Test Phone',
    manufacturer: 'Test',
    model: 'T-1',
    osVersion: 'Android 16',
    apiLevel: 36,
    architecture: 'arm64-v8a',
    executionMode: 'adb',
    eligible: true,
    endpoints: {
      network: {
        id: 'endpoint-1',
        deviceId: 'device-1',
        kind: 'network',
        adbSerial: '192.0.2.10:5555',
        host: '192.0.2.10',
        port: 5555,
        status,
      },
    },
    connectionStatus: status,
    overallConnectionStatus: status,
    selectable: status === 'online',
    queueStatus: 'idle',
  }
}

function operation(status: NetworkConnectionOperation['status'], itemStatus: NetworkConnectionOperation['items'][number]['status']): NetworkConnectionOperation {
  return {
    id: 'network-connect-test',
    status,
    totalCount: 1,
    succeeded: itemStatus === 'succeeded' ? 1 : 0,
    failed: itemStatus === 'failed' ? 1 : 0,
    skipped: itemStatus === 'skipped' ? 1 : 0,
    cancelled: itemStatus === 'cancelled' ? 1 : 0,
    cancelRequested: false,
    createdAt: '2026-08-14T00:00:00.000Z',
    items: [{
      id: 'item-1',
      operationId: 'network-connect-test',
      deviceId: 'device-1',
      endpointId: 'endpoint-1',
      host: '192.0.2.10',
      port: 5555,
      status: itemStatus,
    }],
  }
}

describe('DevicesPage 一键联网连接', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    listDevices
      .mockReset()
      .mockResolvedValueOnce([device('offline')])
      .mockResolvedValueOnce([device('offline')])
      .mockResolvedValue([device('online')])
    startOperation.mockReset().mockResolvedValue({ operationId: 'network-connect-test', status: 'queued', totalCount: 1 })
    getOperation.mockReset().mockResolvedValue(operation('completed', 'succeeded'))
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
  })

  it('StrictMode 下批量完成后应自动刷新设备快照，不需要再点击单台设备', async () => {
    await act(async () => root.render(<StrictMode><DevicesPage /></StrictMode>))
    expect(container.textContent).toContain('离线')
    const initialListCalls = listDevices.mock.calls.length

    const networkTab = Array.from(container.querySelectorAll('[role=tab]')).find((item) => item.textContent?.includes('联网连接'))
    expect(networkTab).toBeDefined()
    await act(async () => networkTab?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('一键连接全部'))
    expect(button).toBeDefined()
    await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => Promise.resolve())

    expect(getOperation).toHaveBeenCalledWith('network-connect-test')
    expect(listDevices).toHaveBeenCalledTimes(initialListCalls + 1)
    expect(container.textContent).toContain('在线')
  })

  it('批量状态查询临时失败后应继续轮询并刷新设备快照', async () => {
    getOperation
      .mockReset()
      .mockRejectedValueOnce(new Error('temporary proxy failure'))
      .mockResolvedValue(operation('completed', 'succeeded'))

    await act(async () => root.render(<StrictMode><DevicesPage /></StrictMode>))
    const initialListCalls = listDevices.mock.calls.length

    const networkTab = Array.from(container.querySelectorAll('[role=tab]')).find((item) => item.textContent?.includes('联网连接'))
    await act(async () => networkTab?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('一键连接全部'))
    await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => Promise.resolve())

    expect(getOperation).toHaveBeenCalledTimes(1)
    expect(listDevices).toHaveBeenCalledTimes(initialListCalls)

    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(getOperation).toHaveBeenCalledTimes(2)
    expect(listDevices).toHaveBeenCalledTimes(initialListCalls + 1)
    expect(container.textContent).toContain('在线')
  })
})
