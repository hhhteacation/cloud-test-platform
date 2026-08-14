import type {
  MockCreateTaskInput,
  DeviceRunResult,
  TestReport,
  TestRunner,
  TestTask,
  TaskUpdateListener,
} from '../types'
import { getTaskCapabilities } from '../features/tasks/taskCapabilities'
import { CHECKS } from '../features/tasks/taskDefinitions'
import { getAverageProgress, getTaskConclusion } from '../features/tasks/taskRules'
import { clone, readTasks, TASKS_STORAGE_KEY, writeTasks } from './mockStorage'
import { MOCK_TIMING } from './mockTiming'

function createQueuedRun(input: MockCreateTaskInput['executions'][number]): DeviceRunResult {
  return {
    deviceId: input.deviceId,
    endpointId: input.endpointId,
    connectionKind: input.connectionKind,
    adbSerial: input.adbSerial,
    status: 'queued',
    progress: 0,
    checks: [],
    logs: ['任务排队中'],
    outputs: [],
    // Mock 客户端中的所有执行都必须明确标记为模拟，不能把设备档案中的 ADB 能力冒充为真机结果。
    mode: '模拟结果',
  }
}

function createTask(input: MockCreateTaskInput): TestTask {
  const id = `task-${Date.now()}`
  return {
    id,
    platform: 'android',
    name: input.name,
    apk: input.apk,
    asset: input.asset,
    videos: (input.assets ?? [input.asset]).map((asset, sequence) => ({
      id: `mock-task-video-${sequence}`,
      taskId: id,
      artifactId: asset.id,
      sequence,
      displayName: asset.name,
      asset,
    })),
    deviceIds: input.deviceIds,
    connectionMode: input.connectionMode,
    status: 'queued',
    progress: 0,
    createdAt: new Date().toISOString(),
    capabilities: getTaskCapabilities('queued'),
    runs: Object.fromEntries(
      input.executions.map((execution) => [execution.deviceId, createQueuedRun(execution)]),
    ),
  }
}

export class MockTestRunner implements TestRunner {
  private listeners = new Map<string, Set<TaskUpdateListener>>()
  private timers = new Map<string, number[]>()

  constructor() {
    this.initializeStorage()
  }

  async createTask(input: MockCreateTaskInput) {
    const task = createTask(input)
    const tasks = readTasks()

    tasks.unshift(task)
    writeTasks(tasks)
    this.simulate(task.id)

    return clone(task)
  }

  async getTask(taskId: string) {
    return clone(readTasks().find((task) => task.id === taskId))
  }

  subscribeTask(taskId: string, listener: TaskUpdateListener) {
    if (!this.listeners.has(taskId)) {
      this.listeners.set(taskId, new Set())
    }

    this.listeners.get(taskId)?.add(listener)

    return () => {
      this.listeners.get(taskId)?.delete(listener)
    }
  }

  async getReport(taskId: string): Promise<TestReport | undefined> {
    const task = await this.getTask(taskId)

    if (!task) {
      return undefined
    }

    const conclusion = getTaskConclusion(Object.values(task.runs))

    return {
      ...task,
      conclusion,
      generatedAt: new Date().toISOString(),
    }
  }

  async cancelTask(taskId: string) {
    const timers = this.timers.get(taskId) || []

    timers.forEach((timer) => window.clearTimeout(timer))

    const tasks = readTasks().map((task) => {
      if (task.id !== taskId) {
        return task
      }

      const runs = Object.fromEntries(
        Object.entries(task.runs).map(([deviceId, run]) => [
          deviceId,
          run.status === 'passed'
            ? run
            : {
                ...run,
                status: 'blocked' as const,
                logs: [...run.logs, '任务已取消'],
              },
        ]),
      )

      return {
        ...task,
        status: 'cancelled' as const,
        runs,
      }
    })

    writeTasks(tasks)
    this.emit(taskId)
  }

  private initializeStorage() {
    if (localStorage.getItem(TASKS_STORAGE_KEY)) {
      return
    }

    const seedInstalled = localStorage.getItem('sdk-seed-installed')

    if (!seedInstalled) {
      localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify([]))
      localStorage.setItem('sdk-seed-installed', '1')
    }
  }

  private simulate(taskId: string) {
    const timers: number[] = []

    timers.push(
      window.setTimeout(
        () => this.updateTask(taskId, (task) => ({ ...task, status: 'running' })),
        MOCK_TIMING.runningStartMs,
      ),
    )

    const task = readTasks().find((item) => item.id === taskId)

    if (!task) {
      return
    }

    task.deviceIds.forEach((deviceId, deviceIndex) => {
      CHECKS.forEach((check, checkIndex) => {
        const delay =
          MOCK_TIMING.firstCheckMs +
          (deviceIndex * CHECKS.length + checkIndex) * MOCK_TIMING.checkIntervalMs

        timers.push(
          window.setTimeout(
            () => this.completeCheck(taskId, deviceId, check, checkIndex),
            delay,
          ),
        )
      })
    })

    this.timers.set(taskId, timers)
  }

  private completeCheck(
    taskId: string,
    deviceId: string,
    check: (typeof CHECKS)[number],
    checkIndex: number,
  ) {
    this.updateTask(taskId, (currentTask) => {
      const runs = { ...currentTask.runs }
      const previousRun = runs[deviceId]
      const checks = [
        ...previousRun.checks,
        {
          ...check,
          status: 'passed' as const,
          durationMs: 160 + checkIndex * 18,
          message: '模拟检查通过',
        },
      ]
      const progress = Math.round((checks.length / CHECKS.length) * 100)

      runs[deviceId] = {
        ...previousRun,
        status: progress === 100 ? 'passed' : 'running',
        progress,
        checks,
        logs: [...previousRun.logs, `${check.name}：通过`],
      }

      const passedDeviceCount = Object.values(runs).filter(
        (run) => run.status === 'passed',
      ).length

      return {
        ...currentTask,
        status:
          passedDeviceCount === currentTask.deviceIds.length
            ? 'passed'
            : 'running',
        progress: getAverageProgress(Object.values(runs)),
        passRate: (passedDeviceCount / currentTask.deviceIds.length) * 100,
        runs,
      }
    })
  }

  private updateTask(
    taskId: string,
    updater: (task: TestTask) => TestTask,
  ) {
    const tasks = readTasks().map((task) => {
      if (task.id !== taskId || task.status === 'cancelled') return task
      return updater(task)
    })

    writeTasks(tasks)
    this.emit(taskId)
  }

  private emit(taskId: string) {
    const task = readTasks().find((item) => item.id === taskId)

    if (!task) {
      return
    }

    this.listeners.get(taskId)?.forEach((listener) => listener(clone(task)))
  }
}
