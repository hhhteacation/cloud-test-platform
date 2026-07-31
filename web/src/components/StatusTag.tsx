import { Tag } from 'antd'
import type { DeviceRunStatus, TestTaskStatus } from '../types'

const STATUS_LABELS: Record<string, [label: string, color: string]> = {
  queued: ['排队中', 'default'],
  running: ['测试中', 'processing'],
  passed: ['通过', 'success'],
  failed: ['失败', 'error'],
  blocked: ['阻断', 'warning'],
  cancelled: ['已取消', 'default'],
  draft: ['草稿', 'default'],
}

interface StatusTagProps {
  status: TestTaskStatus | DeviceRunStatus
}

export function StatusTag({ status }: StatusTagProps) {
  const [label, color] = STATUS_LABELS[status] ?? [status, 'default']

  return <Tag color={color}>{label}</Tag>
}
