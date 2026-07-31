import type { TestPlatformClient } from '../types'
import { HttpTestPlatformClient } from './httpClient'
import { MockTestPlatformClient } from './mockClient'

const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim()

/**
 * 配置 VITE_API_BASE_URL（本地通常为 /api）时使用真实后端；
 * 不配置时使用浏览器 localStorage Mock，便于只看前端页面。
 */
export const platformClient: TestPlatformClient = configuredApiBase
  ? new HttpTestPlatformClient(configuredApiBase.replace(/\/$/, ''))
  : new MockTestPlatformClient()

export const isRealPlatform = platformClient.mode === 'real'
