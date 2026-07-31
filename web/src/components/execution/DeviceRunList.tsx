import { Card, Progress, Typography } from 'antd'

import { StatusTag } from '../StatusTag'
import type { DeviceProfile, TestTask } from '../../types'

interface DeviceRunListProps {
  task: TestTask
  devices: DeviceProfile[]
  selectedDeviceId?: string
  onSelectDevice: (deviceId: string) => void
}

export function DeviceRunList({
  task,
  devices,
  selectedDeviceId,
  onSelectDevice,
}: DeviceRunListProps) {
  return (
    <Card title="设备执行列表" className="device-list-card">
      {task.deviceIds.map((deviceId) => {
        const device = devices.find((candidate) => candidate.id === deviceId)
        const run = task.runs[deviceId]
        if (!device || !run) return null

        return (
          <button
            type="button"
            className={`device-run-item ${selectedDeviceId === deviceId ? 'selected' : ''}`}
            key={deviceId}
            onClick={() => onSelectDevice(deviceId)}
          >
            <div className="device-run-icon">{device.manufacturer.slice(0, 1)}</div>
            <div className="device-run-info">
              <Typography.Text strong>{device.name}</Typography.Text>
              <Typography.Text type="secondary">{device.osVersion}</Typography.Text>
              <Progress
                percent={run.progress}
                size="small"
                showInfo={false}
                status={run.status === 'failed' ? 'exception' : undefined}
              />
            </div>
            <StatusTag status={run.status} />
          </button>
        )
      })}
    </Card>
  )
}
