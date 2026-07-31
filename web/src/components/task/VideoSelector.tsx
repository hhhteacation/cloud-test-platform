import { InboxOutlined } from '@ant-design/icons'
import { Card, Tag, Typography, Upload } from 'antd'
import type { UploadFile, UploadProps } from 'antd'

import { formatBytes } from '../../utils/format'

interface VideoSelectorProps {
  file?: File
  previewUrl?: string
  disabled: boolean
  onSelect: NonNullable<UploadProps['beforeUpload']>
  onRemove: () => void
}

export function VideoSelector({ file, previewUrl, disabled, onSelect, onRemove }: VideoSelectorProps) {
  return (
    <>
      <Upload.Dragger
        accept="video/mp4,.mp4"
        maxCount={1}
        disabled={disabled}
        fileList={file ? [toUploadFile(file)] : []}
        beforeUpload={onSelect}
        onRemove={onRemove}
        className="asset-uploader"
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">点击或拖拽 MP4 文件到这里</p>
        <p className="ant-upload-hint">该文件会由后端推送到手机 APK 的任务目录</p>
      </Upload.Dragger>

      {file && previewUrl && (
        <Card size="small" className="asset-preview">
          <video controls preload="metadata" src={previewUrl} />
          <div>
            <Typography.Text strong>{file.name}</Typography.Text>
            <Typography.Text type="secondary">{formatBytes(file.size)}</Typography.Text>
            <Tag color="blue">输入素材</Tag>
          </div>
        </Card>
      )}
    </>
  )
}

function toUploadFile(file: File): UploadFile {
  return {
    uid: `${file.name}-${file.lastModified}`,
    name: file.name,
    status: 'done',
    size: file.size,
    type: file.type,
    originFileObj: file as UploadFile['originFileObj'],
  }
}
