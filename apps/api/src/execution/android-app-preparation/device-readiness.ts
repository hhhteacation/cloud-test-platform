import { TaskExecutionError } from '../execution-errors.js'
import { delay } from '../file-utils.js'
import type { AndroidPreparationDevice } from './contracts.js'

function isSecureKeyguardShowing(dumpsys: string) {
  return [
    /mShowingLockscreen=true/i,
    /mKeyguardShowing=true/i,
    /isStatusBarKeyguard=true/i,
    /KeyguardServiceDelegate[^\n]*showing=true/i,
  ].some((pattern) => pattern.test(dumpsys))
}

export class DeviceReadinessGuard {
  constructor(private readonly device: AndroidPreparationDevice) {}

  async ensureReady(signal: AbortSignal) {
    const status = await this.device.connectionStatus()
    if (status === 'unauthorized') {
      throw new TaskExecutionError('设备尚未授权此电脑，请在手机上确认 USB 调试授权', 'DEVICE_UNAUTHORIZED')
    }
    if (status !== 'online') {
      throw new TaskExecutionError('设备未连接或 ADB 状态异常', 'DEVICE_OFFLINE')
    }

    await this.device.run(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], signal, 10_000, 'DEVICE_LOCKED')
    await this.device.run(['shell', 'wm', 'dismiss-keyguard'], signal, 10_000, 'DEVICE_LOCKED').catch(() => undefined)
    await this.device.run(['shell', 'input', 'keyevent', 'KEYCODE_MENU'], signal, 10_000, 'DEVICE_LOCKED').catch(() => undefined)
    await delay(350, signal)

    const policy = await this.device.run(
      ['shell', 'dumpsys', 'window', 'policy'],
      signal,
      10_000,
      'DEVICE_LOCKED',
    )
    if (isSecureKeyguardShowing(policy.stdout)) {
      throw new TaskExecutionError(
        '设备仍处于安全锁屏状态。测试机必须移除 PIN、图案或密码锁后才能无人值守执行。',
        'DEVICE_LOCKED',
      )
    }
  }
}
