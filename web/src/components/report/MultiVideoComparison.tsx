import { Alert, Button, Card, Collapse, Descriptions, Empty, Progress, Segmented, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'

import type { DeviceProfile, TestReport, VideoRunResult } from '../../types'
import { formatBytes } from '../../utils/format'

const statusMeta = {
  queued: { label: '排队中', color: 'default' },
  running: { label: '执行中', color: 'processing' },
  passed: { label: '通过', color: 'success' },
  failed: { label: '失败', color: 'error' },
  blocked: { label: '已阻断', color: 'warning' },
} as const

export function MultiVideoComparison({ report, devices }: { report: TestReport; devices: DeviceProfile[] }) {
  const videos = useMemo(() => report.videos?.slice().sort((a, b) => a.sequence - b.sequence) ?? [], [report.videos])
  const [videoId, setVideoId] = useState(videos[0]?.id)
  const [deviceId, setDeviceId] = useState(report.deviceIds[0])

  useEffect(() => {
    if (!videoId && videos[0]) setVideoId(videos[0].id)
  }, [videoId, videos])

  const selectedVideo = videos.find((video) => video.id === videoId) ?? videos[0]
  const byDevice = selectedVideo ? report.videoRuns?.[selectedVideo.id] ?? {} : {}
  const availableDeviceIds = report.deviceIds.filter((id) => byDevice[id] || report.runs[id])

  useEffect(() => {
    if (availableDeviceIds.length && !availableDeviceIds.includes(deviceId)) setDeviceId(availableDeviceIds[0])
  }, [availableDeviceIds, deviceId])

  if (!selectedVideo) return null

  const result = byDevice[deviceId]
  const output = result?.primaryOutput ?? result?.outputs.find((item) => item.kind === 'processed_video')
  const deviceById = new Map(devices.map((device) => [device.id, device]))
  const status = result ? statusMeta[result.status] : undefined

  return (
    <Card title="多视频结果对比" className="table-card multi-video-report-card">
      <div className="multi-video-report-layout">
        <aside className="report-video-nav" aria-label="测试视频列表">
          <div className="report-video-nav-heading">
            <Typography.Text strong>测试视频</Typography.Text>
            <Tag>{videos.length} 条</Tag>
          </div>
          <div className="report-video-nav-list">
            {videos.map((video) => {
              const videoResult = report.videoRuns?.[video.id]?.[deviceId]
              const meta = videoResult ? statusMeta[videoResult.status] : undefined
              return (
                <Button
                  key={video.id}
                  type={video.id === selectedVideo.id ? 'primary' : 'text'}
                  className="report-video-nav-item"
                  onClick={() => setVideoId(video.id)}
                >
                  <span className="report-video-index">{video.sequence + 1}</span>
                  <span className="report-video-name">{video.displayName}</span>
                  {meta && <Tag color={meta.color}>{meta.label}</Tag>}
                </Button>
              )
            })}
          </div>
        </aside>

        <section className="report-video-detail">
          <div className="report-device-switcher">
            <div>
              <Typography.Text strong>{selectedVideo.displayName}</Typography.Text>
              <Typography.Text type="secondary">　选择设备查看对应输出</Typography.Text>
            </div>
            {availableDeviceIds.length > 0 && (
              <Segmented
                value={deviceId}
                onChange={(value) => setDeviceId(String(value))}
                options={availableDeviceIds.map((id) => ({
                  value: id,
                  label: deviceById.get(id)?.name ?? id,
                }))}
              />
            )}
          </div>

          <div className="video-comparison-grid">
            <VideoPanel title="原视频" side="left" src={selectedVideo.asset.previewUrl} />
            <VideoPanel
              title="输出视频"
              side="right"
              src={output?.previewUrl}
              empty={result ? outputUnavailableMessage(result) : '当前设备尚无这条视频的执行结果'}
            />
          </div>

          <div className="video-result-summary">
            <Space wrap>
              {status && <Tag color={status.color}>{status.label}</Tag>}
              <Typography.Text type="secondary">进度 {result?.progress ?? 0}%</Typography.Text>
              {result?.attempts?.length ? <Tag>执行 {result.attempts.length} 次</Tag> : null}
              {output && <Tag>{formatBytes(output.sizeBytes)}</Tag>}
            </Space>
            <Progress percent={result?.progress ?? 0} size="small" status={result?.status === 'failed' ? 'exception' : undefined} />
          </div>

          {result?.failureMessage && (
            <Alert type="error" showIcon message={result.failureCode ?? '视频执行失败'} description={result.failureMessage} />
          )}
          {result && (
            <Descriptions bordered size="small" column={2} className="video-result-details">
              <Descriptions.Item label="设备">{deviceById.get(deviceId)?.name ?? deviceId}</Descriptions.Item>
              <Descriptions.Item label="媒体完整性">{result.mediaIntegrityStatus}</Descriptions.Item>
              <Descriptions.Item label="检查项">{result.checks.length} 项</Descriptions.Item>
              <Descriptions.Item label="日志">{result.logs.length} 条</Descriptions.Item>
            </Descriptions>
          )}
          {result && (
            <Collapse
              items={[
                {
                  key: 'checks',
                  label: `检查项（${result.checks.length}）`,
                  children: (
                    <Table
                      rowKey="key"
                      size="small"
                      pagination={false}
                      dataSource={result.checks}
                      locale={{ emptyText: '当前视频没有检查结果' }}
                      columns={[
                        { title: '检查项', dataIndex: 'name', key: 'name' },
                        { title: '状态', dataIndex: 'status', key: 'status', render: (value: string) => <Tag>{value}</Tag> },
                        { title: '说明', dataIndex: 'message', key: 'message', render: (value?: string) => value ?? '-' },
                      ]}
                    />
                  ),
                },
                {
                  key: 'logs',
                  label: `运行日志（${result.logs.length}）`,
                  children: result.logs.length
                    ? <div className="terminal report-terminal">{result.logs.map((log, index) => <div key={`${index}-${log}`}>{log}</div>)}</div>
                    : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前视频没有运行日志" />,
                },
                {
                  key: 'attempts',
                  label: `执行尝试（${result.attempts.length}）`,
                  children: result.attempts.length
                    ? <Space direction="vertical">{result.attempts.map((attempt) => <Tag key={attempt.id}>第 {attempt.attemptNumber} 次：{attempt.status}{attempt.failureCode ? ` · ${attempt.failureCode}` : ''}</Tag>)}</Space>
                    : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未开始执行" />,
                },
              ]}
            />
          )}
        </section>
      </div>
    </Card>
  )
}

function VideoPanel({ title, side, src, empty }: { title: string; side: 'left' | 'right'; src?: string; empty?: string }) {
  return (
    <div className={`video-comparison-panel ${side}`}>
      <div className="video-comparison-title">
        <Typography.Text strong>{title}</Typography.Text>
        <Tag>{side === 'left' ? '输入' : '处理结果'}</Tag>
      </div>
      {src
        ? <video controls preload="metadata" src={src} />
        : <div className="video-comparison-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty ?? '视频不可用'} /></div>}
    </div>
  )
}

function outputUnavailableMessage(result: VideoRunResult) {
  if (result.status === 'blocked') return result.failureMessage ?? '设备基础设施失败，当前视频未执行'
  if (result.status === 'failed') return result.failureMessage ?? '当前视频执行失败，没有可用输出'
  if (result.status === 'queued') return '当前视频仍在排队'
  if (result.status === 'running') return '当前视频正在处理'
  return '未找到正式输出视频'
}
