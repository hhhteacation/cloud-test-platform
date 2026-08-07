import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import { isLoopbackAddress, isLoopbackAuthority, isLoopbackOrigin, registerLocalAccessGuard } from './local-access.js'

describe('本机访问边界', () => {
  it('只接受 loopback Host 与 Origin', () => {
    expect(isLoopbackAuthority('localhost:5173')).toBe(true)
    expect(isLoopbackAuthority('127.0.0.1:3000')).toBe(true)
    expect(isLoopbackAuthority('192.168.1.10:5173')).toBe(false)
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true)
    expect(isLoopbackOrigin('http://192.168.1.10:5173')).toBe(false)
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.20')).toBe(false)
  })

  it('拒绝局域网 Host', async () => {
    const app = Fastify()
    registerLocalAccessGuard(app)
    app.get('/health', async () => ({ ok: true }))
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host: '192.168.1.10:3000' } })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'LOCAL_ACCESS_ONLY' })
    await app.close()
  })
  it('拒绝由非本机来源经代理转发的请求', async () => {
    const app = Fastify()
    registerLocalAccessGuard(app)
    app.get('/health', async () => ({ ok: true }))
    const response = await app.inject({
      method: 'GET', url: '/health',
      headers: { host: 'localhost:3000', 'x-forwarded-for': '192.168.1.20' },
    })
    expect(response.statusCode).toBe(403)
    await app.close()
  })

})
