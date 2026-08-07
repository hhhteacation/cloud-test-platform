import { Alert, Card, Checkbox, Divider, Input, Select, Space, Tag, Tooltip, Typography } from 'antd'
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'

import { isDeviceAvailableForMode } from '../../features/tasks/createTaskModel'
import type { DeviceConnectionStatus, DeviceProfile, TaskConnectionMode } from '../../types'

interface SelectableDevice extends DeviceProfile {
  selectable: boolean
}

interface DeviceMatrixSelectorProps {
  devices: SelectableDevice[]
  selectedIds: string[]
  connectionMode: TaskConnectionMode
  loading: boolean
  disabled: boolean
  realMode: boolean
  onChange: (ids: string[]) => void
  note?: ReactNode
}

const statusLabels: Record<DeviceConnectionStatus, string> = {
  online: '在线', offline: '离线', unauthorized: '未授权', unknown: '未知',
}

function endpointStatus(device: SelectableDevice, kind: 'usb' | 'network'): DeviceConnectionStatus {
  if (!device.endpoints) return device.connectionStatus ?? 'unknown'
  return device.endpoints[kind]?.status ?? 'unknown'
}

function canUse(device: SelectableDevice, mode: TaskConnectionMode, realMode: boolean) {
  return isDeviceAvailableForMode(device, mode, realMode ? 'real' : 'mock')
}

function disabledReason(device: SelectableDevice, mode: TaskConnectionMode, realMode: boolean) {
  if (canUse(device, mode, realMode)) return undefined
  if (realMode && device.executionMode !== 'adb') return '该设备不是 Android ADB 真机'
  if (!device.eligible) return device.unavailableReason ?? '该设备当前不可调度'
  const usb = endpointStatus(device, 'usb')
  const network = endpointStatus(device, 'network')
  if (mode === 'usb') return usb === 'unauthorized' ? 'USB 调试未授权' : 'USB 当前不可用'
  if (mode === 'network') return network === 'unknown' ? '联网 Endpoint 未配置' : '联网当前不可用'
  return 'USB 和联网连接均不可用'
}

function connectionTag(device: SelectableDevice, kind: 'usb' | 'network', label: string) {
  const endpoint = device.endpoints?.[kind]
  const status = endpointStatus(device, kind)
  const color = status === 'online' ? 'success' : status === 'unauthorized' ? 'error' : 'default'
  const statusLabel = !endpoint && device.endpoints ? '未配置' : statusLabels[status]
  return <Tag color={color}>{label} · {statusLabel}</Tag>
}

export function DeviceMatrixSelector({ devices, selectedIds, connectionMode, loading, disabled, realMode, onChange, note }: DeviceMatrixSelectorProps) {
  const [brand, setBrand] = useState<string>()
  const [osVersion, setOsVersion] = useState<string>()
  const [apiLevel, setApiLevel] = useState<string>()
  const [connectionFilter, setConnectionFilter] = useState<'all' | 'usb' | 'network' | 'both'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'available' | DeviceConnectionStatus>('all')
  const [search, setSearch] = useState('')

  const options = useMemo(() => ({
    brands: [...new Set(devices.map((device) => device.manufacturer).filter(Boolean))].sort(),
    osVersions: [...new Set(devices.map((device) => device.osVersion).filter(Boolean))].sort(),
    apiLevels: [...new Set(devices.map((device) => String(device.apiLevel)).filter((value) => value !== '0'))].sort((a, b) => Number(b) - Number(a)),
  }), [devices])

  const visibleDevices = useMemo(() => devices.filter((device) => {
    const usbOnline = endpointStatus(device, 'usb') === 'online'
    const networkOnline = endpointStatus(device, 'network') === 'online'
    const available = canUse(device, connectionMode, realMode)
    const status = device.connectionStatus ?? 'unknown'
    const matchesConnection = connectionFilter === 'all'
      || connectionFilter === 'usb' && usbOnline
      || connectionFilter === 'network' && networkOnline
      || connectionFilter === 'both' && usbOnline && networkOnline
    const matchesStatus = statusFilter === 'all'
      || statusFilter === 'available' && available
      || statusFilter === status
    const text = `${device.name} ${device.model ?? ''} ${device.manufacturer}`.toLowerCase()
    return matchesConnection && matchesStatus
      && (!brand || device.manufacturer === brand)
      && (!osVersion || device.osVersion === osVersion)
      && (!apiLevel || String(device.apiLevel) === apiLevel)
      && (!search.trim() || text.includes(search.trim().toLowerCase()))
  }), [apiLevel, brand, connectionFilter, connectionMode, devices, osVersion, realMode, search, statusFilter])

  const updateSelection = (values: string[]) => onChange(values)
  const availableCount = devices.filter((device) => canUse(device, connectionMode, realMode)).length
  const selectedConflicts = devices.filter((device) => selectedIds.includes(device.id) && !canUse(device, connectionMode, realMode))

  return (
    <Card
      title="选择 Android 真机"
      extra={<Typography.Text type="secondary">{selectedIds.length} 台已选</Typography.Text>}
      loading={loading}
      className="form-card device-matrix-card"
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Input.Search allowClear placeholder="搜索设备名称、型号或品牌" value={search} onChange={(event) => setSearch(event.target.value)} />
        <Space wrap>
          <Select allowClear placeholder="品牌" value={brand} onChange={setBrand} options={options.brands.map((value) => ({ value, label: value }))} style={{ minWidth: 130 }} />
          <Select allowClear placeholder="系统版本" value={osVersion} onChange={setOsVersion} options={options.osVersions.map((value) => ({ value, label: value }))} style={{ minWidth: 150 }} />
          <Select allowClear placeholder="API Level" value={apiLevel} onChange={setApiLevel} options={options.apiLevels.map((value) => ({ value, label: `API ${value}` }))} style={{ minWidth: 120 }} />
          <Select value={connectionFilter} onChange={setConnectionFilter} options={[{ value: 'all', label: '全部连接方式' }, { value: 'usb', label: 'USB 在线' }, { value: 'network', label: '联网在线' }, { value: 'both', label: 'USB、联网均在线' }]} style={{ minWidth: 155 }} />
          <Select value={statusFilter} onChange={setStatusFilter} options={[{ value: 'all', label: '全部状态' }, { value: 'available', label: '当前可用' }, ...(['online', 'offline', 'unauthorized', 'unknown'] as const).map((value) => ({ value, label: statusLabels[value] }))]} style={{ minWidth: 130 }} />
        </Space>
      </Space>

      <Divider />
      <Checkbox.Group value={selectedIds} onChange={(values) => updateSelection(values as string[])} disabled={disabled} style={{ width: '100%' }}>
        <div className="device-card-grid">
          {visibleDevices.map((device) => {
            const selectable = canUse(device, connectionMode, realMode)
            const reason = disabledReason(device, connectionMode, realMode)
            const queueLabel = device.queueStatus === 'running' ? '执行中' : device.queueStatus === 'queued' ? '排队中' : '空闲'
            return (
              <Tooltip key={device.id} title={reason} placement="top">
                <Checkbox
                  value={device.id}
                  disabled={!selectable}
                  className={`device-option device-option-card ${selectedIds.includes(device.id) ? 'selected' : ''} ${!selectable ? 'disabled unavailable' : ''} ${device.queueStatus && device.queueStatus !== 'idle' ? 'busy' : ''}`}
                >
                  <div className="device-card-body">
                    <div className="device-card-header">
                      <Typography.Text strong ellipsis>{device.name}</Typography.Text>
                      <Tag color={selectable ? 'success' : 'default'}>{selectable ? '可用' : '不可用'}</Tag>
                    </div>
                    <Typography.Text type="secondary">{device.manufacturer} · {device.model ?? '-'} · {device.osVersion} · API {device.apiLevel || '-'}</Typography.Text>
                    <Space wrap size={[4, 4]} className="device-card-tags">
                      {connectionTag(device, 'usb', 'USB')}
                      {connectionTag(device, 'network', '联网')}
                      <Tag>{queueLabel}</Tag>
                    </Space>
                    {!selectable && reason && <Typography.Text type="secondary" className="device-card-reason">{reason}</Typography.Text>}
                  </div>
                </Checkbox>
              </Tooltip>
            )
          })}
        </div>
      </Checkbox.Group>

      {selectedConflicts.length > 0 && (
        <Alert
          className="device-connection-alert"
          type="error"
          showIcon
          message={`${selectedConflicts.length} 台已选设备与当前连接模式冲突`}
          description={`${selectedConflicts.map((device) => device.name).join('、')} 将保留选中状态，但必须恢复对应连接或取消选择后才能提交。`}
        />
      )}
      {!loading && !visibleDevices.length && <Alert type="info" showIcon message="没有符合筛选条件的设备" />}
      {!loading && !availableCount && <Alert className="device-connection-alert" type="warning" showIcon message="没有可选择的 Android 真机" description="请到设备管理页面录入 USB 设备或连接联网 ADB Endpoint。" />}
      <Divider />
      <Typography.Text type="secondary">{note ?? '同一 APK 和 MP4 会发送到所有选中设备；同一物理设备的任务会按队列顺序执行。'}</Typography.Text>
    </Card>
  )
}
