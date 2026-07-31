import type { DeviceRunPhase } from '../../types'

export const EXECUTION_PHASES: Array<{ key: DeviceRunPhase; label: string }> = [
  { key: 'validating_device', label: '设备连接' },
  { key: 'validating_apk', label: 'APK 校验' },
  { key: 'installing_apk', label: 'APK 安装' },
  { key: 'handling_install_dialog', label: 'APK 安装确认' },
  { key: 'granting_permissions', label: '运行权限准备' },
  { key: 'handling_app_dialog', label: '应用兼容提示' },
  { key: 'transferring_input', label: '输入视频传输' },
  { key: 'launching_app', label: '启动测试 APK' },
  { key: 'processing', label: 'SDK 初始化与处理' },
  { key: 'validating_output', label: '输出视频验证' },
  { key: 'collecting_output', label: '输出文件收集' },
  { key: 'generating_report', label: '报告生成' },
  { key: 'completed', label: '任务完成' },
]
