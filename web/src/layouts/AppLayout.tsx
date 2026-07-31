import {
  AndroidOutlined,
  AppstoreOutlined,
  AppleOutlined,
  BarChartOutlined,
  CheckCircleFilled,
  CloudServerOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MobileOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import { Avatar, Breadcrumb, Button, Dropdown, Layout, Menu, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'

const { Header, Sider, Content } = Layout

type NavigationKey = 'overview' | 'tasks' | 'devices'

const taskRoutes = ['/tasks', '/create', '/execution', '/reports']

function getSelectedNavigation(pathname: string): NavigationKey {
  if (taskRoutes.some((route) => pathname.startsWith(route))) return 'tasks'
  if (pathname.startsWith('/devices')) return 'devices'
  return 'overview'
}

function getBreadcrumbTitle(selectedNavigation: NavigationKey, pathname: string) {
  if (pathname.startsWith('/platform/ios')) return 'iOS 兼容测试'
  if (pathname.startsWith('/platform/harmonyos')) return 'HarmonyOS 兼容测试'
  if (selectedNavigation === 'devices') return '设备管理'
  if (selectedNavigation === 'tasks') return '测试任务'
  return '概览'
}

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const selectedNavigation = getSelectedNavigation(location.pathname)

  return (
    <Layout className="app-shell">
      <Sider width={236} collapsedWidth={80} collapsed={collapsed} theme="light" className="app-sider">
        <Brand collapsed={collapsed} />
        <PlatformSwitcher collapsed={collapsed} pathname={location.pathname} onNavigate={navigate} />
        <SideNavigation selectedNavigation={selectedNavigation} onNavigate={navigate} />
        <SiderFooter collapsed={collapsed} onNavigate={navigate} />
      </Sider>

      <Layout>
        <Header className="top-header">
          <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed((current) => !current)} />
          <TopNavigation />
          <UserArea />
        </Header>

        <Content className="main-content">
          <Breadcrumb items={[{ title: 'SDK 兼容测试平台' }, { title: getBreadcrumbTitle(selectedNavigation, location.pathname) }]} />
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return <div className="brand"><div className="brand-mark">✓</div>{!collapsed && <span>SDK CloudTest</span>}</div>
}

function PlatformSwitcher({ collapsed, pathname, onNavigate }: { collapsed: boolean; pathname: string; onNavigate: (path: string) => void }) {
  if (collapsed) return null
  const current = pathname.startsWith('/platform/ios')
    ? 'iOS 兼容测试'
    : pathname.startsWith('/platform/harmonyos')
      ? 'HarmonyOS 兼容测试'
      : 'Android 兼容测试'

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: [
          { key: 'android', icon: <AndroidOutlined />, label: <Space>Android 兼容测试<Tag color="success">可用</Tag></Space>, onClick: () => onNavigate('/tasks') },
          { key: 'ios', icon: <AppleOutlined />, label: <Space>iOS 兼容测试<Tag>规划中</Tag></Space>, onClick: () => onNavigate('/platform/ios') },
          { key: 'harmonyos', icon: <MobileOutlined />, label: <Space>HarmonyOS 兼容测试<Tag>规划中</Tag></Space>, onClick: () => onNavigate('/platform/harmonyos') },
        ],
      }}
    >
      <button type="button" className="project-switcher">
        <FolderOpenOutlined />
        <span>{current}</span>
        <span className="chevron">⌄</span>
      </button>
    </Dropdown>
  )
}

function SideNavigation({ selectedNavigation, onNavigate }: { selectedNavigation: NavigationKey; onNavigate: (path: string) => void }) {
  const menuItems = [
    { key: 'overview', icon: <BarChartOutlined />, label: '概览', onClick: () => onNavigate('/') },
    { key: 'tasks', icon: <UnorderedListOutlined />, label: '测试任务', onClick: () => onNavigate('/tasks') },
    { key: 'devices', icon: <CloudServerOutlined />, label: '设备管理', onClick: () => onNavigate('/devices') },
    { key: 'reports', icon: <FileSearchOutlined />, label: '测试报告', onClick: () => onNavigate('/tasks') },
    { key: 'settings', icon: <SettingOutlined />, label: '项目设置', onClick: () => onNavigate('/settings') },
  ]
  return <Menu mode="inline" selectedKeys={[selectedNavigation]} items={menuItems} />
}

function SiderFooter({ collapsed, onNavigate }: { collapsed: boolean; onNavigate: (path: string) => void }) {
  return (
    <div className="sider-bottom">
      {!collapsed && <div className="help-card"><strong>需要帮助？</strong><span>查看兼容性测试指南</span></div>}
      <Button type="primary" block={!collapsed} icon={<AppstoreOutlined />} onClick={() => onNavigate('/tasks')}>{!collapsed && '全部功能'}</Button>
    </div>
  )
}

function TopNavigation() {
  return <div className="top-nav"><span>APP 与 SDK</span><span className="active">开发与服务</span><span>数据分析</span><span>帮助中心</span></div>
}

function UserArea() {
  return <Space className="user-area"><span className="top-status"><CheckCircleFilled /> 服务正常</span><Avatar size="small">韩</Avatar><Typography.Text>韩震</Typography.Text><span>⌄</span></Space>
}
