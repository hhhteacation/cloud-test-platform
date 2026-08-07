import { TaskExecutionError } from '../execution-errors.js'

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function isInputInjectionDenied(error: unknown) {
  const message = errorText(error)
  const isSecurityException = /(?:java\.lang\.)?SecurityException/i.test(message)
  const identifiesInputInjection = /INJECT_EVENTS|Injecting input events requires the caller|injectInputEvent(?:ToTarget)?/i.test(message)
  return isSecurityException && identifiesInputInjection
}

export function createInputAutomationDeniedError(manufacturer?: string) {
  const isXiaomi = /xiaomi|redmi|poco|小米|红米/i.test(manufacturer ?? '')
  const operationLabel = '控制触摸事件'
  const systemLabel = isXiaomi ? '小米/HyperOS' : '设备系统'
  const guidance = isXiaomi
    ? '请保持手机解锁，并在开发者选项中开启“USB 调试（安全设置）”后重试。网络 ADB 同样受该设置限制。'
    : '请保持手机解锁，并在开发者选项中检查是否允许通过 ADB 控制输入事件后重试。'

  return new TaskExecutionError(
    `${systemLabel} 拒绝 ADB ${operationLabel}。${guidance}`,
    'DEVICE_INPUT_AUTOMATION_DENIED',
  )
}
