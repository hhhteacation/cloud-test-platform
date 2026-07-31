import {
  ArrowLeftOutlined,
  StopOutlined,
} from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { StatusTag } from '../components/StatusTag'
import { DeviceRunDetails } from '../components/execution/DeviceRunDetails'
import { DeviceRunList } from '../components/execution/DeviceRunList'
import { ExecutionOverview } from '../components/execution/ExecutionOverview'
import { PhaseCard } from '../components/execution/PhaseCard'
import { isRealPlatform, platformClient } from '../platform/client'
import type { DeviceProfile, TestTask } from '../types'
import { DEVICES } from '../features/tasks/taskDefinitions'

export function ExecutionPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [task, setTask] = useState<TestTask>()
  const [devices, setDevices] = useState<DeviceProfile[]>(DEVICES)
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    let active = true

    Promise.all([platformClient.getTask(id), platformClient.listDevices()])
      .then(([nextTask, nextDevices]) => {
        if (!active) return
        setTask(nextTask)
        setDevices(nextDevices)
        setSelectedDeviceId(nextTask?.deviceIds[0])
      })
      .catch((error) => message.error(error instanceof Error ? error.message : '任务加载失败'))
      .finally(() => active && setLoading(false))

    const unsubscribe = platformClient.subscribeTask(id, (nextTask) => {
      if (!active) return
      setTask(nextTask)
      setSelectedDeviceId((current) => current ?? nextTask.deviceIds[0])
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [id])

  const selectedDevice = devices.find((device) => device.id === selectedDeviceId)
  const selectedRun = selectedDeviceId ? task?.runs[selectedDeviceId] : undefined
  const protocolLabel = isRealPlatform
    ? task?.apk?.protocol?.name ?? '未识别 APK 执行协议'
    : 'DemoPlaybackAdapter'

  const cancelTask = async () => {
    if (!task) return
    try {
      await platformClient.cancelTask(task.id)
      const latest = await platformClient.getTask(task.id)
      if (latest) setTask(latest)
      message.success('已发送取消任务指令')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '取消任务失败')
    }
  }

  if (loading) return <Card loading />
  if (!task) return <Alert type="error" showIcon message="任务不存在" />

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => navigate('/tasks')}>返回任务列表</Button>
          <Typography.Title level={2}>{task.name}</Typography.Title>
          <Space wrap>
            <StatusTag status={task.status} />
            <Tag color={isRealPlatform ? 'green' : 'blue'}>{isRealPlatform ? 'ADB 真机' : 'Mock 模拟'}</Tag>
            <Tag>{protocolLabel}</Tag>
            <Typography.Text type="secondary">任务 ID：{task.id}</Typography.Text>
          </Space>
        </div>
        <Space>
          {task.status === 'passed' || task.status === 'failed' || task.status === 'cancelled' ? (
            <Button type="primary" onClick={() => navigate(`/reports/${task.id}`)}>查看报告</Button>
          ) : (
            <Button danger icon={<StopOutlined />} onClick={cancelTask}>取消任务</Button>
          )}
        </Space>
      </div>

      {!isRealPlatform && (
        <Alert
          className="mode-alert"
          type="warning"
          showIcon
          message="当前是 Mock 任务，不代表真机 SDK 测试通过"
        />
      )}

      <ExecutionOverview task={task} />

      <Row gutter={18}>
        <Col span={7}>
          <DeviceRunList
            task={task}
            devices={devices}
            selectedDeviceId={selectedDeviceId}
            onSelectDevice={setSelectedDeviceId}
          />
          <PhaseCard run={selectedRun} />
        </Col>
        <Col span={17}>
          <DeviceRunDetails device={selectedDevice} run={selectedRun} protocolLabel={protocolLabel} />
        </Col>
      </Row>
    </div>
  )
}


