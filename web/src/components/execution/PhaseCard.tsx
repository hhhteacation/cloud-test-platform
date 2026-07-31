import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  LoadingOutlined,
} from '@ant-design/icons'
import { Card } from 'antd'

import type { DeviceRunResult } from '../../types'
import { EXECUTION_PHASES } from './executionDefinitions'

export function PhaseCard({ run }: { run?: DeviceRunResult }) {
  const currentIndex = run?.phase
    ? EXECUTION_PHASES.findIndex((item) => item.key === run.phase)
    : -1

  return (
    <Card title="执行阶段" className="phase-card">
      <div className="phase-list">
        {EXECUTION_PHASES.map((phase, index) => {
          const passed = run?.status === 'passed' || index < currentIndex
          const current = run?.status === 'running' && index === currentIndex
          const failed = run?.status === 'failed' && index === currentIndex

          return (
            <div className={`phase-item ${current ? 'current' : ''}`} key={phase.key}>
              <PhaseIcon passed={passed} failed={failed} current={current} />
              <span>{phase.label}</span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function PhaseIcon({
  passed,
  failed,
  current,
}: {
  passed: boolean
  failed: boolean
  current: boolean
}) {
  if (passed) return <CheckCircleFilled className="check-ok" />
  if (failed) return <CloseCircleFilled className="check-failed" />
  if (current) return <LoadingOutlined className="check-running" />
  return <ClockCircleOutlined />
}
