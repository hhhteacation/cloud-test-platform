import type { DeviceRunResult, TestReport } from '../../types'

export type TaskConclusion = TestReport['conclusion']

/** One place for the task-level result rule used by the Mock runner and UI tests. */
export function getTaskConclusion(runs: DeviceRunResult[]): TaskConclusion {
  const statuses = runs.map((run) => run.status)
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.length > 0 && statuses.every((status) => status === 'passed')) return 'passed'
  return 'not_executed'
}

export function getAverageProgress(runs: DeviceRunResult[]) {
  if (!runs.length) return 0
  return Math.round(runs.reduce((total, run) => total + run.progress, 0) / runs.length)
}
