import { describe, expect, it } from 'vitest'

import type { DeviceRunJob, PlatformDatabase } from './database.js'
import { DeviceQueueManager, QueueNotAcceptingError, type DeviceRunWorker } from './queue.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待队列状态超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

class QueueDatabaseFake {
  jobs: DeviceRunJob[] = []
  cancelled = new Set<string>()
  failures: Array<{ job: DeviceRunJob; code: string; message: string }> = []

  listQueuedDeviceRunJobs(taskId?: string) {
    return this.jobs.filter((job) => !taskId || job.taskId === taskId)
  }
  isCancelled(taskId: string) { return this.cancelled.has(taskId) }
  cancelTask(taskId: string) { this.cancelled.add(taskId) }
  failDeviceRun(job: DeviceRunJob, code: string, message: string) {
    this.failures.push({ job, code, message })
    return true
  }
}

describe('DeviceQueueManager', () => {
  it('同设备串行，不同设备并行', async () => {
    const database = new QueueDatabaseFake()
    database.jobs = [
      { taskId: 'task-1', runId: 'run-a1', deviceId: 'device-a' },
      { taskId: 'task-2', runId: 'run-a2', deviceId: 'device-a' },
      { taskId: 'task-1', runId: 'run-b1', deviceId: 'device-b' },
    ]
    const gates = new Map(database.jobs.map((job) => [job.runId, deferred()]))
    const started: string[] = []
    const finished: string[] = []
    const worker: DeviceRunWorker = {
      async execute(job) {
        started.push(job.runId)
        await gates.get(job.runId)!.promise
        finished.push(job.runId)
      },
      cancelTask() {},
    }

    const queue = new DeviceQueueManager(database as unknown as PlatformDatabase, worker)
    queue.restore()
    await waitFor(() => started.includes('run-a1') && started.includes('run-b1'))
    expect(started).not.toContain('run-a2')

    gates.get('run-b1')!.resolve()
    gates.get('run-a1')!.resolve()
    await waitFor(() => started.includes('run-a2'))
    gates.get('run-a2')!.resolve()
    await waitFor(() => finished.length === 3)
  })

  it('未预期 Worker 异常会标记对应运行失败，并继续同设备下一项', async () => {
    const database = new QueueDatabaseFake()
    database.jobs = [
      { taskId: 'task-1', runId: 'run-1', deviceId: 'device-a' },
      { taskId: 'task-2', runId: 'run-2', deviceId: 'device-a' },
    ]
    const executed: string[] = []
    const worker: DeviceRunWorker = {
      async execute(job) {
        executed.push(job.runId)
        if (job.runId === 'run-1') throw new Error('executor exploded')
      },
      cancelTask() {},
    }

    const queue = new DeviceQueueManager(database as unknown as PlatformDatabase, worker)
    queue.restore()
    await waitFor(() => executed.length === 2)

    expect(database.failures).toEqual([
      {
        job: database.jobs[0],
        code: 'WORKER_UNEXPECTED_ERROR',
        message: 'executor exploded',
      },
    ])
  })

  it('取消任务会移除等待项并通知 Worker', async () => {
    const database = new QueueDatabaseFake()
    database.jobs = [
      { taskId: 'task-running', runId: 'run-running', deviceId: 'device-a' },
      { taskId: 'task-cancel', runId: 'run-cancel', deviceId: 'device-a' },
    ]
    const gate = deferred()
    const executed: string[] = []
    const cancelled: string[] = []
    const worker: DeviceRunWorker = {
      async execute(job) {
        executed.push(job.runId)
        if (job.runId === 'run-running') await gate.promise
      },
      cancelTask(taskId) { cancelled.push(taskId) },
    }

    const queue = new DeviceQueueManager(database as unknown as PlatformDatabase, worker)
    queue.restore()
    await waitFor(() => executed.includes('run-running'))
    queue.cancel('task-cancel')
    gate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(executed).not.toContain('run-cancel')
    expect(database.cancelled).toContain('task-cancel')
    expect(cancelled).toEqual(['task-cancel'])
  })
  it('关闭等待超时后会主动取消运行中任务并等待清理', async () => {
    const database = new QueueDatabaseFake()
    database.jobs = [{ taskId: 'task-stuck', runId: 'run-stuck', deviceId: 'device-a' }]
    const gate = deferred()
    const cancelled: string[] = []
    const worker: DeviceRunWorker = {
      async execute() { await gate.promise },
      cancelTask(taskId) {
        cancelled.push(taskId)
        gate.resolve()
      },
    }
    const queue = new DeviceQueueManager(database as unknown as PlatformDatabase, worker)
    queue.restore()
    await waitFor(() => !queue.isIdle())

    await expect(queue.shutdown(1, 1_000)).resolves.toBe(true)
    expect(database.cancelled).toContain('task-stuck')
    expect(cancelled).toEqual(['task-stuck'])
    expect(queue.isIdle()).toBe(true)
  })

  it('停止接收后拒绝新任务，并可等待正在执行的任务清理完成', async () => {
    const database = new QueueDatabaseFake()
    database.jobs = [{ taskId: 'task-1', runId: 'run-1', deviceId: 'device-a' }]
    const gate = deferred()
    const worker: DeviceRunWorker = {
      async execute() { await gate.promise },
      cancelTask() {},
    }
    const queue = new DeviceQueueManager(database as unknown as PlatformDatabase, worker)
    queue.restore()
    await waitFor(() => !queue.isIdle())
    queue.stopAccepting()

    expect(() => queue.enqueueTask('task-1')).toThrow(QueueNotAcceptingError)
    const shutdown = queue.shutdown(1_000)
    gate.resolve()
    await expect(shutdown).resolves.toBe(true)
    expect(queue.isIdle()).toBe(true)
  })

})
