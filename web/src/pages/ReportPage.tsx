import { ArrowLeftOutlined, DownloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Col, Descriptions, Progress, Row, Space, Statistic, Tag, Typography, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { DeviceResultMatrix } from '../components/report/DeviceResultMatrix'
import { DeviceRunDetailDrawer } from '../components/report/DeviceRunDetailDrawer'
import { DEVICES } from '../features/tasks/taskDefinitions'
import { isRealPlatform, platformClient } from '../platform/client'
import type { DeviceProfile, DeviceRunResult, TestReport } from '../types'
import { formatBytes, formatDate } from '../utils/format'

export function ReportPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [report, setReport] = useState<TestReport>()
  const [devices, setDevices] = useState<DeviceProfile[]>(DEVICES)
  const [selectedRun, setSelectedRun] = useState<DeviceRunResult>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    Promise.all([platformClient.getReport(id), platformClient.listDevices()])
      .then(([nextReport, nextDevices]) => {
        setReport(nextReport)
        setDevices(nextDevices)
      })
      .catch((error) => message.error(error instanceof Error ? error.message : '报告加载失败'))
      .finally(() => setLoading(false))
  }, [id])

  const runs = useMemo(() => Object.values(report?.runs ?? {}), [report])
  const deviceById = useMemo(() => new Map(devices.map((device) => [device.id, device])), [devices])
  const protocolLabel = isRealPlatform
    ? report?.apk?.protocol?.name ?? '未识别 APK 执行协议'
    : 'DemoPlaybackAdapter'

  if (loading) return <Card loading />
  if (!report) return <Alert type="error" showIcon message="报告不存在" />

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${report.id}-report.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => navigate(`/execution/${report.id}`)}>返回执行详情</Button>
          <Typography.Title level={2}>Android 兼容性测试报告</Typography.Title>
          <Space wrap>
            <Tag color={isRealPlatform ? 'green' : 'blue'}>{isRealPlatform ? 'ADB 真机结果' : '模拟结果'}</Tag>
            <Tag>{protocolLabel}</Tag>
            <Typography.Text type="secondary">生成于 {formatDate(report.generatedAt)}</Typography.Text>
          </Space>
        </div>
        <Button type="primary" icon={<DownloadOutlined />} onClick={downloadJson}>导出 JSON 报告</Button>
      </div>

      <ReportSummary report={report} />
      <ReportStats report={report} runs={runs} />
      <ArtifactSummary report={report} />
      <DeviceResultMatrix runs={runs} devices={devices} onOpenDetails={setSelectedRun} />
      <DeviceRunDetailDrawer
        open={Boolean(selectedRun)}
        run={selectedRun}
        device={selectedRun ? deviceById.get(selectedRun.deviceId) : undefined}
        protocolName={protocolLabel}
        protocol={report.apk?.protocol}
        onClose={() => setSelectedRun(undefined)}
      />
    </div>
  )
}

function ReportSummary({ report }: { report: TestReport }) {
  const labels = {
    passed: '兼容性通过',
    failed: '兼容性失败',
    blocked: '等待设备 / 环境',
    cancelled: '任务已取消',
    not_executed: '测试尚未执行',
  }
  const type = report.conclusion === 'passed' ? 'success' : report.conclusion === 'not_executed' ? undefined : 'danger'

  return (
    <Card className="report-banner">
      <div>
        <Typography.Text type="secondary">测试结论</Typography.Text>
        <Typography.Title level={3} type={type}>{labels[report.conclusion]}</Typography.Title>
        <Typography.Text type="secondary">
          {isRealPlatform
            ? '每一行代表一台 Android 真机的独立运行；详情、日志和 output.mp4 均按 deviceRun 隔离。'
            : '该报告来自 Mock Runner，不代表真实 SDK 或真机兼容性通过。'}
        </Typography.Text>
      </div>
      <Progress type="circle" percent={report.passRate ?? 0} status={report.conclusion === 'failed' ? 'exception' : report.conclusion === 'passed' ? 'success' : 'normal'} />
    </Card>
  )
}

function ReportStats({ report, runs }: { report: TestReport; runs: DeviceRunResult[] }) {
  const passed = runs.filter((run) => run.status === 'passed').length
  const failed = runs.filter((run) => run.status === 'failed').length
  const checks = runs.reduce((total, run) => total + run.checks.length, 0)
  return (
    <Row gutter={16} className="stats-row">
      <Col span={6}><Card><Statistic title="总体通过率" value={report.passRate ?? 0} suffix="%" /></Card></Col>
      <Col span={6}><Card><Statistic title="通过设备" value={passed} suffix="台" valueStyle={{ color: '#16a34a' }} /></Card></Col>
      <Col span={6}><Card><Statistic title="失败设备" value={failed} suffix="台" valueStyle={{ color: failed ? '#dc2626' : undefined }} /></Card></Col>
      <Col span={6}><Card><Statistic title="已记录检查项" value={checks} suffix="项" /></Card></Col>
    </Row>
  )
}

function ArtifactSummary({ report }: { report: TestReport }) {
  return (
    <Card title="测试输入" className="table-card">
      <Descriptions bordered column={2} size="small">
        <Descriptions.Item label="测试 APK">{report.apk?.name ?? '未记录'}</Descriptions.Item>
        <Descriptions.Item label="APK 大小">{report.apk ? formatBytes(report.apk.sizeBytes) : '-'}</Descriptions.Item>
        <Descriptions.Item label="APK 包名">{report.apk?.packageName ?? '等待后端校验'}</Descriptions.Item>
        <Descriptions.Item label="APK SHA-256"><Typography.Text code copyable>{report.apk?.sha256 ?? '-'}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="输入 MP4">{report.asset.name}</Descriptions.Item>
        <Descriptions.Item label="输入大小">{formatBytes(report.asset.sizeBytes)}</Descriptions.Item>
        <Descriptions.Item label="输入 SHA-256" span={2}><Typography.Text code copyable>{report.asset.sha256 ?? '-'}</Typography.Text></Descriptions.Item>
      </Descriptions>
    </Card>
  )
}
