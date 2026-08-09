import type { DeviceRunPhase } from '../types.js'

export type ExecutionFailureCategory =
  | 'observation'
  | 'device'
  | 'business'
  | 'protocol'
  | 'infrastructure'
  | 'user_action'
  | 'cancelled'

export type ExecutionFailureRetryability = 'never' | 'safe' | 'conditional'
export type ExecutionFailureConfidence = 'confirmed' | 'probable' | 'unknown'

export interface ExecutionFailure {
  code: string
  category: ExecutionFailureCategory
  phase: DeviceRunPhase
  retryability: ExecutionFailureRetryability
  confidence: ExecutionFailureConfidence
  message: string
  evidenceRefs: string[]
}

interface FailureDefinition {
  category: ExecutionFailureCategory
  retryability: ExecutionFailureRetryability
  confidence: ExecutionFailureConfidence
}

const failureDefinitions = {
  ADB_OBSERVATION_FAILED: definition('observation', 'conditional', 'confirmed'),
  APK_INSTALL_FAILED: definition('infrastructure', 'conditional', 'confirmed'),
  APP_CRASHED: definition('business', 'conditional', 'confirmed'),
  APP_LAUNCH_FAILED: definition('protocol', 'conditional', 'confirmed'),
  DEVICE_CLEANUP_FAILED: definition('infrastructure', 'safe', 'confirmed'),
  DEVICE_IDENTITY_MISMATCH: definition('device', 'never', 'confirmed'),
  DEVICE_IDENTITY_UNVERIFIED: definition('observation', 'conditional', 'unknown'),
  DEVICE_INPUT_AUTOMATION_DENIED: definition('user_action', 'conditional', 'confirmed'),
  DEVICE_LOCKED: definition('user_action', 'conditional', 'confirmed'),
  DEVICE_NOT_ELIGIBLE: definition('device', 'conditional', 'confirmed'),
  DEVICE_NOT_FOUND: definition('device', 'conditional', 'confirmed'),
  DEVICE_NOT_ONLINE: definition('device', 'safe', 'confirmed'),
  DEVICE_NOT_REGISTERED: definition('device', 'never', 'confirmed'),
  DEVICE_OFFLINE: definition('device', 'safe', 'confirmed'),
  DEVICE_UNAUTHORIZED: definition('user_action', 'conditional', 'confirmed'),
  DEVICE_WAKE_FAILED: definition('device', 'conditional', 'confirmed'),
  ENDPOINT_NOT_FOUND: definition('device', 'conditional', 'confirmed'),
  INPUT_PUSH_FAILED: definition('infrastructure', 'safe', 'confirmed'),
  INSTALL_DIALOG_TIMEOUT: definition('user_action', 'conditional', 'probable'),
  INSTALL_DIALOG_UNRECOGNIZED: definition('user_action', 'conditional', 'confirmed'),
  INSTALL_USER_ACTION_REQUIRED: definition('user_action', 'conditional', 'confirmed'),
  INSUFFICIENT_DISK_SPACE: definition('infrastructure', 'conditional', 'confirmed'),
  INSUFFICIENT_LOGCAT_DISK_SPACE: definition('infrastructure', 'conditional', 'confirmed'),
  INVALID_TEST_APK: definition('protocol', 'never', 'confirmed'),
  LOGCAT_CLEAR_FAILED: definition('observation', 'safe', 'confirmed'),
  LOGCAT_START_FAILED: definition('observation', 'safe', 'confirmed'),
  LOGCAT_TRUNCATED: definition('observation', 'conditional', 'confirmed'),
  MEDIA_DECODE_FAILED: definition('business', 'conditional', 'confirmed'),
  MEDIA_EMPTY_FILE: definition('business', 'never', 'confirmed'),
  MEDIA_INTEGRITY_FAILED: definition('business', 'conditional', 'confirmed'),
  MEDIA_PROBE_FAILED: definition('observation', 'conditional', 'confirmed'),
  MEDIA_VIDEO_STREAM_MISSING: definition('business', 'never', 'confirmed'),
  NETWORK_ADB_NOT_AVAILABLE: definition('device', 'conditional', 'confirmed'),
  NETWORK_DEVICE_OFFLINE: definition('device', 'safe', 'confirmed'),
  OUTPUT_EMPTY: definition('protocol', 'conditional', 'confirmed'),
  OUTPUT_MISSING: definition('protocol', 'conditional', 'confirmed'),
  POST_LAUNCH_DIALOG_TIMEOUT: definition('user_action', 'conditional', 'probable'),
  POST_LAUNCH_DIALOG_UNRECOGNIZED: definition('user_action', 'conditional', 'confirmed'),
  RESULT_INVALID: definition('protocol', 'never', 'confirmed'),
  RESULT_MISSING: definition('protocol', 'conditional', 'confirmed'),
  RESULT_TASK_MISMATCH: definition('protocol', 'never', 'confirmed'),
  RUNTIME_PERMISSION_DIALOG_TIMEOUT: definition('user_action', 'conditional', 'probable'),
  RUNTIME_PERMISSION_DIALOG_UNRECOGNIZED: definition('user_action', 'conditional', 'confirmed'),
  RUNTIME_PERMISSION_GRANT_FAILED: definition('device', 'conditional', 'confirmed'),
  RUNTIME_PERMISSION_NOT_GRANTED: definition('user_action', 'conditional', 'confirmed'),
  RUNTIME_PERMISSION_VERIFICATION_UNSUPPORTED: definition('observation', 'conditional', 'confirmed'),
  SDK_PROCESSING_FAILED: definition('business', 'conditional', 'probable'),
  SDK_START_FAILED: definition('protocol', 'conditional', 'confirmed'),
  SERVICE_RESTARTED: definition('infrastructure', 'safe', 'confirmed'),
  STARTUP_OBSERVATION_FAILED: definition('observation', 'conditional', 'confirmed'),
  STARTUP_OBSERVATION_INCOMPLETE: definition('observation', 'conditional', 'unknown'),
  TASK_CANCELLED: definition('cancelled', 'never', 'confirmed'),
  TASK_TIMEOUT: definition('protocol', 'conditional', 'confirmed'),
  UNSUPPORTED_APK_PROTOCOL: definition('protocol', 'never', 'confirmed'),
  WORKER_UNEXPECTED_ERROR: definition('infrastructure', 'conditional', 'unknown'),
} as const satisfies Record<string, FailureDefinition>

export type RegisteredExecutionFailureCode = keyof typeof failureDefinitions

function definition(
  category: ExecutionFailureCategory,
  retryability: ExecutionFailureRetryability,
  confidence: ExecutionFailureConfidence,
): FailureDefinition {
  return { category, retryability, confidence }
}

function uniqueEvidenceRefs(refs: readonly string[] = []) {
  return [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))]
}

export function isRegisteredExecutionFailureCode(code: string): code is RegisteredExecutionFailureCode {
  return Object.hasOwn(failureDefinitions, code)
}

export function registeredExecutionFailureCodes() {
  return Object.keys(failureDefinitions).sort() as RegisteredExecutionFailureCode[]
}

export function createExecutionFailure(input: {
  code: string
  phase: DeviceRunPhase
  message: string
  evidenceRefs?: readonly string[]
  confidence?: ExecutionFailureConfidence
}): ExecutionFailure {
  const registeredCode = isRegisteredExecutionFailureCode(input.code)
    ? input.code
    : 'SDK_PROCESSING_FAILED'
  const sourceCodeSuffix = registeredCode === input.code
    ? ''
    : `（原始未注册错误码：${input.code}）`
  const semantics = failureDefinitions[registeredCode]
  return {
    code: registeredCode,
    category: semantics.category,
    phase: input.phase,
    retryability: semantics.retryability,
    confidence: input.confidence ?? semantics.confidence,
    message: `${input.message}${sourceCodeSuffix}`,
    evidenceRefs: uniqueEvidenceRefs(input.evidenceRefs),
  }
}

export function executionFailureFromError(input: {
  error: unknown
  phase: DeviceRunPhase
  cancelled?: boolean
  evidenceRefs?: readonly string[]
}): ExecutionFailure {
  if (input.cancelled) {
    return createExecutionFailure({
      code: 'TASK_CANCELLED',
      phase: input.phase,
      message: '用户取消任务',
      evidenceRefs: input.evidenceRefs,
    })
  }
  if (isTaskExecutionError(input.error)) {
    return createExecutionFailure({
      code: input.error.code,
      phase: input.error.phase ?? input.phase,
      message: input.error.message,
      evidenceRefs: [...(input.evidenceRefs ?? []), ...input.error.evidenceRefs],
    })
  }
  return createExecutionFailure({
    code: 'SDK_PROCESSING_FAILED',
    phase: input.phase,
    message: input.error instanceof Error ? input.error.message : String(input.error),
    evidenceRefs: input.evidenceRefs,
    confidence: 'unknown',
  })
}

export function serializeExecutionFailure(failure: ExecutionFailure | undefined | null) {
  return failure ? JSON.stringify(failure) : null
}

export function parseExecutionFailure(value: unknown): ExecutionFailure | undefined {
  if (!isRecord(value)
    || typeof value.code !== 'string'
    || !isRegisteredExecutionFailureCode(value.code)
    || !isFailureCategory(value.category)
    || !isDeviceRunPhase(value.phase)
    || !isRetryability(value.retryability)
    || !isConfidence(value.confidence)
    || typeof value.message !== 'string'
    || !Array.isArray(value.evidenceRefs)
    || !value.evidenceRefs.every((ref) => typeof ref === 'string')) return undefined

  const registered = failureDefinitions[value.code]
  if (value.category !== registered.category || value.retryability !== registered.retryability) return undefined
  return {
    code: value.code,
    category: value.category,
    phase: value.phase,
    retryability: value.retryability,
    confidence: value.confidence,
    message: value.message,
    evidenceRefs: uniqueEvidenceRefs(value.evidenceRefs),
  }
}

export function deserializeExecutionFailure(input: {
  serialized?: string | null
  legacyCode?: string | null
  legacyMessage?: string | null
  phase?: DeviceRunPhase | null
}): ExecutionFailure | undefined {
  if (input.serialized?.trim()) {
    try {
      const parsed = parseExecutionFailure(JSON.parse(input.serialized))
      if (parsed) return parsed
    } catch {
      // Fall through to legacy columns. Corrupt structured JSON must not break task reads.
    }
  }
  if (!input.legacyCode) return undefined
  return createExecutionFailure({
    code: input.legacyCode,
    phase: input.phase ?? 'validating_device',
    message: input.legacyMessage || input.legacyCode,
  })
}

/**
 * Auxiliary observation/cleanup failures add Evidence but never replace an already
 * confirmed business outcome. Callers that have no primary failure may use the
 * auxiliary failure as the primary result.
 */
export function mergeAuxiliaryFailure(
  primary: ExecutionFailure | undefined,
  auxiliary: ExecutionFailure,
): ExecutionFailure {
  if (!primary) return auxiliary
  return {
    ...primary,
    evidenceRefs: uniqueEvidenceRefs([...primary.evidenceRefs, ...auxiliary.evidenceRefs]),
  }
}

function isTaskExecutionError(error: unknown): error is Error & {
  code: string
  evidenceRefs: string[]
  phase?: DeviceRunPhase
} {
  return error instanceof Error
    && error.name === 'TaskExecutionError'
    && typeof (error as { code?: unknown }).code === 'string'
    && Array.isArray((error as { evidenceRefs?: unknown }).evidenceRefs)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFailureCategory(value: unknown): value is ExecutionFailureCategory {
  return ['observation', 'device', 'business', 'protocol', 'infrastructure', 'user_action', 'cancelled'].includes(String(value))
}

function isRetryability(value: unknown): value is ExecutionFailureRetryability {
  return ['never', 'safe', 'conditional'].includes(String(value))
}

function isConfidence(value: unknown): value is ExecutionFailureConfidence {
  return ['confirmed', 'probable', 'unknown'].includes(String(value))
}

function isDeviceRunPhase(value: unknown): value is DeviceRunPhase {
  return [
    'validating_device', 'validating_apk', 'installing_apk', 'handling_install_dialog',
    'granting_permissions', 'handling_app_dialog', 'transferring_input', 'launching_app',
    'processing', 'validating_output', 'collecting_output', 'generating_report', 'completed',
  ].includes(String(value))
}
