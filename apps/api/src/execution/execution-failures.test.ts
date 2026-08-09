import { describe, expect, it } from 'vitest'

import { TaskExecutionError } from './execution-errors.js'
import {
  createExecutionFailure,
  deserializeExecutionFailure,
  executionFailureFromError,
  isRegisteredExecutionFailureCode,
  mapExecutionFailureEvidence,
  mergeAuxiliaryFailure,
  parseExecutionFailure,
  registeredExecutionFailureCodes,
  serializeExecutionFailure,
} from './execution-failures.js'

describe('ExecutionFailure Registry', () => {
  it('集中补全注册错误码的稳定语义并去重 Evidence', () => {
    expect(createExecutionFailure({
      code: 'INSTALL_USER_ACTION_REQUIRED',
      phase: 'handling_install_dialog',
      message: '需要人工确认',
      evidenceRefs: ['diagnostics/ui.xml', 'diagnostics/ui.xml', ''],
    })).toEqual({
      code: 'INSTALL_USER_ACTION_REQUIRED',
      category: 'user_action',
      phase: 'handling_install_dialog',
      retryability: 'conditional',
      confidence: 'confirmed',
      message: '需要人工确认',
      evidenceRefs: ['diagnostics/ui.xml'],
    })
    expect(isRegisteredExecutionFailureCode('INSTALL_USER_ACTION_REQUIRED')).toBe(true)
    expect(registeredExecutionFailureCodes()).toContain('WORKER_UNEXPECTED_ERROR')
  })

  it('TaskExecutionError 入口拒绝新增未注册平台错误码', () => {
    expect(() => new TaskExecutionError('unknown', 'NEW_UNREGISTERED_CODE')).toThrow(
      '未注册的执行错误码：NEW_UNREGISTERED_CODE',
    )
  })

  it('不允许供应商动态错误码绕过 Registry，并保留原始 code', () => {
    expect(createExecutionFailure({
      code: 'VENDOR_DEVICE_OVERHEATED',
      phase: 'processing',
      message: '供应商处理失败',
      evidenceRefs: ['result.json'],
    })).toMatchObject({
      code: 'SDK_PROCESSING_FAILED',
      category: 'business',
      confidence: 'probable',
      message: '供应商处理失败（原始未注册错误码：VENDOR_DEVICE_OVERHEATED）',
      evidenceRefs: ['result.json'],
    })
  })

  it('从旧 TaskExecutionError 兼容生成结构化失败并保留错误 Evidence', () => {
    const error = new TaskExecutionError('结果损坏', 'RESULT_INVALID', {
      evidenceRefs: ['result.json'],
      phase: 'validating_output',
    })
    expect(executionFailureFromError({
      error,
      phase: 'processing',
      evidenceRefs: ['attempt-manifest.json'],
    })).toMatchObject({
      code: 'RESULT_INVALID',
      phase: 'validating_output',
      evidenceRefs: ['attempt-manifest.json', 'result.json'],
    })
  })

  it('取消语义优先于执行错误且不伪装成基础设施失败', () => {
    expect(executionFailureFromError({
      error: new Error('process killed'),
      phase: 'processing',
      cancelled: true,
    })).toMatchObject({ code: 'TASK_CANCELLED', category: 'cancelled', confidence: 'confirmed' })
  })

  it('只映射返回视图中的 Evidence 引用且不修改原失败对象', () => {
    const failure = createExecutionFailure({
      code: 'RESULT_INVALID',
      phase: 'validating_output',
      message: 'invalid',
      evidenceRefs: ['result.json'],
    })

    expect(mapExecutionFailureEvidence(failure, (ref) => `/evidence/${ref}`)).toEqual({
      ...failure,
      evidenceRefs: ['/evidence/result.json'],
    })
    expect(failure.evidenceRefs).toEqual(['result.json'])
    expect(mapExecutionFailureEvidence(undefined, (ref) => ref)).toBeUndefined()
  })

  it('结构化 JSON 损坏时回退 legacy 字段且不让读取失败', () => {
    expect(deserializeExecutionFailure({
      serialized: '{broken',
      legacyCode: 'DEVICE_OFFLINE',
      legacyMessage: '设备离线',
      phase: 'validating_device',
    })).toMatchObject({ code: 'DEVICE_OFFLINE', category: 'device', message: '设备离线' })
    expect(deserializeExecutionFailure({ serialized: '{broken' })).toBeUndefined()
  })

  it('拒绝被篡改的 Registry 语义并支持安全 round-trip', () => {
    const failure = createExecutionFailure({
      code: 'RESULT_INVALID', phase: 'validating_output', message: 'invalid',
    })
    expect(deserializeExecutionFailure({ serialized: serializeExecutionFailure(failure) })).toEqual(failure)
    expect(parseExecutionFailure({ ...failure, category: 'device' })).toBeUndefined()
  })

  it('辅助 observation/cleanup 失败只能附加 Evidence，不能覆盖原始业务失败', () => {
    const business = createExecutionFailure({
      code: 'SDK_PROCESSING_FAILED', phase: 'processing', message: '业务明确失败', evidenceRefs: ['result.json'],
      confidence: 'confirmed',
    })
    const cleanup = createExecutionFailure({
      code: 'DEVICE_CLEANUP_FAILED', phase: 'generating_report', message: '清理失败', evidenceRefs: ['cleanup.json'],
    })
    expect(mergeAuxiliaryFailure(business, cleanup)).toEqual({
      ...business,
      evidenceRefs: ['result.json', 'cleanup.json'],
    })
  })
})
