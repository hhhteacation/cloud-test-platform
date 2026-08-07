/* @vitest-environment jsdom */
import { act } from 'react'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { listDevices } = vi.hoisted(() => ({
  listDevices: vi.fn(async () => []),
}))

vi.mock('./client', () => ({
  platformClient: { listDevices },
}))

import { createDeviceRefreshCoordinator, usePlatformDevices } from './usePlatformData'

function Probe({ pollActive = false }: { pollActive?: boolean }) {
  usePlatformDevices(pollActive)
  return null
}


describe('device refresh coordinator', () => {
  it('合并重复点击并直接应用接口返回的最新快照', async () => {
    let resolveRefresh: ((devices: never[]) => void) | undefined
    const refreshDevices = vi.fn(() => new Promise<never[]>((resolve) => { resolveRefresh = resolve }))
    const replaceDevices = vi.fn()
    const refresh = createDeviceRefreshCoordinator({ refreshDevices }, replaceDevices)

    const first = refresh()
    const second = refresh()
    expect(refreshDevices).toHaveBeenCalledTimes(1)

    resolveRefresh?.([])
    await Promise.all([first, second])
    expect(replaceDevices).toHaveBeenCalledWith([])
  })

  it('刷新失败时不替换原快照，并允许下次重新刷新', async () => {
    const refreshDevices = vi.fn()
      .mockRejectedValueOnce(new Error('adb unavailable'))
      .mockResolvedValueOnce([])
    const replaceDevices = vi.fn()
    const refresh = createDeviceRefreshCoordinator({ refreshDevices }, replaceDevices)

    await expect(refresh()).rejects.toThrow('adb unavailable')
    expect(replaceDevices).not.toHaveBeenCalled()
    await expect(refresh()).resolves.toEqual([])
    expect(refreshDevices).toHaveBeenCalledTimes(2)
    expect(replaceDevices).toHaveBeenCalledWith([])
  })
})

describe('usePlatformDevices', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    listDevices.mockClear()
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
  })

  it('默认只读取一次设备快照，不建立 5 秒轮询', async () => {
    await act(async () => root.render(<Probe />))
    expect(listDevices).toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(listDevices).toHaveBeenCalledTimes(1)
  })
})
