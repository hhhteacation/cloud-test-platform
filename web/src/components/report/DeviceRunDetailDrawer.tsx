import { DownloadOutlined, FileTextOutlined, PictureOutlined } from '@ant-design/icons'
import { Alert, Button, Descriptions, Drawer, Empty, Progress, Space, Table, Tag, Typography } from 'antd'
import type { TableProps } from 'antd'

import type { ApkExecutionProtocol, CheckResult, DeviceProfile, DeviceRunResult } from '../../types'
import { formatBytes, formatDate } from '../../utils/format'

interface DeviceRunDetailDrawerProps {
  open: boolean
  run?: DeviceRunResult
  device?: DeviceProfile
  protocolName: string
  protocol?: ApkExecutionProtocol
  onClose: () => void
}

function outputUnavailableMessage(run: DeviceRunResult) {
  if (run.status === 'queued' || run.status === 'running') return 'SDK 尚未完成，输出文件还未生成。'
  if (run.failureCode === 'OUTPUT_EMPTY') return '输出文件已生成，但文件大小为 0。'
  if (run.failureCode === 'OUTPUT_PLAYBACK_FAILED') return '输出文件存在，但视频播放验证失败。'
  if (run.failureCode === 'TASK_CANCELLED') return '任务已取消，没有可用输出视频。'
  if (run.status === 'failed' || run.status === 'blocked') return run.failureMessage ?? '设备执行失败，未收集到输出视频。'
  return '当前设备运行没有收集到 output.mp4。'
}

export function DeviceRunDetailDrawer({ open, run, device, protocolName, protocol, onClose }: DeviceRunDetailDrawerProps) {
  if (!run) return <Drawer open={open} onClose={onClose} />
  const output = run.outputs.find((item) => item.kind === 'processed_video')
  const handledDialogProfiles = [...new Set(run.logs.flatMap((log) => {
    const match = /严格白名单\s+([^\s]+)\s+自动执行/.exec(log)
    return match?.[1] ? [match[1]] : []
  }))]
  const checkColumns: TableProps<CheckResult>['columns'] = [
    { title: '检查名称', dataIndex: 'name', width: 160 },
    { title: '状态', dataIndex: 'status', width: 90, render: (status) => <Tag color={status === 'passed' ? 'success' : status === 'failed' ? 'error' : 'warning'}>{status}</Tag> },
    { title: '耗时', dataIndex: 'durationMs', width: 90, render: (value?: number) => value == null ? '-' : `${value} ms` },
    { title: '说明', dataIndex: 'message', render: (value?: string) => value || '-' },
  ]

  return (
    <Drawer title={`${device?.name ?? run.deviceId} · 执行详细`} width={760} open={open} onClose={onClose} destroyOnClose>
      <Typography.Title level={5}>设备信息</Typography.Title>
      <Descriptions bordered size="small" column={2} className="drawer-section">
        <Descriptions.Item label="品牌">{device?.manufacturer ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="名称">{device?.name ?? run.deviceId}</Descriptions.Item>
        <Descriptions.Item label="型号">{device?.model ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="系统">{device?.osVersion ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="API Level">{device?.apiLevel ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="ABI">{device?.architecture ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="Serial" span={2}><Typography.Text code copyable>{device?.serial ?? '-'}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="系统 Build" span={2}>{device?.buildVersion ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="连接状态">{device?.connectionStatus ?? 'unknown'}</Descriptions.Item>
        <Descriptions.Item label="安全补丁">{device?.securityPatch ?? '-'}</Descriptions.Item>
      </Descriptions>

      <Typography.Title level={5}>执行信息</Typography.Title>
      <Descriptions bordered size="small" column={2} className="drawer-section">
        <Descriptions.Item label="执行状态">{run.status}</Descriptions.Item>
        <Descriptions.Item label="当前阶段">{run.phase ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="总体进度"><Progress percent={run.progress} size="small" /></Descriptions.Item>
        <Descriptions.Item label="执行模式">{run.mode}</Descriptions.Item>
        <Descriptions.Item label="开始时间">{run.startedAt ? formatDate(run.startedAt) : '-'}</Descriptions.Item>
        <Descriptions.Item label="结束时间">{run.finishedAt ? formatDate(run.finishedAt) : '-'}</Descriptions.Item>
        <Descriptions.Item label="运行 ID" span={2}><Typography.Text code copyable>{run.id ?? '-'}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="本次连接">{run.connectionKind === 'network' ? '联网 ADB' : run.connectionKind === 'usb' ? 'USB ADB' : '未记录'}</Descriptions.Item>
        <Descriptions.Item label="Endpoint ID"><Typography.Text code copyable>{run.endpointId ?? '-'}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="ADB Serial" span={2}><Typography.Text code copyable>{run.adbSerial ?? '-'}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="APK 执行协议" span={2}>{protocolName}</Descriptions.Item>
        <Descriptions.Item label="安装方式">{protocol?.install.mode === 'clean' ? '干净安装' : protocol ? '覆盖安装' : '-'}</Descriptions.Item>
        <Descriptions.Item label="权限模式">{protocol?.install.runtimePermissions?.length ? 'ADB 精确授权' : '协议未声明自动授权'}</Descriptions.Item>
        <Descriptions.Item label="弹窗自动化">{protocol?.install.dialogAutomation?.mode === 'strict-whitelist' ? '严格白名单' : '未启用'}</Descriptions.Item>
        <Descriptions.Item label="自动处理弹窗数量">{handledDialogProfiles.length ? run.logs.filter((log) => log.includes('已通过严格白名单')).length : 0}</Descriptions.Item>
        <Descriptions.Item label="使用的 Profile" span={2}>{handledDialogProfiles.join('、') || '-'}</Descriptions.Item>
        <Descriptions.Item label="执行流程结论">{run.executionStatus ?? 'pending'}</Descriptions.Item>
        <Descriptions.Item label="执行失败代码">{run.executionFailureCode ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="媒体完整性">{run.mediaIntegrityStatus ?? 'not_checked'}</Descriptions.Item>
        <Descriptions.Item label="媒体失败代码">{run.mediaIntegrityFailureCode ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="失败代码">{run.failureCode ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="失败原因">{run.failureMessage ?? '-'}</Descriptions.Item>
      </Descriptions>

      <Alert
        className="drawer-section"
        type={run.mediaIntegrityStatus === 'failed' ? 'error' : 'info'}
        showIcon
        message="Phase 0 媒体基础完整性"
        description="仅判断输出文件非空、容器/视频流可探测且能够完整解码。808 帧、分辨率、音频、帧率和时长只记录，不参与通过或失败。"
      />
      {run.mediaMetadata && (
        <Descriptions bordered size="small" column={2} className="drawer-section">
          <Descriptions.Item label="容器">{run.mediaMetadata.container ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="视频编码">{run.mediaMetadata.videoCodec ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="分辨率">{run.mediaMetadata.width && run.mediaMetadata.height ? `${run.mediaMetadata.width} × ${run.mediaMetadata.height}` : '-'}</Descriptions.Item>
          <Descriptions.Item label="帧率">{run.mediaMetadata.frameRate?.toFixed(3) ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="实际帧数">{run.mediaMetadata.frameCount ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="时长">{run.mediaMetadata.durationSeconds == null ? '-' : `${run.mediaMetadata.durationSeconds.toFixed(3)} 秒`}</Descriptions.Item>
          <Descriptions.Item label="音频流">{run.mediaMetadata.hasAudio ? `有${run.mediaMetadata.audioCodec ? `（${run.mediaMetadata.audioCodec}）` : ''}` : '无'}</Descriptions.Item>
          <Descriptions.Item label="探测文件大小">{formatBytes(run.mediaMetadata.sizeBytes)}</Descriptions.Item>
        </Descriptions>
      )}

      <Typography.Title level={5}>检查项明细</Typography.Title>
      <Table rowKey="key" size="small" pagination={false} dataSource={run.checks} columns={checkColumns} locale={{ emptyText: '当前设备尚未产生检查结果' }} className="drawer-section" />

      <Typography.Title level={5}>输出视频</Typography.Title>
      {output ? (
        <div className="drawer-section device-output-panel">
          <video className="output-video" controls preload="metadata" src={output.previewUrl} />
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="文件名">{output.name}</Descriptions.Item>
            <Descriptions.Item label="文件大小">{formatBytes(output.sizeBytes)}</Descriptions.Item>
            <Descriptions.Item label="SHA-256"><Typography.Text code copyable ellipsis>{output.sha256}</Typography.Text></Descriptions.Item>
          </Descriptions>
          <Button type="primary" icon={<DownloadOutlined />} href={output.downloadUrl}>下载 output.mp4</Button>
        </div>
      ) : <Alert className="drawer-section" type={run.status === 'failed' ? 'error' : 'info'} showIcon message="输出视频不可用" description={outputUnavailableMessage(run)} />}

      <Typography.Title level={5}>日志和附件</Typography.Title>
      <div className="terminal report-terminal drawer-section">
        {run.logs.length ? run.logs.map((log, index) => <div key={`${index}-${log}`}>{log}</div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有运行日志" />}
      </div>
      <Space wrap>
        {run.logcatUrl && <Button icon={<FileTextOutlined />} href={run.logcatUrl}>下载设备 Logcat</Button>}
        {run.screenshotUrl && <Button icon={<PictureOutlined />} href={run.screenshotUrl} target="_blank">查看最终截图</Button>}
      </Space>
    </Drawer>
  )
}
