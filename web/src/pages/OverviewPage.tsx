import { ArrowRightOutlined, ClockCircleOutlined, CloudUploadOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Col, Progress, Row, Space, Statistic, Tag, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'

import { StatusTag } from '../components/StatusTag'
import { isRealPlatform } from '../platform/client'
import { usePlatformDevices, usePlatformTasks } from '../platform/usePlatformData'
import type { TestTask } from '../types'

export function OverviewPage() {
  const navigate = useNavigate()
  const { tasks, error: taskError } = usePlatformTasks(true)
  const { devices, error: deviceError } = usePlatformDevices()
  const latestTask = tasks[0]
  const adbDevice = devices.find((device) => device.executionMode === 'adb')

  return (
    <div className="page">
      <div className="page-heading">
        <div><Typography.Title level={2}>云测试</Typography.Title><Typography.Paragraph type="secondary">上传 APK 和 MP4，在荣耀 Android 真机上执行 SDK 视频处理并回收 output.mp4。</Typography.Paragraph></div>
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => navigate('/create')}>创建测试任务</Button>
      </div>

      {(taskError || deviceError) && <Alert className="mode-alert" type="error" showIcon message="平台数据加载失败" description={taskError || deviceError} />}
      <Card className="notice-card">
        <Space>
          <SafetyCertificateOutlined className="notice-icon" />
          <div>
            <Typography.Text strong>{isRealPlatform ? '当前为本地 ADB 真机执行模式' : '当前为浏览器 Mock 演示模式'}</Typography.Text>
            <Typography.Paragraph type="secondary">
              {isRealPlatform ? '真实任务由 Fastify、SQLite 和 ADB Worker 执行；没有真实 SDK Bridge 时会如实失败。' : '配置 VITE_API_BASE_URL=/api 并启动后端后，才能上传文件和调度真实设备。'}
            </Typography.Paragraph>
          </div>
        </Space>
        <Tag color={adbDevice?.connectionStatus === 'online' ? 'success' : 'warning'}>{adbDevice?.connectionStatus === 'online' ? '荣耀真机已连接' : '荣耀真机未就绪'}</Tag>
      </Card>

      <Row gutter={16} className="stats-row">
        <Col span={6}><Card><Statistic title="测试任务" value={tasks.length} prefix={<CloudUploadOutlined />} suffix="个" /></Card></Col>
        <Col span={6}><Card><Statistic title="可调度真机" value={devices.filter((device) => device.eligible && device.executionMode === 'adb').length} suffix="台" /></Card></Col>
        <Col span={6}><Card><Statistic title="最近任务通过率" value={latestTask?.passRate ?? 0} suffix="%" /></Card></Col>
        <Col span={6}><Card><Statistic title="任务超时默认值" value={300} prefix={<ClockCircleOutlined />} suffix="秒" /></Card></Col>
      </Row>

      <Row gutter={16}>
        <Col span={16}><RecentTaskCard latestTask={latestTask} onView={() => navigate(latestTask ? `/execution/${latestTask.id}` : '/tasks')} /></Col>
        <Col span={8}><CapabilityCard /></Col>
      </Row>
    </div>
  )
}

function RecentTaskCard({ latestTask, onView }: { latestTask?: TestTask; onView: () => void }) {
  return (
    <Card title="最近测试任务" extra={<Button type="link" onClick={onView}>查看详情 <ArrowRightOutlined /></Button>}>
      <div className="latest-task">
        <div className="task-avatar">MP4</div>
        <div className="task-summary"><Typography.Text strong>{latestTask?.name ?? '暂无任务'}</Typography.Text><Typography.Text type="secondary">{latestTask ? `${latestTask.apk?.name ?? 'APK 未记录'} + ${latestTask.asset.name}` : '请先创建 APK + MP4 任务'}</Typography.Text></div>
        <StatusTag status={latestTask?.status ?? 'draft'} />
        <Progress percent={latestTask?.progress ?? 0} size="small" showInfo={false} className="task-progress" />
        <Typography.Text strong>{latestTask?.progress ?? 0}%</Typography.Text>
      </div>
    </Card>
  )
}

function CapabilityCard() {
  return (
    <Card title="MVP 执行能力">
      {['APK/AAPT 校验与安装', 'MP4 推送到应用任务目录', 'SDK_COMPAT 结构化事件', 'output.mp4 / result.json 回收', 'Range 在线播放与下载'].map((item) => <div className="capability" key={item}>✓ {item}</div>)}
    </Card>
  )
}
