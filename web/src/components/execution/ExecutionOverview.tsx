import { Card, Col, Progress, Row, Statistic, Typography } from 'antd'

import type { TestTask } from '../../types'

export function ExecutionOverview({ task }: { task: TestTask }) {
  const runs = Object.values(task.runs)
  const passedDeviceCount = runs.filter((run) => run.status === 'passed').length
  const completedCheckCount = runs.reduce((total, run) => total + run.checks.length, 0)
  const title = getExecutionTitle(task.status)

  return (
    <Card className="execution-overview">
      <Row align="middle" className="execution-overview-row">
        <Col span={8}>
          <div className="overview-progress-content">
            <Progress
              type="circle"
              percent={task.progress}
              status={getProgressStatus(task.status)}
            />
            <div className="overview-progress-text">
              <Typography.Text type="secondary">总体进度</Typography.Text>
              <Typography.Title level={3}>{title}</Typography.Title>
            </div>
          </div>
        </Col>
        <Col span={16}>
          <Row align="middle" gutter={48}>
            <Col span={8}><Statistic title="设备数量" value={task.deviceIds.length} suffix="台" /></Col>
            <Col span={8}><Statistic title="已通过" value={passedDeviceCount} suffix="台" valueStyle={{ color: '#16a34a' }} /></Col>
            <Col span={8}><Statistic title="已完成检查" value={completedCheckCount} suffix="项" /></Col>
          </Row>
        </Col>
      </Row>
    </Card>
  )
}

function getExecutionTitle(status: TestTask['status']) {
  if (status === 'passed') return '测试完成'
  if (status === 'failed') return '测试失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'queued') return '等待执行'
  return '正在执行'
}

function getProgressStatus(status: TestTask['status']) {
  if (status === 'failed') return 'exception' as const
  if (status === 'passed') return 'success' as const
  return 'active' as const
}
