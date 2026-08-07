import { describe, expect, it } from 'vitest'

import type { DeviceProfile, DeviceRunResult, TestTask } from '../types'
import { buildRailSteps, selectPrimaryRun, selectSignalDevice, selectSignalTask } from './OverviewPage'

function createRun(
  deviceId: string,
  status: DeviceRunResult['status'],
  overrides: Partial<DeviceRunResult> = {},
): DeviceRunResult {
  return {
    id: `run-${deviceId}`,
    deviceId,
    status,
    progress: status === 'passed' ? 100 : 40,
    checks: [],
    logs: [],
    outputs: [],
    mode: 'ADB 真机',
    ...overrides,
  }
}

function createTask(
  status: TestTask['status'],
  runs: DeviceRunResult[],
): TestTask {
  return {
    id: 'task-latest',
    platform: 'android',
    name: '真实多设备任务',
    apk: {
      id: 'apk-1',
      kind: 'apk',
      name: 'sdk-demo.apk',
      sizeBytes: 1024,
      mimeType: 'application/vnd.android.package-archive',
    },
    asset: {
      id: 'video-1',
      kind: 'video',
      name: 'input.mp4',
      sizeBytes: 2048,
      mimeType: 'video/mp4',
    },
    deviceIds: runs.map((run) => run.deviceId),
    status,
    progress: 50,
    createdAt: '2026-07-31T08:00:00.000Z',
    runs: Object.fromEntries(runs.map((run) => [run.deviceId, run])),
    capabilities: { canCancel: status === 'running', canDelete: status !== 'running' },
  }
}

function createDevice(id: string, connectionStatus: DeviceProfile['connectionStatus']): DeviceProfile {
  return {
    id,
    platform: 'android',
    name: `设备 ${id}`,
    manufacturer: 'Android',
    osVersion: 'Android 16',
    apiLevel: 36,
    architecture: 'arm64-v8a',
    executionMode: 'adb',
    eligible: true,
    connectionStatus,
  }
}

describe('首页真机信号轨道映射', () => {
  it('优先展示正在运行的真实任务，而不是仅按创建顺序展示最近任务', () => {
    const latestPassedTask = createTask('passed', [createRun('device-passed', 'passed')])
    const runningTask = {
      ...createTask('running', [createRun('device-running', 'running')]),
      id: 'task-running',
    }

    expect(selectSignalTask([latestPassedTask, runningTask])).toBe(runningTask)
  })

  it('没有运行任务时优先展示等待调度的任务', () => {
    const latestPassedTask = createTask('passed', [createRun('device-passed', 'passed')])
    const queuedTask = {
      ...createTask('queued', [createRun('device-queued', 'queued')]),
      id: 'task-queued',
    }

    expect(selectSignalTask([latestPassedTask, queuedTask])).toBe(queuedTask)
  })

  it('多设备任务失败时优先呈现失败 run，而不是第一个已通过的 run', () => {
    const passedRun = createRun('device-passed', 'passed', { phase: 'completed', progress: 100 })
    const failedRun = createRun('device-failed', 'failed', {
      phase: 'processing',
      failureMessage: 'SDK 处理失败',
      progress: 64,
    })

    expect(selectPrimaryRun(createTask('failed', [passedRun, failedRun]))).toBe(failedRun)
  })

  it('任务执行中优先呈现仍在运行的真机 run', () => {
    const passedRun = createRun('device-passed', 'passed', { phase: 'completed', progress: 100 })
    const runningRun = createRun('device-running', 'running', { phase: 'processing', progress: 72 })

    expect(selectPrimaryRun(createTask('running', [passedRun, runningRun]))).toBe(runningRun)
  })

  it('设备信息严格匹配当前信号 run，不被无关的在线设备替换', () => {
    const run = createRun('device-offline', 'passed', { phase: 'completed', progress: 100 })
    const task = createTask('passed', [run])
    const unrelatedOnlineDevice = createDevice('device-online', 'online')
    const matchingOfflineDevice = createDevice('device-offline', 'offline')

    expect(selectSignalDevice(task, run, [unrelatedOnlineDevice, matchingOfflineDevice])).toBe(matchingOfflineDevice)
  })

  it('APK 校验失败归入 INPUT 阶段，不错误标记为 ADB 阶段', () => {
    const run = createRun('device-1', 'failed', { phase: 'validating_apk', progress: 8 })
    const task = createTask('failed', [run])
    const [input, adb, sdk, output] = buildRailSteps(task, run, createDevice('device-1', 'online'))

    expect(input.state).toBe('failed')
    expect([adb.state, sdk.state, output.state]).toEqual(['pending', 'pending', 'pending'])
  })
})
