import type { TaskCapabilities, TaskStatus } from './types.js'

const DELETABLE_STATUSES = new Set<TaskStatus>(['passed', 'failed', 'cancelled'])

export function getTaskCapabilities(status: TaskStatus): TaskCapabilities {
  if (DELETABLE_STATUSES.has(status)) {
    return { canCancel: false, canDelete: true }
  }

  return {
    canCancel: status === 'queued' || status === 'running',
    canDelete: false,
    deleteBlockedReason: status === 'running'
      ? '任务正在执行，请先取消任务'
      : '任务正在排队，请先取消任务',
  }
}

export function isTaskDeletable(
  status: TaskStatus,
): status is Extract<TaskStatus, 'passed' | 'failed' | 'cancelled'> {
  return DELETABLE_STATUSES.has(status)
}
