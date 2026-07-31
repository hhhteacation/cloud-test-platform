import { PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Input, Select, Space, Table, Typography } from 'antd'
import type { TableProps } from 'antd'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { StatusTag } from '../components/StatusTag'
import { TaskActions } from '../features/tasks/TaskActions'
import { isRealPlatform } from '../platform/client'
import { usePlatformTasks } from '../platform/usePlatformData'
import type { TestTask } from '../types'
import { formatBytes, formatDate } from '../utils/format'

const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'running', label: '测试中' },
  { value: 'passed', label: '已通过' },
  { value: 'failed', label: '失败' },
  { value: 'queued', label: '排队中' },
  { value: 'cancelled', label: '已取消' },
]

export function TaskListPage() {
  const navigate = useNavigate()
  const { tasks, loading, error, reload } = usePlatformTasks(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')

  const filteredTasks = useMemo(() => {
    const normalizedSearch = search.toLowerCase()
    return tasks.filter((task) => {
      const matchesSearch = !normalizedSearch || [task.name, task.apk?.name, task.asset.name]
        .some((value) => value?.toLowerCase().includes(normalizedSearch))
      return matchesSearch && (status === 'all' || task.status === status)
    })
  }, [search, status, tasks])

  const columns: TableProps<TestTask>['columns'] = [
    { title: '任务名称', dataIndex: 'name', render: (name: string, task) => <Space direction="vertical" size={2}><Typography.Text strong>{name}</Typography.Text><Typography.Text type="secondary" className="cell-sub">{task.id}</Typography.Text></Space> },
    { title: '测试对象', render: (_, task) => <Space direction="vertical" size={2}><Typography.Text>APK：{task.apk?.name ?? '未记录'}</Typography.Text><Typography.Text type="secondary">视频：{task.asset.name} · {formatBytes(task.asset.sizeBytes)}</Typography.Text></Space> },
    { title: '设备数量', dataIndex: 'deviceIds', render: (ids: string[]) => `${ids.length} 台` },
    { title: '创建时间', dataIndex: 'createdAt', render: formatDate },
    { title: '测试状态', dataIndex: 'status', render: (value: TestTask['status']) => <StatusTag status={value} /> },
    { title: '通过率', dataIndex: 'passRate', render: (value?: number) => value === undefined ? '-' : `${Math.round(value)}%` },
    { title: '操作', width: 210, fixed: 'right', render: (_, task) => <TaskActions task={task} onDeleted={reload} /> },
  ]

  return (
    <div className="page">
      <div className="page-heading">
        <div><Typography.Title level={2}>测试任务</Typography.Title><Typography.Text type="secondary">查看 APK + MP4 真机任务、状态和处理结果。</Typography.Text></div>
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => navigate('/create')}>创建测试任务</Button>
      </div>
      {!isRealPlatform && <Alert className="mode-alert" type="warning" showIcon message="当前显示浏览器 Mock 任务" />}
      {error && <Alert className="mode-alert" type="error" showIcon message="任务列表加载失败" description={error} />}
      <Card className="table-card">
        <div className="filter-bar">
          <Input allowClear prefix={<SearchOutlined />} placeholder="搜索任务、APK 或 MP4" value={search} onChange={(event) => setSearch(event.target.value)} />
          <Select value={status} options={statusOptions} onChange={setStatus} style={{ width: 150 }} />
        </div>
        <Table rowKey="id" loading={loading} dataSource={filteredTasks} columns={columns} pagination={{ pageSize: 8 }} scroll={{ x: 1200 }} />
      </Card>
    </div>
  )
}
