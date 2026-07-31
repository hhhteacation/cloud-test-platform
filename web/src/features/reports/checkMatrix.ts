import type { CheckResult } from '../../types'

export interface ReportCheckColumn {
  key: string
  title: string
  aliases: string[]
}

/**
 * Stable presentation plan for the compatibility matrix.
 * Protocol-specific check keys stay behind aliases, so adding a new Android APK
 * protocol does not require rewriting the report table.
 */
export const REPORT_CHECK_COLUMNS: ReportCheckColumn[] = [
  { key: 'launch', title: '应用启动', aliases: ['launch'] },
  { key: 'input', title: '输入校验', aliases: ['input', 'load'] },
  { key: 'sdk_init', title: 'SDK 初始化', aliases: ['sdk_init'] },
  { key: 'processing', title: 'SDK 处理', aliases: ['processing'] },
  { key: 'output_generated', title: '输出生成', aliases: ['output_generated'] },
  { key: 'output_load', title: '输出加载', aliases: ['output_load'] },
  { key: 'first_frame', title: '首帧展示', aliases: ['first_frame', 'first-frame'] },
  { key: 'continuous', title: '连续播放', aliases: ['continuous', 'play'] },
  { key: 'pause_resume', title: '暂停/恢复', aliases: ['pause_resume', 'pause', 'resume'] },
  { key: 'seek', title: '进度拖动', aliases: ['seek'] },
  { key: 'loop', title: '循环播放', aliases: ['loop'] },
  { key: 'rotation', title: '旋转播放', aliases: ['rotation'] },
  { key: 'complete', title: '播放完成', aliases: ['complete'] },
  { key: 'no_crash', title: '无崩溃', aliases: ['no_crash'] },
]

export function findMatrixCheck(checks: CheckResult[], column: ReportCheckColumn) {
  const matches = checks.filter((check) => column.aliases.includes(check.key))
  if (!matches.length) return undefined
  const failed = matches.find((check) => check.status === 'failed')
  const blocked = matches.find((check) => check.status === 'blocked')
  return failed ?? blocked ?? matches[matches.length - 1]
}
