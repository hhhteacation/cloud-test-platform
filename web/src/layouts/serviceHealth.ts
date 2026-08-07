export type ServiceHealth =
  | 'checking'
  | 'online'
  | 'slow'
  | 'degraded'
  | 'retrying'
  | 'offline'
  | 'mock'

export const SERVICE_HEALTH_LABELS: Record<ServiceHealth, string> = {
  checking: '服务检查中',
  online: '服务正常',
  slow: '服务响应慢',
  degraded: '服务异常',
  retrying: '正在重试',
  offline: '服务未连接',
  mock: 'Mock 演示',
}

interface ServiceHealthMonitorOptions {
  url: string
  onChange: (health: ServiceHealth) => void
  fetchImpl?: typeof fetch
  timeoutMs?: number
  intervalMs?: number
}

type AbortReason = 'timeout' | 'superseded' | 'stopped'

interface ActiveCheck {
  id: number
  controller: AbortController
  abortReason?: AbortReason
  timeout?: ReturnType<typeof setTimeout>
}

function abortError() {
  return new DOMException('Aborted', 'AbortError')
}

export function createServiceHealthMonitor({
  url,
  onChange,
  fetchImpl = fetch,
  timeoutMs = 3000,
  intervalMs = 5000,
}: ServiceHealthMonitorOptions) {
  let disposed = false
  let sequence = 0
  let networkFailures = 0
  let active: ActiveCheck | undefined
  let interval: ReturnType<typeof setInterval> | undefined

  const isCurrent = (request: ActiveCheck) => !disposed && active?.id === request.id

  const abort = (request: ActiveCheck, reason: AbortReason) => {
    request.abortReason = reason
    request.controller.abort()
  }

  const check = async () => {
    if (disposed) return
    if (active) abort(active, 'superseded')

    const request: ActiveCheck = { id: ++sequence, controller: new AbortController() }
    active = request

    const aborted = new Promise<never>((_resolve, reject) => {
      request.controller.signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })
    const timedOut = new Promise<never>((_resolve, reject) => {
      request.timeout = setTimeout(() => {
        request.abortReason = 'timeout'
        request.controller.abort()
        reject(abortError())
      }, timeoutMs)
    })

    try {
      const response = await Promise.race([
        fetchImpl(url, { signal: request.controller.signal }),
        aborted,
        timedOut,
      ])
      if (!isCurrent(request)) return
      networkFailures = 0
      onChange(response.ok ? 'online' : 'degraded')
    } catch (error) {
      if (!isCurrent(request)) return
      if (request.abortReason === 'timeout') {
        networkFailures = 0
        onChange('slow')
        return
      }
      if (request.abortReason === 'superseded' || request.abortReason === 'stopped') return
      if (!(error instanceof TypeError)) {
        networkFailures = 0
        onChange('degraded')
        return
      }
      networkFailures += 1
      onChange(networkFailures >= 2 ? 'offline' : 'retrying')
    } finally {
      if (request.timeout !== undefined) clearTimeout(request.timeout)
      if (active?.id === request.id) active = undefined
    }
  }

  const start = () => {
    if (disposed || interval !== undefined) return
    void check()
    interval = setInterval(() => void check(), intervalMs)
  }

  const stop = () => {
    if (disposed) return
    disposed = true
    if (interval !== undefined) clearInterval(interval)
    if (active) abort(active, 'stopped')
  }

  return { start, stop, check }
}
