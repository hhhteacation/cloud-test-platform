import { ApiOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Drawer, Space, Table, Tag, Typography, message } from 'antd'
import type { TableProps } from 'antd'
import { useState } from 'react'

import { isRealPlatform, platformClient } from '../platform/client'
import { usePlatformDevices } from '../platform/usePlatformData'
import type { DeviceDiscoveryCandidate, DeviceProfile } from '../types'
import { formatDate } from '../utils/format'

const connectionLabel = {
  online: '已连接',
  offline: '离线',
  unauthorized: '未授权',
  unknown: '未知',
} as const

function connectionTag(status: DeviceProfile['connectionStatus']) {
  const value = status ?? 'unknown'
  const color = value === 'online' ? 'success' : value === 'offline' || value === 'unauthorized' ? 'error' : 'default'
  return <Tag color={color}>{connectionLabel[value]}</Tag>
}

export function DevicesPage() {
  const { devices, loading, error, reload } = usePlatformDevices()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [candidates, setCandidates] = useState<DeviceDiscoveryCandidate[]>([])
  const [registeringSerial, setRegisteringSerial] = useState<string>()

  const scanDevices = async () => {
    setDrawerOpen(true)
    setDiscovering(true)
    try {
      setCandidates(await platformClient.discoverDevices())
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : 'ADB 设备扫描失败')
    } finally {
      setDiscovering(false)
    }
  }

  const registerDevice = async (candidate: DeviceDiscoveryCandidate) => {
    setRegisteringSerial(candidate.serial)
    try {
      await platformClient.registerDevice(candidate.serial)
      message.success(`${candidate.name ?? candidate.serial} 已录入`)
      await Promise.all([scanDevices(), reload()])
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '设备录入失败')
    } finally {
      setRegisteringSerial(undefined)
    }
  }

  const columns: TableProps<DeviceProfile>['columns'] = [
    { title: '设备', width: 190, render: (_, device) => <Space direction="vertical" size={2}><Typography.Text strong>{device.name}</Typography.Text><Typography.Text type="secondary">{device.manufacturer} · {device.model ?? '-'}</Typography.Text></Space> },
    { title: '平台', dataIndex: 'platform', width: 100, render: () => <Tag color="green">Android</Tag> },
    { title: '系统', dataIndex: 'osVersion', width: 130 },
    { title: 'API', dataIndex: 'apiLevel', width: 70 },
    { title: '架构', dataIndex: 'architecture', width: 120 },
    { title: 'Serial', dataIndex: 'serial', width: 190, render: (serial?: string) => serial ? <Typography.Text code>{serial}</Typography.Text> : '-' },
    { title: '连接状态', dataIndex: 'connectionStatus', width: 100, render: connectionTag },
    { title: '系统 Build', dataIndex: 'buildVersion', width: 230, ellipsis: true, render: (value?: string) => value || '-' },
    { title: '最后在线', dataIndex: 'lastSeenAt', width: 160, render: (value?: string) => value ? formatDate(value) : '-' },
    { title: '可调度', fixed: 'right', width: 100, render: (_, device) => <Tag color={device.eligible && device.executionMode === 'adb' && device.connectionStatus === 'online' ? 'success' : 'default'}>{device.eligible && device.executionMode === 'adb' && device.connectionStatus === 'online' ? '可执行' : '不可执行'}</Tag> },
  ]

  const discoveryColumns: TableProps<DeviceDiscoveryCandidate>['columns'] = [
    { title: '设备', width: 180, render: (_, item) => <Space direction="vertical" size={1}><Typography.Text strong>{item.name ?? item.model ?? item.serial}</Typography.Text><Typography.Text type="secondary">{item.manufacturer ?? 'Android'} · {item.model ?? '-'}</Typography.Text></Space> },
    { title: 'Android', dataIndex: 'androidVersion', width: 100, render: (value?: string) => value || '-' },
    { title: 'API', dataIndex: 'apiLevel', width: 70, render: (value?: number) => value ?? '-' },
    { title: 'ABI', dataIndex: 'architecture', width: 130, render: (value?: string) => value || '-' },
    { title: 'Serial', dataIndex: 'serial', width: 190, render: (serial: string) => <Typography.Text code>{serial}</Typography.Text> },
    { title: '授权状态', dataIndex: 'connectionStatus', width: 120, render: connectionTag },
    {
      title: '操作', fixed: 'right', width: 150, render: (_, candidate) => {
        if (candidate.registeredDeviceId) return <Tag color="success">已录入</Tag>
        if (candidate.connectionStatus === 'unauthorized') return <Typography.Text type="warning">请在手机确认授权</Typography.Text>
        return <Button type="primary" size="small" disabled={candidate.connectionStatus !== 'online'} loading={registeringSerial === candidate.serial} onClick={() => void registerDevice(candidate)}>录入设备</Button>
      },
    },
  ]

  return (
    <div className="page">
      <div className="page-heading">
        <div><Typography.Title level={2}>Android 设备管理</Typography.Title><Typography.Text type="secondary">通过 ADB 自动扫描、确认和录入真机；设备数量不写死，后续可继续扩展。</Typography.Text></div>
        <Space>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()}>刷新状态</Button>
          <Button type="primary" icon={<SearchOutlined />} disabled={!isRealPlatform} onClick={() => void scanDevices()}>扫描 ADB 设备</Button>
        </Space>
      </div>
      {!isRealPlatform && <Alert className="mode-alert" type="warning" showIcon message="Mock 模式不会读取电脑真实 ADB 状态" />}
      {error && <Alert className="mode-alert" type="error" showIcon message="设备读取失败" description={error} />}
      <Card className="table-card"><Table rowKey="id" loading={loading} dataSource={devices} columns={columns} pagination={false} scroll={{ x: 1390 }} /></Card>

      <Drawer title={<Space><ApiOutlined />ADB 扫描结果</Space>} width={1100} open={drawerOpen} onClose={() => setDrawerOpen(false)} extra={<Button icon={<ReloadOutlined />} loading={discovering} onClick={() => void scanDevices()}>重新扫描</Button>}>
        <Alert className="mode-alert" type="info" showIcon message="录入前会由后端重新验证 Serial 和授权状态" description="未授权设备请在手机上确认 USB 调试授权，再点击重新扫描。重复录入同一 Serial 只会更新设备档案。" />
        <Table rowKey="serial" loading={discovering} dataSource={candidates} columns={discoveryColumns} pagination={false} scroll={{ x: 940 }} locale={{ emptyText: '没有发现 ADB 设备，请检查 USB 连接与调试授权' }} />
      </Drawer>
    </div>
  )
}
