import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  MinusOutlined,
  StopFilled,
} from '@ant-design/icons'
import { Button, Card, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { TableProps } from 'antd'

import { findMatrixCheck, REPORT_CHECK_COLUMNS } from '../../features/reports/checkMatrix'
import type { CheckResult, DeviceProfile, DeviceRunResult } from '../../types'

interface DeviceResultMatrixProps {
  runs: DeviceRunResult[]
  devices: DeviceProfile[]
  onOpenDetails: (run: DeviceRunResult) => void
}

function checkIcon(check?: CheckResult, runStatus?: DeviceRunResult['status']) {
  if (!check) {
    if (runStatus === 'running') return <LoadingOutlined className="matrix-status running" spin />
    return <MinusOutlined className="matrix-status missing" />
  }
  if (check.status === 'passed') return <CheckCircleFilled className="matrix-status passed" />
  if (check.status === 'failed') return <CloseCircleFilled className="matrix-status failed" />
  return <StopFilled className="matrix-status blocked" />
}

function resultTag(status: DeviceRunResult['status']) {
  const labels = { queued: '排队中', running: '执行中', passed: '通过', failed: '失败', blocked: '阻断' }
  const colors = { queued: 'default', running: 'processing', passed: 'success', failed: 'error', blocked: 'warning' } as const
  return <Tag color={colors[status]}>{labels[status]}</Tag>
}

export function DeviceResultMatrix({ runs, devices, onOpenDetails }: DeviceResultMatrixProps) {
  const deviceById = new Map(devices.map((device) => [device.id, device]))
  const columns: TableProps<DeviceRunResult>['columns'] = [
    {
      title: '设备信息',
      key: 'device',
      fixed: 'left',
      width: 220,
      render: (_, run) => {
        const device = deviceById.get(run.deviceId)
        return (
          <Space direction="vertical" size={2}>
            <Typography.Text strong>{device?.name ?? run.deviceId}</Typography.Text>
            <Typography.Text type="secondary" className="cell-sub">{device?.osVersion ?? '设备档案未加载'}</Typography.Text>
            {resultTag(run.status)}
          </Space>
        )
      },
    },
    ...REPORT_CHECK_COLUMNS.map((definition) => ({
      title: definition.title,
      key: definition.key,
      width: 92,
      align: 'center' as const,
      render: (_: unknown, run: DeviceRunResult) => {
        const check = findMatrixCheck(run.checks, definition)
        const content = check
          ? `${check.name}：${check.status}${check.durationMs != null ? ` · ${check.durationMs} ms` : ''}${check.message ? ` · ${check.message}` : ''}`
          : run.status === 'running'
            ? `${definition.title}：等待执行`
            : `${definition.title}：未产生结果`
        return <Tooltip title={content}>{checkIcon(check, run.status)}</Tooltip>
      },
    })),
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 112,
      render: (_, run) => <Button type="link" onClick={() => onOpenDetails(run)}>查看详细</Button>,
    },
  ]

  return (
    <Card title="设备兼容性结果矩阵" className="table-card report-matrix-card">
      <Table
        rowKey={(run) => run.id ?? run.deviceId}
        dataSource={runs}
        columns={columns}
        pagination={false}
        scroll={{ x: 220 + REPORT_CHECK_COLUMNS.length * 92 + 112 }}
      />
    </Card>
  )
}
