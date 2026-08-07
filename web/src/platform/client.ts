import type { TestPlatformClient } from '../types'
import { HttpTestPlatformClient } from './httpClient'
import { MockTestPlatformClient } from './mockClient'

export type PlatformRuntime =
  | { mode: 'real'; apiBaseUrl: string }
  | { mode: 'mock' }

function normalizedApiBase(value: string | undefined) {
  const configured = value?.trim() || '/api'
  const withoutTrailingSlash = configured.replace(/\/+$/, '')
  return withoutTrailingSlash || '/api'
}

/**
 * Phase 0 默认必须连接真实后端，避免遗漏环境变量时静默进入 Mock、让用户误以为真机平台可用。
 * Mock 只保留给前端演示和专项测试，并且必须显式设置 VITE_PLATFORM_MODE=mock。
 */
export function resolvePlatformRuntime(env: Record<string, string | boolean | undefined>): PlatformRuntime {
  const requestedMode = String(env.VITE_PLATFORM_MODE ?? '').trim().toLowerCase()
  if (requestedMode === 'mock') return { mode: 'mock' }
  return { mode: 'real', apiBaseUrl: normalizedApiBase(String(env.VITE_API_BASE_URL ?? '')) }
}

export const platformRuntime = resolvePlatformRuntime(import.meta.env)

export const platformClient: TestPlatformClient = platformRuntime.mode === 'mock'
  ? new MockTestPlatformClient()
  : new HttpTestPlatformClient(platformRuntime.apiBaseUrl)

export const isRealPlatform = platformClient.mode === 'real'
