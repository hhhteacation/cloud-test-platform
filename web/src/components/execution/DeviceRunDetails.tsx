import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  LoadingOutlined,
} from '@ant-design/icons'
import { Alert, Card, Divider, Space, Tag, Typography } from 'antd'
import { useMemo } from 'react'

import type { CheckResult, DeviceProfile, DeviceRunResult } from '../../types'
import { CHECKS } from '../../features/tasks/taskDefinitions'

export function DeviceRunDetails({
  device,
  run,
  protocolLabel,
}: {
  device?: DeviceProfile
  run?: DeviceRunResult
  protocolLabel: string
}) {
  return (
    <Card
      title={(
        <Space>
          <span>{device?.name ?? '设备详情'}</span>
          {run && <Tag color="green">{run.mode}</Tag>}
          <Tag>{protocolLabel}</Tag>
        </Space>
      )}
      className="log-card"
    >
      {device && (
        <Space wrap className="device-meta">
          <Tag>{device.osVersion}</Tag>
          <Tag>API {device.apiLevel}</Tag>
          <Tag>{device.architecture}</Tag>
          {device.serial && <Typography.Text code>{device.serial}</Typography.Text>}
        </Space>
      )}

      {run && (
        <>
          <Alert
            className="failure-alert"
            type="info"
            showIcon
            message={`本次连接：${run.connectionKind === 'network' ? '联网 ADB' : run.connectionKind === 'usb' ? 'USB ADB' : '等待解析'}`}
            description={run.adbSerial ? `ADB Serial：${run.adbSerial}${run.endpointId ? `；Endpoint：${run.endpointId}` : ''}` : '任务进入该物理设备队列后，会在执行前固化实际连接。'}
          />
          <Alert
            className="failure-alert"
            type={run.mediaIntegrityStatus === 'failed' ? 'error' : 'info'}
            showIcon
            message={`执行流程：${run.executionStatus ?? 'pending'}；媒体完整性：${run.mediaIntegrityStatus ?? 'not_checked'}`}
            description="Phase 0 仅校验文件可探测且可完整解码；808 帧、分辨率、音频、帧率和时长暂不作为通过条件。"
          />
        </>
      )}

      {run?.failureCode && (
        <Alert
          className="failure-alert"
          type="error"
          showIcon
          message={`失败代码：${run.failureCode}`}
          description={run.failureMessage || '执行失败，请查看实时日志。'}
        />
      )}

      <CheckGrid run={run} />
      <Divider />
      <Typography.Text strong>实时日志</Typography.Text>
      <LogTerminal run={run} />
    </Card>
  )
}

function CheckGrid({ run }: { run?: DeviceRunResult }) {
  const checksByKey = useMemo(
    () => new Map(run?.checks.map((check) => [check.key, check])),
    [run?.checks],
  )
  const checks = run?.checks.length
    ? run.checks
    : CHECKS.map((item) => ({
        ...item,
        status: 'blocked' as const,
        message: '等待执行',
      }))

  return (
    <div className="check-grid">
      {checks.map((check) => (
        <CheckItem
          key={check.key}
          check={checksByKey.get(check.key) ?? check}
          pending={!checksByKey.has(check.key)}
        />
      ))}
    </div>
  )
}

function CheckItem({ check, pending }: { check: CheckResult; pending: boolean }) {
  return (
    <div className={`check-item ${check.status === 'failed' ? 'failed' : ''}`}>
      <CheckIcon check={check} pending={pending} />
      <span>{check.name}</span>
      <Typography.Text type="secondary">
        {pending ? '等待' : check.durationMs ? `${check.durationMs} ms` : check.message || check.status}
      </Typography.Text>
    </div>
  )
}

function CheckIcon({ check, pending }: { check: CheckResult; pending: boolean }) {
  if (pending || check.status === 'blocked') return <ClockCircleOutlined />
  if (check.status === 'passed') return <CheckCircleFilled className="check-ok" />
  return <CloseCircleFilled className="check-failed" />
}

function LogTerminal({ run }: { run?: DeviceRunResult }) {
  return (
    <div className="terminal">
      {!run?.logs.length && <div>等待执行器日志…</div>}
      {run?.logs.map((log, index) => <div key={`${log}-${index}`}>{log}</div>)}
      {run?.status === 'running' && (
        <div className="terminal-live"><LoadingOutlined /> ADB Worker 正在运行…</div>
      )}
    </div>
  )
}
