import { afterEach, describe, expect, it, vi } from 'vitest'

import { createServiceHealthMonitor, SERVICE_HEALTH_LABELS, type ServiceHealth } from './serviceHealth'

function response(status: number) {
  return new Response(null, { status })
}

function flushPromises() {
  return new Promise<void>((resolve) => queueMicrotask(resolve))
}

describe('service health presentation', () => {
  it('为七种状态提供固定界面文案', () => {
    expect(SERVICE_HEALTH_LABELS).toEqual({
      checking: '服务检查中',
      online: '服务正常',
      slow: '服务响应慢',
      degraded: '服务异常',
      retrying: '正在重试',
      offline: '服务未连接',
      mock: 'Mock 演示',
    })
  })
})

describe('service health monitor', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('HTTP 2xx 快速返回时显示服务正常', async () => {
    const states: ServiceHealth[] = []
    const monitor = createServiceHealthMonitor({
      url: '/api/health', onChange: (state) => states.push(state),
      fetchImpl: vi.fn(async () => response(200)),
    })

    monitor.start()
    await flushPromises()

    expect(states).toEqual(['online'])
    monitor.stop()
  })

  it.each([400, 404, 500, 503])('HTTP %s 显示服务异常并中断网络失败计数', async (status) => {
    const states: ServiceHealth[] = []
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(response(status))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const monitor = createServiceHealthMonitor({ url: '/api/health', onChange: (state) => states.push(state), fetchImpl })

    await monitor.check()
    await monitor.check()
    await monitor.check()

    expect(states).toEqual(['retrying', 'degraded', 'retrying'])
    monitor.stop()
  })

  it('请求超过 3 秒显示服务响应慢，且不累计网络失败次数', async () => {
    vi.useFakeTimers()
    const states: ServiceHealth[] = []
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const monitor = createServiceHealthMonitor({ url: '/api/health', onChange: (state) => states.push(state), fetchImpl })

    void monitor.check()
    await vi.advanceTimersByTimeAsync(3000)
    await monitor.check()

    expect(states).toEqual(['slow', 'retrying'])
    monitor.stop()
  })

  it('非网络异常显示服务异常，不累计网络失败次数', async () => {
    const states: ServiceHealth[] = []
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('unexpected parser failure'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const monitor = createServiceHealthMonitor({ url: '/api/health', onChange: (state) => states.push(state), fetchImpl })

    await monitor.check()
    await monitor.check()

    expect(states).toEqual(['degraded', 'retrying'])
    monitor.stop()
  })

  it('连续两次网络失败才显示服务未连接，成功后立即清零', async () => {
    const states: ServiceHealth[] = []
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(response(200))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const monitor = createServiceHealthMonitor({ url: '/api/health', onChange: (state) => states.push(state), fetchImpl })

    await monitor.check()
    await monitor.check()
    await monitor.check()
    await monitor.check()

    expect(states).toEqual(['retrying', 'offline', 'online', 'retrying'])
    monitor.stop()
  })

  it('开始新检查会取消遗留请求，旧请求结果不能覆盖新状态', async () => {
    const states: ServiceHealth[] = []
    let resolveFirst: ((value: Response) => void) | undefined
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve })
    const fetchImpl = vi.fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        expect(init?.signal?.aborted).toBe(false)
        return first
      })
      .mockResolvedValueOnce(response(503))
    const monitor = createServiceHealthMonitor({ url: '/api/health', onChange: (state) => states.push(state), fetchImpl })

    const oldCheck = monitor.check()
    await monitor.check()
    resolveFirst?.(response(200))
    await oldCheck

    expect(states).toEqual(['degraded'])
    monitor.stop()
  })

  it('停止监控导致的主动取消不更新状态', async () => {
    const states: ServiceHealth[] = []
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const monitor = createServiceHealthMonitor({ url: '/api/health', onChange: (state) => states.push(state), fetchImpl })

    const check = monitor.check()
    monitor.stop()
    await check

    expect(states).toEqual([])
  })
})
