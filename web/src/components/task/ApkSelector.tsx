import { DeleteOutlined, FileZipOutlined, UploadOutlined } from '@ant-design/icons'
import { Alert, Button, Space, Typography, Upload } from 'antd'
import type { UploadProps } from 'antd'

import type { Artifact } from '../../types'
import { formatBytes } from '../../utils/format'

interface ApkSelectorProps {
  file?: File
  artifact?: Artifact
  disabled: boolean
  onSelect: NonNullable<UploadProps['beforeUpload']>
  onRemove: () => void
}

export function ApkSelector({ file, artifact, disabled, onSelect, onRemove }: ApkSelectorProps) {
  return (
    <div className="apk-selector">
      <div className="apk-selector-action">
        <Upload
          accept=".apk,application/vnd.android.package-archive"
          maxCount={1}
          showUploadList={false}
          disabled={disabled}
          beforeUpload={onSelect}
        >
          <Button icon={<UploadOutlined />} disabled={disabled}>选择 APK 文件</Button>
        </Upload>
        <Typography.Text type="secondary">
          支持的平台载体 APK 和 Morpho VideoPostProcessor Demo APK
        </Typography.Text>
      </div>

      {file && (
        <div className="apk-file-card">
          <span className="apk-file-icon"><FileZipOutlined /></span>
          <div className="apk-file-info">
            <Typography.Text strong ellipsis>{file.name}</Typography.Text>
            <Typography.Text type="secondary">
              {formatBytes(file.size)} · {artifact?.protocol ? '协议已识别' : '等待上传和 AAPT 协议识别'}
            </Typography.Text>
          </div>
          <Button type="text" danger icon={<DeleteOutlined />} disabled={disabled} onClick={onRemove} />
        </div>
      )}

      {artifact?.protocol && (
        <Alert
          className="apk-protocol-alert"
          type="success"
          showIcon
          message={`${artifact.protocol.name} · ${artifact.packageName}`}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text>{artifact.protocol.launch.description}</Typography.Text>
              <Typography.Text>{artifact.protocol.output.description}</Typography.Text>
              <Typography.Text type="secondary">
                task_id：{artifact.protocol.launch.supportsTaskId ? '支持' : '不支持'}；
                auto_run：{artifact.protocol.launch.supportsAutoRun ? '支持' : '不支持'}；
                result.json：{artifact.protocol.result.apkGeneratesResultJson ? 'APK 生成' : '后端合成'}；
                UI 点击：{artifact.protocol.launch.requiresUiInteraction ? '需要' : '不需要'}
              </Typography.Text>
            </Space>
          }
        />
      )}
    </div>
  )
}
