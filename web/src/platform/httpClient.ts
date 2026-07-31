import type {
  Artifact,
  ArtifactKind,
  CreateTaskInput,
  DeviceProfile,
  DeviceDiscoveryCandidate,
  TaskUpdateListener,
  TestPlatformClient,
  TestReport,
  TestTask,
  TaskDeletionReceipt,
} from '../types'

import { ensureTaskCapabilities } from '../features/tasks/taskCapabilities'
import { PlatformApiError } from './errors'

const TERMINAL_STATUSES = new Set(['passed', 'failed', 'cancelled'])

interface ApiErrorBody {
  code?: string
  message?: string
}


export class HttpTestPlatformClient implements TestPlatformClient {
  readonly mode = 'real' as const

  constructor(private readonly apiBaseUrl: string) {}

  listDevices() {
    return this.request<DeviceProfile[]>('/devices')
  }

  discoverDevices() {
    return this.request<DeviceDiscoveryCandidate[]>('/devices/discover', { method: 'POST' })
  }

  registerDevice(serial: string) {
    return this.request<DeviceProfile>('/devices/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial }),
    })
  }

  async uploadArtifact(file: File, kind: ArtifactKind) {
    const body = new FormData()
    body.append('file', file, file.name)

    return this.request<Artifact>(`/artifacts?kind=${kind}`, {
      method: 'POST',
      body,
    })
  }

  async createTask(input: CreateTaskInput) {
    const task = await this.request<TestTask>('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return ensureTaskCapabilities(task)
  }

  async listTasks() {
    const tasks = await this.request<TestTask[]>('/tasks')
    return tasks.map(ensureTaskCapabilities)
  }

  async getTask(taskId: string) {
    try {
      const task = await this.request<TestTask>(`/tasks/${taskId}`)
      return ensureTaskCapabilities(task)
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 404) return undefined
      throw error
    }
  }

  subscribeTask(taskId: string, listener: TaskUpdateListener) {
    let stopped = false
    let timer: number | undefined

    const poll = async () => {
      try {
        const task = await this.getTask(taskId)
        if (stopped || !task) return
        listener(task)
        if (TERMINAL_STATUSES.has(task.status)) return
      } catch (error) {
        console.error('轮询任务失败', error)
      }

      if (!stopped) timer = window.setTimeout(poll, 1000)
    }

    timer = window.setTimeout(poll, 1000)

    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }

  async getReport(taskId: string) {
    try {
      const report = await this.request<TestReport>(`/tasks/${taskId}/report`)
      return ensureTaskCapabilities(report)
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 404) return undefined
      throw error
    }
  }

  async cancelTask(taskId: string) {
    await this.request(`/tasks/${taskId}/cancel`, { method: 'POST' })
  }

  deleteTask(taskId: string) {
    return this.request<TaskDeletionReceipt>(`/tasks/${taskId}`, { method: 'DELETE' })
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, init)
    if (!response.ok) {
      let body: ApiErrorBody = {}
      try {
        body = (await response.json()) as ApiErrorBody
      } catch {
        // 非 JSON 错误仍由统一错误对象处理。
      }
      throw new PlatformApiError(
        body.message || `请求失败（HTTP ${response.status}）`,
        body.code,
        response.status,
      )
    }

    const data = (await response.json()) as T
    return this.normalizeUrls(data)
  }

  private normalizeUrls<T>(value: T): T {
    const baseOrigin = this.apiBaseUrl.startsWith('http')
      ? new URL(this.apiBaseUrl).origin
      : ''

    const visit = (candidate: unknown): unknown => {
      if (Array.isArray(candidate)) return candidate.map(visit)
      if (!candidate || typeof candidate !== 'object') return candidate

      return Object.fromEntries(
        Object.entries(candidate).map(([key, item]) => {
          if (
            (key === 'previewUrl' || key === 'downloadUrl' || key === 'logcatUrl' || key === 'screenshotUrl') &&
            typeof item === 'string' &&
            item.startsWith('/') &&
            baseOrigin
          ) {
            return [key, `${baseOrigin}${item}`]
          }
          return [key, visit(item)]
        }),
      )
    }

    return visit(value) as T
  }
}
