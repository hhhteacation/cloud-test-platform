import { AppleOutlined, MobileOutlined } from '@ant-design/icons'
import { Button, Card, Result, Space, Tag, Typography } from 'antd'
import { useNavigate, useParams } from 'react-router-dom'

const PLATFORM_COPY = {
  ios: {
    name: 'iOS 兼容测试',
    description: '后续将接入 iPhone/iPad 设备发现、安装、XCTest/自动化执行和设备级报告。',
    icon: <AppleOutlined />,
  },
  harmonyos: {
    name: 'HarmonyOS 兼容测试',
    description: '后续将接入 HarmonyOS 真机、HDC 执行器、应用处理协议和独立报告。',
    icon: <MobileOutlined />,
  },
} as const

export function PlannedPlatformPage() {
  const navigate = useNavigate()
  const { platform } = useParams<{ platform: keyof typeof PLATFORM_COPY }>()
  const copy = platform ? PLATFORM_COPY[platform] : undefined

  if (!copy) return null

  return (
    <div className="page planned-platform-page">
      <Card>
        <Result
          icon={copy.icon}
          title={copy.name}
          subTitle={copy.description}
          extra={(
            <Space direction="vertical" size={16}>
              <Tag color="processing">规划中 · 当前不会调用 Android API</Tag>
              <Typography.Text type="secondary">
                平台核心模型已经保留 platform、设备提供者和执行器接缝；本阶段先把 Android 多真机链路做好。
              </Typography.Text>
              <Button type="primary" onClick={() => navigate('/tasks')}>返回 Android 兼容测试</Button>
            </Space>
          )}
        />
      </Card>
    </div>
  )
}
