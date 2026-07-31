import { Alert, Card, Checkbox, Divider, Space, Tag, Tooltip, Typography } from 'antd'
import type { ReactNode } from 'react'

import type { DeviceProfile } from '../../types'

interface SelectableDevice extends DeviceProfile {
  selectable: boolean
}

interface DeviceMatrixSelectorProps {
  devices: SelectableDevice[]
  selectedIds: string[]
  loading: boolean
  disabled: boolean
  realMode: boolean
  onChange: (ids: string[]) => void
  note?: ReactNode
}

const connectionLabels = {
  online: '已连接',
  offline: '离线',
  unauthorized: '未授权',
  unknown: '未知',
} as const

function disabledReason(device: SelectableDevice, realMode: boolean) {
  if (!realMode || device.selectable) return undefined
  if (device.connectionStatus === 'unauthorized') return '请在手机上确认 USB 调试授权后重新扫描'
  if (device.connectionStatus !== 'online') return '设备当前离线，不能创建新的真机任务'
  if (device.executionMode !== 'adb') return '该档案不是 Android ADB 真机'
  return '该设备当前不可调度'
}

export function DeviceMatrixSelector({ devices, selectedIds, loading, disabled, realMode, onChange, note }: DeviceMatrixSelectorProps) {
  return (
    <Card title="选择 Android 设备" extra={<Typography.Text type="secondary">{selectedIds.length} 台已选</Typography.Text>} loading={loading} className="form-card">
      <Checkbox.Group value={selectedIds} onChange={(values) => onChange(values as string[])} disabled={disabled} style={{ width: '100%' }}>
        {devices.map((device) => {
          const reason = disabledReason(device, realMode)
          return (
            <Tooltip key={device.id} title={reason} placement="left">
              <div className={`device-option ${!device.selectable ? 'disabled' : ''}`}>
                <Checkbox value={device.id} disabled={!device.selectable}>
                  <div>
                    <Typography.Text strong>{device.name}</Typography.Text>
                    <Typography.Text type="secondary" className="cell-sub">{device.model ? `${device.model} · ` : ''}{device.osVersion} · API {device.apiLevel}</Typography.Text>
                  </div>
                </Checkbox>
                <Space size={4}>
                  {device.executionMode === 'adb' ? <Tag color="green">ADB 真机</Tag> : <Tag>模拟</Tag>}
                  {device.connectionStatus && device.executionMode === 'adb' && (
                    <Tag color={device.connectionStatus === 'online' ? 'success' : device.connectionStatus === 'unauthorized' ? 'error' : 'default'}>
                      {connectionLabels[device.connectionStatus]}
                    </Tag>
                  )}
                </Space>
              </div>
            </Tooltip>
          )
        })}
      </Checkbox.Group>

      {!loading && !devices.some((device) => device.selectable) && (
        <Alert className="device-connection-alert" type="warning" showIcon message="没有可选择的在线 Android 真机" description="请先到设备管理页面扫描并录入已授权的 ADB 设备。" />
      )}
      <Divider />
      <Typography.Text type="secondary">{note ?? '同一 APK 和 MP4 会发送到所有选中设备；各设备独立生成结果、日志和 output.mp4。'}</Typography.Text>
    </Card>
  )
}
