import { DeleteOutlined, EyeOutlined } from '@ant-design/icons'
import { Button, message, Popconfirm, Space, Tooltip } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { platformClient } from '../../platform/client'
import { ensureTaskCapabilities } from './taskCapabilities'
import type { TestTask } from '../../types'

interface TaskActionsProps {
  task: TestTask
  onDeleted: () => void | Promise<void>
}

const TERMINAL_STATUSES = new Set<TestTask['status']>(['passed', 'failed', 'cancelled'])

export function TaskActions({ task, onDeleted }: TaskActionsProps) {
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const capabilities = ensureTaskCapabilities(task).capabilities
  const isTerminal = TERMINAL_STATUSES.has(task.status)

  const deleteTask = async () => {
    if (deleting || !capabilities.canDelete) return

    setDeleting(true)
    try {
      const receipt = await platformClient.deleteTask(task.id)
      message.success(`测试任务“${task.name}”已删除`)
      if (receipt.fileCleanupWarnings.length > 0) {
        message.warning(`任务已删除，但有 ${receipt.fileCleanupWarnings.length} 项文件清理警告`)
      }

      try {
        await onDeleted()
      } catch {
        message.warning('任务已经删除，但列表刷新失败，请手动刷新页面')
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除测试任务失败')
    } finally {
      setDeleting(false)
    }
  }

  const deleteButton = (
    <Button
      danger
      type="link"
      icon={<DeleteOutlined />}
      disabled={deleting || !capabilities.canDelete}
      loading={deleting}
    >
      删除
    </Button>
  )

  return (
    <Space size={4}>
      <Button
        type="link"
        icon={<EyeOutlined />}
        onClick={() => navigate(isTerminal ? `/reports/${task.id}` : `/execution/${task.id}`)}
      >
        {isTerminal ? '查看报告' : '查看执行'}
      </Button>
      {capabilities.canDelete ? (
        <Popconfirm
          title={`确定永久删除“${task.name}”吗？`}
          description={(
            <div>
              <div>将删除该任务的报告、运行记录、日志、截图和输出视频。</div>
              <div>仍被其他任务使用的 APK 和 MP4 不会删除。删除后无法恢复。</div>
            </div>
          )}
          okText="永久删除"
          cancelText="取消"
          okButtonProps={{ danger: true, loading: deleting }}
          onConfirm={deleteTask}
        >
          {deleteButton}
        </Popconfirm>
      ) : (
        <Tooltip title={capabilities.deleteBlockedReason}>
          <span>{deleteButton}</span>
        </Tooltip>
      )}
    </Space>
  )
}
