import type { FastifyInstance } from 'fastify'

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function hostnameFromAuthority(value: string) {
  try {
    return new URL(`http://${value}`).hostname
  } catch {
    return ''
  }
}

export function isLoopbackAddress(value: string | undefined) {
  if (!value) return false
  const normalized = value.trim().replace(/^\[|\]$/g, '')
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')
}

export function isLoopbackAuthority(value: string | undefined) {
  if (!value) return false
  return LOOPBACK_NAMES.has(hostnameFromAuthority(value.trim()))
}

export function isLoopbackOrigin(value: string | undefined) {
  if (!value) return true
  try {
    return LOOPBACK_NAMES.has(new URL(value).hostname)
  } catch {
    return false
  }
}

function forwardedAddresses(value: string | string[] | undefined) {
  if (!value) return []
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Phase 0 的补偿性安全边界：直接请求和代理转发来源都必须是本机。 */
export function registerLocalAccessGuard(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    const forwardedFor = forwardedAddresses(request.headers['x-forwarded-for'])
    const forwardedHost = request.headers['x-forwarded-host']
    const forwardedOrigin = request.headers['x-forwarded-origin']
    const local = isLoopbackAddress(request.ip)
      && isLoopbackAuthority(request.headers.host)
      && isLoopbackOrigin(request.headers.origin)
      && forwardedFor.every(isLoopbackAddress)
      && (!forwardedHost || isLoopbackAuthority(Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost))
      && (!forwardedOrigin || isLoopbackOrigin(Array.isArray(forwardedOrigin) ? forwardedOrigin[0] : forwardedOrigin))

    if (!local) {
      return reply.code(403).send({
        code: 'LOCAL_ACCESS_ONLY',
        message: 'Phase 0 仅允许从本机 localhost 或 127.0.0.1 访问',
      })
    }
  })
}
