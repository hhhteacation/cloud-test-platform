import { CheckCircleFilled, PlayCircleOutlined } from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  List,
  Row,
  Segmented,
  Tag,
  Typography,
  message,
  Upload,
} from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { DeviceMatrixSelector } from '../components/task/DeviceMatrixSelector'
import { ApkSelector } from '../components/task/ApkSelector'
import { SubmitProgress } from '../components/task/SubmitProgress'
import { VideoSelector } from '../components/task/VideoSelector'
import { isRealPlatform, platformClient } from '../platform/client'
import { PlatformApiError } from '../platform/errors'
import type { Artifact, TaskConnectionMode } from '../types'
import { usePlatformDevices } from '../platform/usePlatformData'
import {
  TEST_NOTES,
  createTaskWithUploads,
  getDefaultDeviceIds,
  getSelectableDevices,
  validateCreateTaskForm,
} from '../features/tasks/createTaskModel'
import { validateUploadFile } from '../utils/uploadValidation'

export function CreateTaskPage() {
  const navigate = useNavigate()
  const { devices, loading: devicesLoading, error: devicesError } = usePlatformDevices()
  const [form] = Form.useForm<{ name: string }>()
  const [apkFile, setApkFile] = useState<File>()
  const [uploadedApk, setUploadedApk] = useState<Artifact>()
  const [videoFile, setVideoFile] = useState<File>()
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [deviceIds, setDeviceIds] = useState<string[]>([])
  const [connectionMode, setConnectionMode] = useState<TaskConnectionMode>('auto')
  const [submitting, setSubmitting] = useState(false)
  const [submitStep, setSubmitStep] = useState(-1)
  const [submitError, setSubmitError] = useState<string>()
  const [apkValidationError, setApkValidationError] = useState<string>()
  const initializedDefaultDevices = useRef(false)

  useEffect(() => {
    if (!devices.length || initializedDefaultDevices.current) return
    initializedDefaultDevices.current = true
    setDeviceIds(getDefaultDeviceIds(devices, platformClient.mode))
  }, [devices])

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const selectableDevices = getSelectableDevices(devices, platformClient.mode)

  const selectFile = (file: File, kind: 'apk' | 'video') => {
    const error = validateUploadFile(file, kind)
    if (error) {
      message.error(error)
      return Upload.LIST_IGNORE
    }

    setSubmitError(undefined)
    if (kind === 'apk') {
      setApkValidationError(undefined)
      setUploadedApk(undefined)
      setApkFile(file)
    } else {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setVideoFile(file)
      setPreviewUrl(URL.createObjectURL(file))
    }
    return false
  }

  const handleSubmit = async ({ name }: { name: string }) => {
    setSubmitError(undefined)
    setApkValidationError(undefined)

    const validationError = validateCreateTaskForm({
      apkFile,
      videoFile,
      deviceIds,
      devices,
      devicesLoading,
      devicesError,
      connectionMode,
      platformMode: platformClient.mode,
    })
    if (validationError) return showSubmitError(validationError, setSubmitError)

    // validateCreateTaskForm 已确保这两个文件存在；局部变量让 TypeScript 和维护者都能看到这个不变量。
    const selectedApk = apkFile
    const selectedVideo = videoFile
    if (!selectedApk || !selectedVideo) return

    setSubmitting(true)
    try {
      const task = await createTaskWithUploads(
        platformClient,
        { name, apkFile: selectedApk, videoFile: selectedVideo, deviceIds, connectionMode },
        { onStep: setSubmitStep, onApkUploaded: setUploadedApk },
      )
      message.success(isRealPlatform ? '真实 ADB 测试任务已创建' : 'Mock 测试任务已创建')
      navigate(`/execution/${task.id}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '创建任务失败'
      setSubmitError(errorMessage)
      if (
        error instanceof PlatformApiError &&
        (error.code === 'INVALID_TEST_APK' || error.code === 'UNSUPPORTED_APK_PROTOCOL')
      ) {
        setApkValidationError(errorMessage)
      }
      message.error({ content: errorMessage, duration: 6 })
      setSubmitStep(-1)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page">
      <PageHeading realMode={isRealPlatform} />

      {!isRealPlatform && (
        <Alert
          className="mode-alert"
          type="warning"
          showIcon
          message="当前显式启用了浏览器 Mock 演示模式"
          description="Mock 不会连接数据库或真机。请移除 VITE_PLATFORM_MODE=mock，并使用 pnpm dev 同时启动前端和 Fastify 后端。"
        />
      )}
      {devicesError && <Alert type="error" showIcon message="设备列表加载失败" description={devicesError} />}

      <Form
        form={form}
        layout="vertical"
        initialValues={{ name: 'APK + MP4 Android 多真机兼容性测试' }}
        onFinish={handleSubmit}
      >
        <Row gutter={20}>
          <Col span={15}>
            <Card title="测试配置" className="form-card">
              <Form.Item name="name" label="任务名称" rules={[{ required: true, message: '请输入任务名称' }]}>
                <Input size="large" maxLength={120} />
              </Form.Item>
              <Form.Item label="测试范围">
                <Alert
                  message="SDK 视频处理兼容性"
                  description="安装 APK、传输输入视频、执行真实 SDK、验证并回收 output.mp4 与 result.json。"
                  type="info"
                  showIcon
                />
              </Form.Item>
              {isRealPlatform && (
                <Form.Item label="Logcat 采集说明">
                  <Alert
                    message="每台设备执行前会清空该设备的全部 Logcat 缓冲区"
                    description="平台会为每个设备执行独立保存全量 Logcat，并且只停止本次执行创建的采集进程。清空不会停止 IDE 或其他工具的 Logcat 进程，但会删除同一设备上尚未保存的历史日志。"
                    type="warning"
                    showIcon
                  />
                </Form.Item>
              )}
              <Form.Item label="测试应用（APK）" required>
                <ApkSelector
                  file={apkFile}
                  artifact={uploadedApk}
                  disabled={submitting}
                  onSelect={(file) => selectFile(file, 'apk')}
                  onRemove={() => {
                    setApkFile(undefined)
                    setUploadedApk(undefined)
                    setApkValidationError(undefined)
                  }}
                />
                {apkValidationError && (
                  <Alert
                    className="field-error-alert"
                    type="error"
                    showIcon
                    message="APK 协议校验未通过"
                    description={apkValidationError}
                  />
                )}
              </Form.Item>
              <Form.Item label="输入视频（MP4）" required>
                <VideoSelector
                  file={videoFile}
                  previewUrl={previewUrl}
                  disabled={submitting}
                  onSelect={(file) => selectFile(file, 'video')}
                  onRemove={() => {
                    if (previewUrl) URL.revokeObjectURL(previewUrl)
                    setPreviewUrl(undefined)
                    setVideoFile(undefined)
                  }}
                />
              </Form.Item>
            </Card>
          </Col>
          <Col span={9}>
            <Card title="连接方式" className="form-card">
              <Segmented
                block
                value={connectionMode}
                disabled={submitting}
                onChange={(value) => setConnectionMode(value as TaskConnectionMode)}
                options={[
                  { value: 'auto', label: '自动选择' },
                  { value: 'usb', label: '仅数据线' },
                  { value: 'network', label: '仅联网' },
                ]}
              />
              <Typography.Paragraph type="secondary" className="connection-mode-help">
                {connectionMode === 'auto' ? '优先使用 USB；USB 不可用时使用联网连接。' : connectionMode === 'usb' ? '任务只使用已授权且在线的 USB 连接。' : '任务只使用已连接的联网 ADB Endpoint。'}
              </Typography.Paragraph>
            </Card>
            <DeviceMatrixSelector
              devices={selectableDevices}
              selectedIds={deviceIds}
              connectionMode={connectionMode}
              loading={devicesLoading}
              disabled={submitting}
              realMode={isRealPlatform}
              onChange={setDeviceIds}
              note="同一 APK 和 MP4 会发送到所有选中设备；不同设备可并行执行，同一设备内任务按顺序执行。"
            />
            <Card title="测试说明" className="form-card">
              <List
                size="small"
                dataSource={[...TEST_NOTES]}
                renderItem={(item) => <List.Item><CheckCircleFilled className="list-check" />{item}</List.Item>}
              />
            </Card>
          </Col>
        </Row>

        {submitting && <SubmitProgress current={submitStep} />}
        {submitError && (
          <Alert
            className="submit-error-alert"
            type="error"
            showIcon
            message="测试任务未创建"
            description={submitError}
            closable
            onClose={() => setSubmitError(undefined)}
          />
        )}

        <div className="form-actions">
          <Button disabled={submitting} onClick={() => navigate('/tasks')}>取消</Button>
          <Button type="primary" htmlType="submit" loading={submitting} icon={<PlayCircleOutlined />} size="large">
            {submitting ? '正在提交…' : '开始测试'}
          </Button>
        </div>
      </Form>
    </div>
  )
}

function PageHeading({ realMode }: { realMode: boolean }) {
  return (
    <div className="page-heading">
      <div>
        <Typography.Title level={2}>创建测试任务</Typography.Title>
        <Typography.Text type="secondary">
          上传已配置执行协议的 APK 和输入 MP4，启动多台 Android 真机的视频处理兼容性测试。
        </Typography.Text>
      </div>
      <Tag color={realMode ? 'green' : 'blue'}>{realMode ? 'ADB 真机模式' : 'MVP · Mock 模式'}</Tag>
    </div>
  )
}


function showSubmitError(errorMessage: string, setError: (message: string) => void) {
  setError(errorMessage)
  message.error({ content: errorMessage, duration: 5 })
}
