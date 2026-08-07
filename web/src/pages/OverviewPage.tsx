import {
  AndroidOutlined,
  ArrowRightOutlined,
  CheckOutlined,
  CloseOutlined,
  ClockCircleOutlined,
  CloudServerOutlined,
  FileDoneOutlined,
  VideoCameraOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { Alert, Button, Skeleton, Tag } from 'antd'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'

import { StatusTag } from '../components/StatusTag'
import { EXECUTION_PHASES } from '../components/execution/executionDefinitions'
import { isRealPlatform } from '../platform/client'
import { usePlatformDevices, usePlatformTasks } from '../platform/usePlatformData'
import type { DeviceProfile, DeviceRunPhase, DeviceRunResult, TestTask } from '../types'
import { formatDate } from '../utils/format'
import './OverviewPage.css'

type RailState = 'complete' | 'active' | 'pending' | 'failed'

interface RailStep {
  key: 'input' | 'device' | 'sdk' | 'output'
  code: string
  title: string
  detail: string
  state: RailState
}

const RAIL_STATE_LABELS: Record<RailState, string> = {
  complete: '已完成',
  active: '执行中',
  pending: '等待中',
  failed: '失败',
}

const PHASE_STAGE: Partial<Record<DeviceRunPhase, number>> = {
  validating_device: 1,
  validating_apk: 0,
  installing_apk: 1,
  handling_install_dialog: 1,
  granting_permissions: 1,
  handling_app_dialog: 1,
  transferring_input: 1,
  launching_app: 1,
  processing: 2,
  validating_output: 3,
  collecting_output: 3,
  generating_report: 3,
  completed: 3,
}

const PHASE_LABELS = Object.fromEntries(
  EXECUTION_PHASES.map((phase) => [phase.key, phase.label]),
) as Record<DeviceRunPhase, string>

export function selectPrimaryRun(task: TestTask | undefined) {
  if (!task) return undefined
  const runs = task.deviceIds.map((deviceId) => task.runs[deviceId]).filter(Boolean)
  if (!runs.length) return Object.values(task.runs)[0]

  const priorities: Record<TestTask['status'], DeviceRunResult['status'][]> = {
    draft: ['queued', 'running', 'failed', 'blocked', 'passed'],
    queued: ['queued', 'running', 'failed', 'blocked', 'passed'],
    running: ['running', 'failed', 'blocked', 'queued', 'passed'],
    passed: ['passed', 'running', 'queued', 'failed', 'blocked'],
    failed: ['failed', 'blocked', 'running', 'queued', 'passed'],
    cancelled: ['failed', 'blocked', 'running', 'queued', 'passed'],
  }

  for (const status of priorities[task.status]) {
    const run = runs.find((candidate) => candidate.status === status)
    if (run) return run
  }
  return runs[0]
}

/**
 * 首页控制台优先承担“现在发生了什么”的职责：活动任务优先于单纯的创建时间。
 * 当没有活动任务时才回落到最近一次执行，避免真实后端接入后轨道展示一条
 * 刚创建但尚未执行的草稿，而把正在运行的真机任务藏起来。
 */
export function selectSignalTask(tasks: TestTask[]) {
  return tasks.find((task) => task.status === 'running')
    ?? tasks.find((task) => task.status === 'queued')
    ?? tasks[0]
}

export function selectSignalDevice(
  task: TestTask | undefined,
  run: DeviceRunResult | undefined,
  devices: DeviceProfile[],
) {
  const taskDeviceIds = new Set(task?.deviceIds ?? [])
  return devices.find((device) => device.id === run?.deviceId)
    ?? devices.find((device) => taskDeviceIds.has(device.id) && device.connectionStatus === 'online')
    ?? devices.find((device) => taskDeviceIds.has(device.id))
    ?? devices.find((device) => device.eligible && device.executionMode === 'adb' && device.connectionStatus === 'online')
    ?? devices.find((device) => device.eligible && device.executionMode === 'adb')
}

function getActiveStage(task: TestTask, run: DeviceRunResult | undefined) {
  if (run?.phase) return PHASE_STAGE[run.phase] ?? 1
  if (task.progress >= 85) return 3
  if (task.progress >= 55) return 2
  return 1
}

function getRailState(task: TestTask | undefined, run: DeviceRunResult | undefined, index: number): RailState {
  if (!task) return 'pending'
  if (task.status === 'passed') return 'complete'
  if (task.status === 'queued' || task.status === 'draft') return index === 0 ? 'complete' : 'pending'

  const activeStage = getActiveStage(task, run)
  if (task.status === 'failed' || task.status === 'cancelled') {
    if (index < activeStage) return 'complete'
    if (index === activeStage) return 'failed'
    return 'pending'
  }

  if (index < activeStage) return 'complete'
  if (index === activeStage) return 'active'
  return 'pending'
}

export function buildRailSteps(
  task: TestTask | undefined,
  run: DeviceRunResult | undefined,
  device: DeviceProfile | undefined,
): RailStep[] {
  const inputDetail = task
    ? `${task.apk?.name ?? 'APK 已上传'} + ${task.asset.name}`
    : '等待 APK 与 MP4'
  const deviceDetail = device
    ? `${device.name} · ${device.connectionStatus === 'online' ? 'ONLINE' : 'NOT READY'}`
    : '等待 ADB 真机'
  const sdkDetail = run?.adapter ?? (run?.phase ? PHASE_LABELS[run.phase] : '等待 SDK 调用')
  const outputDetail = run?.outputs[0]?.name ?? (task?.status === 'passed' ? '报告已生成' : '等待产物回收')

  return [
    { key: 'input', code: 'INPUT', title: '输入校验', detail: inputDetail, state: getRailState(task, run, 0) },
    { key: 'device', code: 'ADB', title: '真机准备', detail: deviceDetail, state: getRailState(task, run, 1) },
    { key: 'sdk', code: 'SDK', title: 'SDK 处理', detail: sdkDetail, state: getRailState(task, run, 2) },
    { key: 'output', code: 'OUT', title: '产物回收', detail: outputDetail, state: getRailState(task, run, 3) },
  ]
}

function getRunHeadline(task: TestTask | undefined, run: DeviceRunResult | undefined) {
  if (!task) return '等待创建测试任务'
  if (task.status === 'queued') return '任务已进入执行队列'
  if (task.status === 'passed') return '最近任务已完成'
  if (task.status === 'failed') return run?.failureMessage ?? '最近任务执行失败'
  if (task.status === 'cancelled') return '最近任务已取消'
  return run?.phase ? PHASE_LABELS[run.phase] : '任务正在执行'
}

function getLatestLog(task: TestTask | undefined, run: DeviceRunResult | undefined) {
  const latestLog = run?.logs.at(-1)
  if (latestLog) return latestLog
  if (!task) return '等待上传 APK 与 MP4，当前没有活动任务。'
  if (task.status === 'queued') return '任务已创建，正在等待可调度的 Android 真机。'
  if (task.status === 'passed') return '执行链路已结束，可进入任务详情查看产物和报告。'
  if (task.status === 'failed') return run?.failureMessage ?? '任务失败，请进入执行详情查看诊断信息。'
  return '任务状态已同步，等待下一条结构化执行事件。'
}

export function OverviewPage() {
  const navigate = useNavigate()
  const { tasks, loading: tasksLoading, error: taskError } = usePlatformTasks(true)
  const { devices, loading: devicesLoading, error: deviceError } = usePlatformDevices()
  const latestTask = tasks[0]
  const signalTask = selectSignalTask(tasks)
  const ratedTask = tasks.find((task) => typeof task.passRate === 'number')
  const adbDevices = devices.filter((device) => device.eligible && device.executionMode === 'adb')
  const primaryRun = selectPrimaryRun(signalTask)
  const adbDevice = selectSignalDevice(signalTask, primaryRun, adbDevices)
  const progress = primaryRun?.progress ?? signalTask?.progress ?? 0
  const railSteps = buildRailSteps(signalTask, primaryRun, adbDevice)
  const readyDeviceCount = adbDevices.filter((device) => device.connectionStatus === 'online').length
  const isLoading = tasksLoading || devicesLoading
  const dataError = [taskError && `任务：${taskError}`, deviceError && `设备：${deviceError}`]
    .filter(Boolean)
    .join('；') || undefined

  return (
    <div className="overview-page">
      {dataError && (
        <Alert
          className="overview-error"
          type="error"
          showIcon
          message="平台数据加载失败"
          description={dataError}
        />
      )}

      <section className="overview-hero" aria-labelledby="overview-title">
        <div className="overview-intro">
          <p className="overview-kicker">ANDROID LAB · VIDEO SDK COMPATIBILITY</p>
          <h1 id="overview-title">真机视频兼容测试</h1>
          <p className="overview-description">
            上传 APK 与 MP4，在 Android 真机完成 SDK 处理，并回收可验证的 output.mp4、日志与测试报告。
          </p>
          <div className="overview-actions">
            <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => navigate('/create')}>
              创建测试任务
            </Button>
            <Button type="text" size="large" onClick={() => navigate('/tasks')}>
              查看全部任务 <ArrowRightOutlined />
            </Button>
          </div>
          <div className="overview-mode-summary">
            <SafetyCertificateOutlined aria-hidden="true" />
            <div>
              <strong>{isRealPlatform ? '本地 ADB 真机执行模式' : '浏览器 Mock 演示模式'}</strong>
              <span>
                {isRealPlatform
                  ? 'Fastify、SQLite 与 ADB Worker 负责真实调度，失败结果不会被模拟成功替代。'
                  : '当前显式启用了 Mock 模式；切换到真实后端后即可上传文件并调度设备。'}
              </span>
            </div>
          </div>
        </div>

        <SignalConsole
          device={adbDevice}
          signalTask={signalTask}
          primaryRun={primaryRun}
          progress={progress}
          railSteps={railSteps}
          dataError={dataError}
          onOpenTask={() => navigate(signalTask ? `/execution/${signalTask.id}` : '/create')}
        />
      </section>

      {isLoading ? (
        <section className="overview-loading" aria-busy="true" aria-label="正在加载平台数据">
          <Skeleton active paragraph={{ rows: 7 }} />
        </section>
      ) : (
        <>
          <section className="overview-metrics" aria-label="平台关键指标">
            <Metric label="TASKS / TOTAL" value={String(tasks.length).padStart(2, '0')} caption="测试任务" />
            <Metric
              label="DEVICE / READY"
              value={String(readyDeviceCount).padStart(2, '0')}
              caption={readyDeviceCount ? 'ADB 真机在线' : '等待真机连接'}
              online={readyDeviceCount > 0}
            />
            <Metric label="LAST / PASS RATE" value={`${ratedTask?.passRate ?? 0}%`} caption="最近任务通过率" />
            <Metric label="TIMEOUT / DEFAULT" value="300s" caption="单设备执行上限" />
          </section>

          <section className="overview-bottom-grid">
            <RecentTaskPanel
              latestTask={latestTask}
              progress={latestTask?.progress ?? 0}
              onView={() => navigate(latestTask ? `/execution/${latestTask.id}` : '/tasks')}
            />
            <ExecutionContract />
          </section>
        </>
      )}
    </div>
  )
}

function SignalConsole({
  device,
  signalTask,
  primaryRun,
  progress,
  railSteps,
  dataError,
  onOpenTask,
}: {
  device?: DeviceProfile
  signalTask?: TestTask
  primaryRun?: DeviceRunResult
  progress: number
  railSteps: RailStep[]
  dataError?: string
  onOpenTask: () => void
}) {
  const deviceOnline = device?.connectionStatus === 'online'
  const consoleState = dataError || signalTask?.status === 'failed'
    ? 'failed'
    : signalTask?.status === 'running'
      ? 'running'
      : 'idle'
  const signalStatus = dataError
    ? { label: 'DATA SYNC ERROR', tone: 'failed' }
    : signalTask?.status === 'running'
      ? { label: 'LIVE RUN', tone: 'online' }
      : signalTask?.status === 'queued'
        ? { label: 'RUN QUEUED', tone: 'warning' }
        : signalTask?.status === 'passed'
          ? { label: 'RUN PASSED', tone: 'online' }
          : signalTask?.status === 'failed'
            ? { label: 'RUN FAILED', tone: 'failed' }
            : signalTask?.status === 'cancelled'
              ? { label: 'RUN CANCELLED', tone: 'warning' }
              : deviceOnline
                ? { label: 'DEVICE ONLINE', tone: 'online' }
                : { label: 'DEVICE NOT READY', tone: 'idle' }
  const deviceTitle = dataError ? '平台数据链路未连接' : device?.name ?? '未发现 ADB 真机'
  const deviceDescription = dataError
    ? '保留最后一次成功同步的数据，服务恢复后将自动刷新'
    : device
      ? `${device.osVersion} · API ${device.apiLevel} · ${device.architecture}`
      : '请前往设备管理检查连接'
  const deviceTag = isRealPlatform
    ? device
      ? `ADB · ${(device.connectionStatus ?? 'unknown').toUpperCase()}`
      : 'ADB · NO DEVICE'
    : 'MOCK'

  return (
    <section className={`signal-console signal-console--${consoleState}`} aria-labelledby="signal-console-title">
      <div className="signal-console-heading">
        <span id="signal-console-title">DEVICE SIGNAL RAIL <b>/ POLL 5S</b></span>
        <span className={`signal-live is-${signalStatus.tone}`} aria-live="polite">
          <span className="signal-live-dot" aria-hidden="true" />
          {signalStatus.label}
        </span>
      </div>

      <div className="signal-task-channel">
        <div>
          <span>ACTIVE CHANNEL</span>
          <strong>{signalTask?.name ?? '等待首个测试任务'}</strong>
          <small>{signalTask ? `TASK / ${signalTask.id.slice(0, 12).toUpperCase()}` : 'TASK / NOT ASSIGNED'}</small>
        </div>
        <Button className="signal-task-link" type="text" onClick={onOpenTask}>
          {signalTask ? '进入执行现场' : '创建任务'} <ArrowRightOutlined />
        </Button>
      </div>

      <div className="signal-device-row">
        <div>
          <strong>{deviceTitle}</strong>
          <span>{deviceDescription}</span>
        </div>
        <Tag className={`signal-device-tag signal-device-tag--${device?.connectionStatus ?? 'unknown'}`}>
          {deviceTag}
        </Tag>
      </div>

      <ol
        className="signal-rail"
        aria-label="测试执行链路"
        style={{ '--signal-scale': Math.max(0, Math.min(1, progress / 100)) } as CSSProperties}
      >
        <span className="signal-rail-line" aria-hidden="true" />
        <span className="signal-rail-current" aria-hidden="true" />
        {railSteps.map((step, index) => (
          <li
            className={`signal-step signal-step--${step.state}`}
            key={step.key}
            aria-current={step.state === 'active' ? 'step' : undefined}
            aria-label={`${step.code} ${step.title}，${RAIL_STATE_LABELS[step.state]}，${step.detail}`}
          >
            <span className="signal-node" aria-hidden="true">
              {step.state === 'complete'
                ? <CheckOutlined />
                : step.state === 'failed'
                  ? <CloseOutlined />
                  : String(index + 1).padStart(2, '0')}
            </span>
            <strong>{step.code}</strong>
            <span>{step.title}</span>
            <small>{step.detail}</small>
          </li>
        ))}
      </ol>

      <div className="signal-progress-copy">
        <span>{dataError ? '状态同步中断，正在等待服务恢复' : getRunHeadline(signalTask, primaryRun)}</span>
        <strong>{progress}%</strong>
      </div>
      <div
        className="signal-progress"
        role="progressbar"
        aria-label="当前测试进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="signal-event">
        <span>EVENT</span>
        <p>{dataError ? dataError : getLatestLog(signalTask, primaryRun)}</p>
        <i aria-hidden="true" />
      </div>
    </section>
  )
}

function Metric({ label, value, caption, online = false }: { label: string; value: string; caption: string; online?: boolean }) {
  return (
    <div className="overview-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{online && <i aria-hidden="true" />}{caption}</small>
    </div>
  )
}

function RecentTaskPanel({ latestTask, progress, onView }: { latestTask?: TestTask; progress: number; onView: () => void }) {
  return (
    <article className="recent-run-panel" aria-labelledby="recent-run-title">
      <div className="overview-panel-heading">
        <div>
          <span>RECENT RUN</span>
          <h2 id="recent-run-title">最近测试任务</h2>
        </div>
        {latestTask && <StatusTag status={latestTask.status} />}
      </div>

      {latestTask ? (
        <>
          <div className="recent-run-title-row">
            <div className="recent-run-icon" aria-hidden="true"><AndroidOutlined /></div>
            <div>
              <strong>{latestTask.name}</strong>
              <span>{formatDate(latestTask.createdAt)}</span>
            </div>
            <b>{progress}%</b>
          </div>

          <div className="recent-run-files">
            <div><FileDoneOutlined aria-hidden="true" /><span><small>APPLICATION</small>{latestTask.apk?.name ?? 'APK 未记录'}</span></div>
            <span className="recent-run-connector" aria-hidden="true" />
            <div><VideoCameraOutlined aria-hidden="true" /><span><small>INPUT MEDIA</small>{latestTask.asset.name}</span></div>
          </div>

          <div className="recent-run-footer">
            <span>{latestTask.deviceIds.length} 台目标设备</span>
            <Button type="link" onClick={onView}>进入执行现场 <ArrowRightOutlined /></Button>
          </div>
        </>
      ) : (
        <div className="recent-run-empty">
          <CloudServerOutlined aria-hidden="true" />
          <div><strong>还没有测试任务</strong><span>创建首个 APK + MP4 任务后，执行状态会显示在这里。</span></div>
          <Button type="link" onClick={onView}>查看任务列表 <ArrowRightOutlined /></Button>
        </div>
      )}
    </article>
  )
}

function ExecutionContract() {
  const items = [
    ['01', 'APK / AAPT 校验与安装'],
    ['02', 'MP4 推送到应用目录'],
    ['03', '结构化事件与设备日志'],
    ['04', 'output.mp4 与报告回收'],
  ]

  return (
    <aside className="execution-contract" aria-labelledby="execution-contract-title">
      <div className="overview-panel-heading">
        <div>
          <span>EXECUTION CONTRACT</span>
          <h2 id="execution-contract-title">执行协议</h2>
        </div>
        <ClockCircleOutlined aria-hidden="true" />
      </div>
      <ul>
        {items.map(([index, label]) => (
          <li key={index}><span>{index}</span><strong>{label}</strong><CheckOutlined aria-hidden="true" /></li>
        ))}
      </ul>
    </aside>
  )
}
