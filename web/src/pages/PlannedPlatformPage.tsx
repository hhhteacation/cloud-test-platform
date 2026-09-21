import { AppleOutlined, MobileOutlined } from '@ant-design/icons'
import { Button, Card, Result, Space, Tag, Typography } from 'antd'
import { useNavigate, useParams } from 'react-router-dom'

const PLATFORM_COPY = {
  ios: {
    name: 'iOS 兼容测试',
    description: 'iPhone 真机发现与录入已可用（设备管理 → iOS 设备）；安装、自动化执行和设备级报告在后续版本开放。',
    icon: <AppleOutlined />,
    tag: '接入中 · 设备管理页可扫描录入 iPhone',
    note: '测试执行链路（IPA 安装、WebDriverAgent 自动化、产物回收）正在开发中；当前 iOS 设备不会调用 Android ADB API。',
  },
  harmonyos: {
    name: 'HarmonyOS 兼容测试',
    description: '后续将接入 HarmonyOS 真机、HDC 执行器、应用处理协议和独立报告。',
    icon: <MobileOutlined />,
    tag: '规划中 · 当前不会调用 Android API',
    note: '平台核心模型已经保留 platform、设备提供者和执行器接缝；本阶段先把 Android 多真机链路做好。',
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
              <Tag color={platform === 'ios' ? 'success' : 'processing'}>{copy.tag}</Tag>
              <Typography.Text type="secondary">{copy.note}</Typography.Text>
              <Button type="primary" onClick={() => navigate('/devices')}>前往设备管理</Button>
            </Space>
          )}
        />
      </Card>
    </div>
  )
}
