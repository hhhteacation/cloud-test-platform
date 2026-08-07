import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('platform client mode selection', () => {
  beforeEach(() => vi.stubGlobal('localStorage', createMemoryStorage()))

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('未配置前端环境变量时默认连接真实 /api，而不是静默进入 Mock', async () => {
    vi.stubEnv('VITE_PLATFORM_MODE', '')
    vi.stubEnv('VITE_API_BASE_URL', '')

    const { platformClient, platformRuntime } = await import('./client')

    expect(platformClient.mode).toBe('real')
    expect(platformRuntime).toEqual({ mode: 'real', apiBaseUrl: '/api' })
  })

  it('允许显式覆盖真实 API 地址并移除末尾斜杠', async () => {
    vi.stubEnv('VITE_PLATFORM_MODE', 'real')
    vi.stubEnv('VITE_API_BASE_URL', 'http://127.0.0.1:3100/api/')

    const { platformRuntime } = await import('./client')

    expect(platformRuntime).toEqual({ mode: 'real', apiBaseUrl: 'http://127.0.0.1:3100/api' })
  })

  it('只有显式配置 VITE_PLATFORM_MODE=mock 时才启用 Mock', async () => {
    vi.stubEnv('VITE_PLATFORM_MODE', 'mock')
    vi.stubEnv('VITE_API_BASE_URL', '/api')

    const { platformClient, platformRuntime } = await import('./client')

    expect(platformClient.mode).toBe('mock')
    expect(platformRuntime).toEqual({ mode: 'mock' })
  })
})
