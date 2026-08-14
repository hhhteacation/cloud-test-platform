import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, InboxOutlined } from '@ant-design/icons'
import { Button, Card, Space, Tag, Typography, Upload } from 'antd'
import type { UploadProps } from 'antd'

import { formatBytes } from '../../utils/format'
import { MAX_TASK_VIDEOS } from '../../utils/uploadValidation'

export interface SelectedVideo {
  key: string
  file: File
  previewUrl: string
}

interface VideoSelectorProps {
  videos: readonly SelectedVideo[]
  disabled: boolean
  onSelect: NonNullable<UploadProps['beforeUpload']>
  onRemove: (index: number) => void
  onMove: (index: number, direction: -1 | 1) => void
}

export function VideoSelector({ videos, disabled, onSelect, onRemove, onMove }: VideoSelectorProps) {
  return (
    <>
      <Upload.Dragger
        accept="video/mp4,.mp4"
        multiple
        disabled={disabled || videos.length >= MAX_TASK_VIDEOS}
        showUploadList={false}
        beforeUpload={onSelect}
        className="asset-uploader"
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">点击或拖拽多个 MP4 文件到这里</p>
        <p className="ant-upload-hint">
          最多 {MAX_TASK_VIDEOS} 条；列表顺序就是同设备执行顺序和报告展示顺序
        </p>
      </Upload.Dragger>

      {videos.length > 0 && (
        <div className="video-selection-list">
          <div className="video-selection-summary">
            <Typography.Text strong>已选择 {videos.length} 条视频</Typography.Text>
            <Typography.Text type="secondary">
              合计 {formatBytes(videos.reduce((total, item) => total + item.file.size, 0))}
            </Typography.Text>
          </div>
          {videos.map((video, index) => (
            <Card size="small" className="video-selection-card" key={video.key}>
              <div className="video-sequence">{index + 1}</div>
              <video controls preload="metadata" src={video.previewUrl} />
              <div className="video-selection-meta">
                <Typography.Text strong ellipsis={{ tooltip: video.file.name }}>{video.file.name}</Typography.Text>
                <Space size={6} wrap>
                  <Typography.Text type="secondary">{formatBytes(video.file.size)}</Typography.Text>
                  <Tag color="blue">输入素材</Tag>
                </Space>
              </div>
              <Space size={4} className="video-selection-actions">
                <Button
                  type="text"
                  aria-label={`上移 ${video.file.name}`}
                  icon={<ArrowUpOutlined />}
                  disabled={disabled || index === 0}
                  onClick={() => onMove(index, -1)}
                />
                <Button
                  type="text"
                  aria-label={`下移 ${video.file.name}`}
                  icon={<ArrowDownOutlined />}
                  disabled={disabled || index === videos.length - 1}
                  onClick={() => onMove(index, 1)}
                />
                <Button
                  type="text"
                  danger
                  aria-label={`删除 ${video.file.name}`}
                  icon={<DeleteOutlined />}
                  disabled={disabled}
                  onClick={() => onRemove(index)}
                />
              </Space>
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
