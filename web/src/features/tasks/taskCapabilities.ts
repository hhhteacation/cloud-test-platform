import type { TaskCapabilities, TestTask, TestTaskStatus } from '../../types'

const DELETABLE_STATUSES = new Set<TestTaskStatus>(['passed', 'failed', 'cancelled'])

export function getTaskCapabilities(status: TestTaskStatus): TaskCapabilities {
  if (DELETABLE_STATUSES.has(status)) {
    return { canCancel: false, canDelete: true }
  }

  const deleteBlockedReason = status === 'running'
    ? '任务正在执行，请先取消任务'
    : status === 'queued'
      ? '任务正在排队，请先取消任务'
      : '草稿任务暂不支持删除'

  return {
    canCancel: status === 'queued' || status === 'running',
    canDelete: false,
    deleteBlockedReason,
  }
}

export function withTaskCapabilities<T extends TestTask>(task: T): T {
  return { ...task, capabilities: getTaskCapabilities(task.status) }
}

/**
 * 兼容仍在运行的旧版后端：旧响应可能没有 capabilities。
 * 若后端已经返回能力字段则尊重后端结果，否则按任务状态补齐，避免页面渲染白屏。
 */
export function ensureTaskCapabilities<T extends TestTask>(task: T): T {
  const capabilities = task.capabilities
  if (
    capabilities &&
    typeof capabilities.canCancel === 'boolean' &&
    typeof capabilities.canDelete === 'boolean'
  ) {
    return task
  }

  return { ...task, capabilities: getTaskCapabilities(task.status) }
}
