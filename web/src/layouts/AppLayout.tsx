import {
  AndroidOutlined,
  AppstoreOutlined,
  AppleOutlined,
  BarChartOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CloudServerOutlined,
  ExclamationCircleFilled,
  FileSearchOutlined,
  FolderOpenOutlined,
  LoadingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MobileOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import { Avatar, Breadcrumb, Button, Drawer, Dropdown, Grid, Layout, Menu, Space, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'

import { platformRuntime } from '../platform/client'
import { createServiceHealthMonitor, SERVICE_HEALTH_LABELS, type ServiceHealth } from './serviceHealth'

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
  return '运行概览'
}

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const screens = Grid.useBreakpoint()
  const location = useLocation()
  const navigate = useNavigate()
  const selectedNavigation = getSelectedNavigation(location.pathname)
  const pageTitle = getBreadcrumbTitle(selectedNavigation, location.pathname)
  const isMobile = screens.lg === false
  const effectiveCollapsed = !isMobile && (collapsed || screens.xl === false)

  useEffect(() => {
    setMobileNavigationOpen(false)
  }, [location.pathname])

  const navigateFromMobile = (path: string) => {
    setMobileNavigationOpen(false)
    navigate(path)
  }

  return (
    <Layout className="app-shell">
      {!isMobile && (
        <Sider width={236} collapsedWidth={80} collapsed={effectiveCollapsed} theme="light" className="app-sider">
          <Brand collapsed={effectiveCollapsed} />
          <PlatformSwitcher collapsed={effectiveCollapsed} pathname={location.pathname} onNavigate={navigate} />
          <SideNavigation selectedNavigation={selectedNavigation} onNavigate={navigate} />
          <SiderFooter collapsed={effectiveCollapsed} onNavigate={navigate} />
        </Sider>
      )}

      <Layout>
        <Header className="top-header">
          <Button
            type="text"
            className="navigation-trigger"
            aria-label={isMobile ? '打开主导航' : effectiveCollapsed ? '展开侧边栏' : '收起侧边栏'}
            icon={isMobile || effectiveCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => isMobile ? setMobileNavigationOpen(true) : setCollapsed((current) => !current)}
          />
          {isMobile && <Brand collapsed={false} compact />}
          <TopContext title={pageTitle} />
          <UserArea />
        </Header>

        <Content className="main-content">
          <Breadcrumb items={[{ title: 'SDK 兼容测试平台' }, { title: pageTitle }]} />
          <Outlet />
        </Content>
      </Layout>

      <Drawer
        className="mobile-navigation-drawer"
        placement="left"
        width={280}
        open={mobileNavigationOpen}
        onClose={() => setMobileNavigationOpen(false)}
        styles={{ body: { padding: 0 } }}
        aria-label="主导航"
      >
        <div className="mobile-nav-content">
          <Brand collapsed={false} />
          <PlatformSwitcher collapsed={false} pathname={location.pathname} onNavigate={navigateFromMobile} />
          <SideNavigation selectedNavigation={selectedNavigation} onNavigate={navigateFromMobile} />
          <SiderFooter collapsed={false} onNavigate={navigateFromMobile} />
        </div>
      </Drawer>
    </Layout>
  )
}

function Brand({ collapsed, compact = false }: { collapsed: boolean; compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand--compact' : ''}`} aria-label="SDK CloudTest">
      <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
      {!collapsed && <span>SDK CloudTest</span>}
    </div>
  )
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
        <span className="chevron" aria-hidden="true">⌄</span>
      </button>
    </Dropdown>
  )
}

function SideNavigation({ selectedNavigation, onNavigate }: { selectedNavigation: NavigationKey; onNavigate: (path: string) => void }) {
  const menuItems = [
    { key: 'overview', icon: <BarChartOutlined />, label: '运行概览', onClick: () => onNavigate('/') },
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
      {!collapsed && <div className="help-card"><span>EXECUTION GUIDE</span><strong>兼容测试执行指南</strong></div>}
      <Button type="primary" block={!collapsed} icon={<AppstoreOutlined />} onClick={() => onNavigate('/tasks')}>{!collapsed && '全部功能'}</Button>
    </div>
  )
}

function TopContext({ title }: { title: string }) {
  return <div className="top-context"><span>ANDROID LAB</span><b aria-hidden="true">/</b><strong>{title}</strong></div>
}

function useServiceHealth(): ServiceHealth {
  const [health, setHealth] = useState<ServiceHealth>(platformRuntime.mode === 'mock' ? 'mock' : 'checking')

  useEffect(() => {
    if (platformRuntime.mode === 'mock') return
    const monitor = createServiceHealthMonitor({
      url: `${platformRuntime.apiBaseUrl}/health`,
      onChange: setHealth,
      timeoutMs: 3000,
      intervalMs: 5000,
    })
    monitor.start()
    return () => monitor.stop()
  }, [])

  return health
}

function ServiceStatus({ health }: { health: ServiceHealth }) {
  const label = SERVICE_HEALTH_LABELS[health]
  if (health === 'mock') return <span className="top-status top-status--mock">{label}</span>
  if (health === 'checking' || health === 'retrying') {
    return <span className={`top-status top-status--${health}`}><LoadingOutlined /> {label}</span>
  }
  if (health === 'offline') {
    return <span className="top-status top-status--offline" title="请确认访问端与服务端连接同一局域网"><CloseCircleFilled /> {label}</span>
  }
  if (health === 'slow' || health === 'degraded') {
    return <span className={`top-status top-status--${health}`}><ExclamationCircleFilled /> {label}</span>
  }
  return <span className="top-status"><CheckCircleFilled /> {label}</span>
}

function UserArea() {
  const serviceHealth = useServiceHealth()
  return (
    <Space className="user-area">
      <Tag color="warning" className="local-mode-tag">Phase 0 · 本机单用户</Tag>
      <ServiceStatus health={serviceHealth} />
      <Avatar size="small">韩</Avatar>
      <Typography.Text className="user-name">韩震</Typography.Text>
      <span className="user-chevron" aria-hidden="true">⌄</span>
    </Space>
  )
}
