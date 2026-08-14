import {
  ApiOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  LinkOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd'
import type { TableProps } from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'

import { isRealPlatform, platformClient } from '../platform/client'
import { createDeviceRefreshCoordinator, usePlatformDevices } from '../platform/usePlatformData'
import type {
  DeviceConnectionStatus,
  DeviceDiscoveryCandidate,
  DeviceEndpoint,
  DeviceProfile,
  NetworkConnectionOperation,
} from '../types'
import { formatDate } from '../utils/format'

const connectionLabel: Record<DeviceConnectionStatus, string> = {
  online: '在线',
  offline: '离线',
  unauthorized: '未授权',
  unknown: '未知',
}

const queueLabel = {
  idle: '空闲',
  queued: '排队中',
  running: '执行中',
} as const

function connectionTag(status?: DeviceConnectionStatus, missingLabel = '未配置') {
  if (!status) return <Tag>{missingLabel}</Tag>
  const color = status === 'online' ? 'success' : status === 'offline' || status === 'unauthorized' ? 'error' : 'default'
  return <Tag color={color}>{connectionLabel[status]}</Tag>
}

function queueTag(status: DeviceProfile['queueStatus']) {
  const value = status ?? 'idle'
  const color = value === 'running' ? 'processing' : value === 'queued' ? 'warning' : 'default'
  return <Tag color={color}>{queueLabel[value]}</Tag>
}

function endpointAddress(endpoint?: DeviceEndpoint) {
  if (!endpoint) return '-'
  if (endpoint.host && endpoint.port) return `${endpoint.host}:${endpoint.port}`
  return endpoint.adbSerial || '-'
}

interface NetworkEndpointFormValues {
  deviceId: string
  host: string
  port: number
}

export function DevicesPage() {
  const { devices, loading, error, reload, replaceDevices } = usePlatformDevices()
  const [networkForm] = Form.useForm<NetworkEndpointFormValues>()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [candidates, setCandidates] = useState<DeviceDiscoveryCandidate[]>([])
  const [registeringSerial, setRegisteringSerial] = useState<string>()
  const [networkCandidates, setNetworkCandidates] = useState<DeviceDiscoveryCandidate[]>([])
  const [networkDiscovering, setNetworkDiscovering] = useState(false)
  const [networkConnecting, setNetworkConnecting] = useState(false)
  const [networkOperation, setNetworkOperation] = useState<string>()
  const [refreshingDevices, setRefreshingDevices] = useState(false)
  const [networkBatchOperation, setNetworkBatchOperation] = useState<NetworkConnectionOperation>()
  const [networkBatchStarting, setNetworkBatchStarting] = useState(false)
  const [networkBatchCancelling, setNetworkBatchCancelling] = useState(false)
  const networkBatchPollTimer = useRef<number | undefined>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      if (networkBatchPollTimer.current !== undefined) {
        window.clearTimeout(networkBatchPollTimer.current)
        networkBatchPollTimer.current = undefined
      }
    }
  }, [])

  const androidDevices = useMemo(
    () => devices.filter((device) => device.platform === 'android'),
    [devices],
  )

  const performDeviceRefresh = useMemo(
    () => createDeviceRefreshCoordinator(platformClient, replaceDevices),
    [replaceDevices],
  )

  const refreshDevices = async () => {
    if (refreshingDevices) return
    setRefreshingDevices(true)
    try {
      await performDeviceRefresh()
      message.success('设备连接状态已刷新')
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : 'ADB 设备状态刷新失败')
    } finally {
      setRefreshingDevices(false)
    }
  }

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

  const scanNetworkDevices = async () => {
    setNetworkDiscovering(true)
    try {
      const discovered = await platformClient.discoverNetworkDevices()
      setNetworkCandidates(discovered)
      if (discovered.length === 0) message.info('未发现 ADB mDNS 联网服务，可继续手动输入地址')
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : 'ADB mDNS 发现失败')
    } finally {
      setNetworkDiscovering(false)
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

  const connectNetwork = async (values: NetworkEndpointFormValues) => {
    setNetworkConnecting(true)
    try {
      await platformClient.connectNetworkDevice(values.deviceId, values.host.trim(), values.port)
      message.success('联网 Endpoint 已连接并绑定到物理设备')
      networkForm.resetFields(['host'])
      networkForm.setFieldValue('port', 5555)
      await reload()
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '联网 ADB 连接失败')
      await reload()
    } finally {
      setNetworkConnecting(false)
    }
  }

  const runNetworkOperation = async (
    key: string,
    operation: () => Promise<unknown>,
    successMessage: string,
  ) => {
    setNetworkOperation(key)
    try {
      await operation()
      message.success(successMessage)
      await reload()
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '联网 Endpoint 操作失败')
      await reload()
    } finally {
      setNetworkOperation(undefined)
    }
  }

  const networkBatchActive = networkBatchOperation?.status === 'queued' || networkBatchOperation?.status === 'running'

  function clearNetworkBatchPollTimer() {
    if (networkBatchPollTimer.current === undefined) return
    window.clearTimeout(networkBatchPollTimer.current)
    networkBatchPollTimer.current = undefined
  }

  function scheduleNetworkBatchPoll(operationId: string) {
    clearNetworkBatchPollTimer()
    if (!mountedRef.current) return
    networkBatchPollTimer.current = window.setTimeout(() => {
      networkBatchPollTimer.current = undefined
      void pollNetworkBatchOperation(operationId)
    }, 1000)
  }

  async function pollNetworkBatchOperation(operationId: string) {
    try {
      const operation = await platformClient.getNetworkConnectionOperation(operationId)
      if (!mountedRef.current) return
      setNetworkBatchOperation(operation)
      if (operation.status === 'queued' || operation.status === 'running') {
        scheduleNetworkBatchPoll(operationId)
      } else {
        clearNetworkBatchPollTimer()
        await reload()
        if (!mountedRef.current) return
        const level = operation.status === 'completed' ? 'success' : operation.status === 'cancelled' ? 'warning' : 'error'
        message[level](`批量连接完成：成功 ${operation.succeeded}，失败 ${operation.failed}，跳过 ${operation.skipped}，取消 ${operation.cancelled}`)
      }
    } catch (reason) {
      if (!mountedRef.current) return
      message.error(reason instanceof Error ? reason.message : '批量连接状态查询失败')
      scheduleNetworkBatchPoll(operationId)
    }
  }

  const startNetworkBatch = async () => {
    if (networkBatchActive || networkBatchStarting || !isRealPlatform) return
    setNetworkBatchStarting(true)
    try {
      const started = await platformClient.startNetworkConnectionOperation()
      clearNetworkBatchPollTimer()
      void pollNetworkBatchOperation(started.operationId)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '批量联网连接启动失败')
    } finally {
      setNetworkBatchStarting(false)
    }
  }

  const cancelNetworkBatch = async () => {
    if (!networkBatchOperation || !networkBatchActive || networkBatchCancelling) return
    setNetworkBatchCancelling(true)
    try {
      const operation = await platformClient.cancelNetworkConnectionOperation(networkBatchOperation.id)
      setNetworkBatchOperation(operation)
      clearNetworkBatchPollTimer()
      void pollNetworkBatchOperation(operation.id)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '批量联网连接取消失败')
    } finally {
      setNetworkBatchCancelling(false)
    }
  }

  const overviewColumns: TableProps<DeviceProfile>['columns'] = [
    {
      title: '物理设备',
      width: 220,
      render: (_, device) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{device.name}</Typography.Text>
          <Typography.Text type="secondary">{device.manufacturer} · {device.model ?? '-'}</Typography.Text>
        </Space>
      ),
    },
    { title: 'Android', dataIndex: 'osVersion', width: 130 },
    { title: 'API', dataIndex: 'apiLevel', width: 70 },
    {
      title: 'USB',
      width: 190,
      render: (_, device) => (
        <Space direction="vertical" size={2}>
          {connectionTag(device.endpoints?.usb?.status)}
          <Typography.Text type="secondary" code>{device.endpoints?.usb?.adbSerial ?? device.serial ?? '未配置'}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '联网',
      width: 190,
      render: (_, device) => (
        <Space direction="vertical" size={2}>
          {connectionTag(device.endpoints?.network?.status)}
          <Typography.Text type="secondary" code>{endpointAddress(device.endpoints?.network)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '整体状态',
      width: 110,
      render: (_, device) => connectionTag(device.overallConnectionStatus ?? device.connectionStatus),
    },
    { title: '任务队列', width: 100, render: (_, device) => queueTag(device.queueStatus) },
    {
      title: '最近在线',
      dataIndex: 'lastSeenAt',
      width: 170,
      render: (value?: string) => value ? formatDate(value) : '-',
    },
    {
      title: '可执行',
      width: 120,
      render: (_, device) => (
        <Space direction="vertical" size={2}>
          <Tag color={device.selectable === false ? 'default' : 'success'}>
            {device.selectable === false ? '不可执行' : '可执行'}
          </Tag>
          {device.unavailableReason ? <Typography.Text type="danger">{device.unavailableReason}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: '操作',
      fixed: 'right',
      width: 90,
      render: (_, device) => (
        <Button
          type="link"
          size="small"
          icon={<ReloadOutlined />}
          loading={networkOperation === `overview:${device.id}`}
          disabled={networkBatchActive}
          onClick={() => {
            const endpoint = device.endpoints?.network
            if (!endpoint) {
              void reload()
              return
            }
            void runNetworkOperation(
              `overview:${device.id}`,
              () => platformClient.refreshNetworkDevice(device.id, endpoint.id),
              '设备连接状态已刷新',
            )
          }}
        >
          刷新
        </Button>
      ),
    },
  ]

  const usbColumns: TableProps<DeviceProfile>['columns'] = [
    {
      title: '设备',
      width: 220,
      render: (_, device) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{device.name}</Typography.Text>
          <Typography.Text type="secondary">{device.manufacturer} · {device.model ?? '-'}</Typography.Text>
        </Space>
      ),
    },
    { title: '系统', dataIndex: 'osVersion', width: 130 },
    { title: 'API', dataIndex: 'apiLevel', width: 70 },
    { title: '架构', dataIndex: 'architecture', width: 120 },
    {
      title: 'USB Serial',
      width: 210,
      render: (_, device) => device.endpoints?.usb?.adbSerial || device.serial
        ? <Typography.Text code>{device.endpoints?.usb?.adbSerial ?? device.serial}</Typography.Text>
        : '-',
    },
    { title: 'USB 状态', width: 110, render: (_, device) => connectionTag(device.endpoints?.usb?.status) },
    { title: '最后在线', dataIndex: 'lastSeenAt', width: 170, render: (value?: string) => value ? formatDate(value) : '-' },
  ]

  const discoveryColumns: TableProps<DeviceDiscoveryCandidate>['columns'] = [
    {
      title: '设备',
      width: 180,
      render: (_, item) => (
        <Space direction="vertical" size={1}>
          <Typography.Text strong>{item.name ?? item.model ?? item.serial}</Typography.Text>
          <Typography.Text type="secondary">{item.manufacturer ?? 'Android'} · {item.model ?? '-'}</Typography.Text>
        </Space>
      ),
    },
    { title: 'Android', dataIndex: 'androidVersion', width: 100, render: (value?: string) => value || '-' },
    { title: 'API', dataIndex: 'apiLevel', width: 70, render: (value?: number) => value ?? '-' },
    { title: 'ABI', dataIndex: 'architecture', width: 130, render: (value?: string) => value || '-' },
    { title: 'Serial', dataIndex: 'serial', width: 190, render: (serial: string) => <Typography.Text code>{serial}</Typography.Text> },
    { title: '授权状态', dataIndex: 'connectionStatus', width: 120, render: (status: DeviceConnectionStatus) => connectionTag(status) },
    {
      title: '操作',
      fixed: 'right',
      width: 150,
      render: (_, candidate) => {
        if (candidate.registeredDeviceId) return <Tag color="success">已录入</Tag>
        if (candidate.connectionStatus === 'unauthorized') return <Typography.Text type="warning">请在手机确认授权</Typography.Text>
        return (
          <Button
            type="primary"
            size="small"
            disabled={candidate.connectionStatus !== 'online'}
            loading={registeringSerial === candidate.serial}
            onClick={() => void registerDevice(candidate)}
          >
            录入设备
          </Button>
        )
      },
    },
  ]

  const networkEndpointColumns: TableProps<DeviceProfile>['columns'] = [
    {
      title: '物理设备',
      width: 220,
      render: (_, device) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{device.name}</Typography.Text>
          <Typography.Text type="secondary">{device.manufacturer} · {device.model ?? '-'}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '联网地址',
      width: 210,
      render: (_, device) => device.endpoints?.network
        ? <Typography.Text code>{endpointAddress(device.endpoints.network)}</Typography.Text>
        : <Typography.Text type="secondary">未配置</Typography.Text>,
    },
    { title: '状态', width: 100, render: (_, device) => connectionTag(device.endpoints?.network?.status) },
    {
      title: '最近在线',
      width: 170,
      render: (_, device) => device.endpoints?.network?.lastSeenAt ? formatDate(device.endpoints.network.lastSeenAt) : '-',
    },
    {
      title: '连接错误',
      render: (_, device) => device.endpoints?.network?.lastError
        ? <Typography.Text type="danger">{device.endpoints.network.lastError}</Typography.Text>
        : '-',
    },
    {
      title: '操作',
      fixed: 'right',
      width: 300,
      render: (_, device) => {
        const endpoint = device.endpoints?.network
        if (!endpoint) return <Typography.Text type="secondary">请在上方新增联网连接</Typography.Text>
        const busyKey = `${device.id}:${endpoint.id}`
        return (
          <Space wrap>
            <Button
              size="small"
              type={endpoint.status === 'online' ? 'default' : 'primary'}
              icon={<LinkOutlined />}
              loading={networkOperation === `${busyKey}:connect`}
              disabled={networkBatchActive}
              onClick={() => void runNetworkOperation(
                `${busyKey}:connect`,
                () => platformClient.refreshNetworkDevice(device.id, endpoint.id),
                '联网 Endpoint 已连接',
              )}
            >
              连接
            </Button>
            <Button
              size="small"
              icon={<DisconnectOutlined />}
              disabled={endpoint.status !== 'online' || networkBatchActive}
              loading={networkOperation === `${busyKey}:disconnect`}
              onClick={() => void runNetworkOperation(
                `${busyKey}:disconnect`,
                () => platformClient.disconnectNetworkDevice(device.id, endpoint.id),
                '联网 Endpoint 已断开',
              )}
            >
              断开
            </Button>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={networkOperation === `${busyKey}:refresh`}
              disabled={networkBatchActive}
              onClick={() => void runNetworkOperation(
                `${busyKey}:refresh`,
                () => platformClient.refreshNetworkDevice(device.id, endpoint.id),
                '联网 Endpoint 已刷新',
              )}
            >
              刷新
            </Button>
            <Popconfirm
              title="移除联网 Endpoint？"
              description="只移除联网地址配置，不会删除物理设备、USB 连接或历史任务。"
              okText="移除"
              cancelText="取消"
              onConfirm={() => runNetworkOperation(
                `${busyKey}:remove`,
                () => platformClient.removeNetworkDevice(device.id, endpoint.id),
                '联网 Endpoint 已移除',
              )}
            >
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                loading={networkOperation === `${busyKey}:remove`}
                disabled={networkBatchActive}
              >
                移除
              </Button>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  const networkDiscoveryColumns: TableProps<DeviceDiscoveryCandidate>['columns'] = [
    { title: 'mDNS 服务', dataIndex: 'name', render: (value: string | undefined, candidate) => value ?? candidate.serial },
    { title: '主机', dataIndex: 'host', render: (value?: string) => value ?? '-' },
    { title: '端口', dataIndex: 'port', width: 90, render: (value?: number) => value ?? '-' },
    {
      title: '绑定状态',
      width: 160,
      render: (_, candidate) => candidate.registeredDeviceId
        ? <Tag color="success">已绑定物理设备</Tag>
        : <Tag color="warning">需要人工确认</Tag>,
    },
    {
      title: '操作',
      width: 110,
      render: (_, candidate) => (
        <Button
          type="link"
          disabled={!candidate.host || !candidate.port}
          onClick={() => {
            networkForm.setFieldsValue({
              deviceId: candidate.registeredDeviceId ?? networkForm.getFieldValue('deviceId'),
              host: candidate.host ?? '',
              port: candidate.port ?? 5555,
            })
          }}
        >
          填入地址
        </Button>
      ),
    },
  ]

  const tabItems = [
    {
      key: 'overview',
      label: '设备总览',
      children: (
        <Card className="page-card" bordered={false}>
          <Table rowKey="id" loading={loading} columns={overviewColumns} dataSource={androidDevices} pagination={false} scroll={{ x: 1480 }} />
        </Card>
      ),
    },
    {
      key: 'usb',
      label: '数据线连接',
      children: (
        <Space direction="vertical" size={16} className="device-tab-content">
          <Alert
            showIcon
            type="info"
            message="保留原有 USB ADB 录入流程"
            description="扫描 adb devices -l，设备授权后录入。重复录入会更新同一物理设备和 USB Endpoint，不会创建重复设备。"
          />
          <Card className="page-card" bordered={false}>
            <Table rowKey="id" loading={loading} columns={usbColumns} dataSource={androidDevices} pagination={false} scroll={{ x: 1050 }} />
          </Card>
        </Space>
      ),
    },
    {
      key: 'network',
      label: '联网连接',
      children: (
        <Space direction="vertical" size={16} className="device-tab-content">
          <Alert
            showIcon
            type="warning"
            message="联网 ADB 第一版只连接明确地址"
            description="支持 adb connect host:port 和 ADB mDNS 服务发现；不执行 adb pair，也不会扫描任意网段。连接前必须选择目标物理设备，后端会读取设备身份并校验。"
          />
          <Card title="新增联网 Endpoint" bordered={false}>
            <Form<NetworkEndpointFormValues>
              form={networkForm}
              layout="inline"
              initialValues={{ port: 5555 }}
              onFinish={(values) => void connectNetwork(values)}
              className="network-endpoint-form"
            >
              <Form.Item name="deviceId" label="物理设备" rules={[{ required: true, message: '请选择要绑定的物理设备' }]}>
                <Select
                  showSearch
                  placeholder="选择已录入 Android 设备"
                  optionFilterProp="label"
                  options={androidDevices.map((device) => ({
                    value: device.id,
                    label: `${device.name} · ${device.manufacturer} ${device.model ?? ''}`,
                  }))}
                  style={{ minWidth: 260 }}
                />
              </Form.Item>
              <Form.Item name="host" label="IP / 主机名" rules={[{ required: true, whitespace: true, message: '请输入 IP 或主机名' }]}>
                <Input placeholder="例如 192.168.1.20" style={{ width: 210 }} />
              </Form.Item>
              <Form.Item name="port" label="端口" rules={[{ required: true, type: 'number', min: 1, max: 65535 }]}>
                <InputNumber min={1} max={65535} precision={0} style={{ width: 120 }} />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit" icon={<LinkOutlined />} loading={networkConnecting} disabled={!isRealPlatform || networkBatchActive}>
                  连接并绑定
                </Button>
              </Form.Item>
              <Form.Item>
                <Button icon={<SearchOutlined />} loading={networkDiscovering} disabled={!isRealPlatform || networkBatchActive} onClick={() => void scanNetworkDevices()}>
                  mDNS 发现
                </Button>
              </Form.Item>
            </Form>
          </Card>
          {networkCandidates.length > 0 ? (
            <Card title="mDNS 发现结果" bordered={false}>
              <Table rowKey={(candidate) => `${candidate.host}:${candidate.port}:${candidate.serial}`} columns={networkDiscoveryColumns} dataSource={networkCandidates} pagination={false} />
            </Card>
          ) : null}
          <Card
            title="已配置联网 Endpoint"
            bordered={false}
            extra={networkBatchActive ? (
              <Space>
                <Typography.Text type="secondary">
                  正在连接：{networkBatchOperation?.items.filter((item) => item.status !== 'pending' && item.status !== 'running').length} / {networkBatchOperation?.totalCount}
                  {' '}成功：{networkBatchOperation?.succeeded} 失败：{networkBatchOperation?.failed} 跳过：{networkBatchOperation?.skipped} 取消：{networkBatchOperation?.cancelled}
                </Typography.Text>
                <Button danger size="small" loading={networkBatchCancelling} onClick={() => void cancelNetworkBatch()}>停止连接</Button>
              </Space>
            ) : (
              <Button type="primary" size="small" icon={<LinkOutlined />} loading={networkBatchStarting} disabled={!isRealPlatform} onClick={() => void startNetworkBatch()}>
                一键连接全部
              </Button>
            )}
          >
            <Table rowKey="id" loading={loading} columns={networkEndpointColumns} dataSource={androidDevices} pagination={false} scroll={{ x: 1200 }} />
          </Card>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>设备管理</Typography.Title>
          <Typography.Text type="secondary">物理设备只保留一份档案，USB 与联网连接作为独立 Endpoint 管理。</Typography.Text>
        </div>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void refreshDevices()}
            loading={refreshingDevices}
            disabled={refreshingDevices || networkBatchActive}
          >
            刷新状态
          </Button>
          <Button type="primary" icon={<ApiOutlined />} onClick={() => void scanDevices()} disabled={!isRealPlatform}>扫描 USB ADB</Button>
        </Space>
      </div>

      {!isRealPlatform ? <Alert className="mode-alert" type="info" showIcon message="当前是 Mock 模式，联网 Endpoint 操作只在真实后端模式可用。" /> : null}
      {error ? <Alert className="mode-alert" type="error" showIcon message="设备列表加载失败" description={error} /> : null}

      <Tabs className="device-management-tabs" items={tabItems} defaultActiveKey="overview" />

      <Drawer
        title="USB ADB 设备扫描"
        width={980}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        extra={<Button icon={<ReloadOutlined />} loading={discovering} onClick={() => void scanDevices()}>重新扫描</Button>}
      >
        <Alert
          showIcon
          type="info"
          message="请使用数据线连接 Android 真机并开启 USB 调试"
          description="如果显示未授权，请在手机上确认 RSA 授权，然后重新扫描。联网 serial 不会出现在此 USB 录入列表中。"
          style={{ marginBottom: 16 }}
        />
        <Table rowKey="serial" loading={discovering} columns={discoveryColumns} dataSource={candidates} pagination={false} scroll={{ x: 920 }} />
      </Drawer>
    </div>
  )
}
