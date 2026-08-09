import type { ProcessResult } from '../process.js'
import type { DeviceRunPhase } from '../types.js'
import { isRegisteredExecutionFailureCode } from './execution-failures.js'

export interface TaskExecutionErrorOptions {
  evidenceRefs?: readonly string[]
  phase?: DeviceRunPhase
  processResult?: ProcessResult
}

/** Stable compatibility boundary between executors and structured ExecutionFailure. */
export class TaskExecutionError extends Error {
  readonly evidenceRefs: string[]
  readonly phase?: DeviceRunPhase
  readonly processResult?: ProcessResult

  constructor(message: string, readonly code: string, options: TaskExecutionErrorOptions = {}) {
    if (!isRegisteredExecutionFailureCode(code)) {
      throw new Error(`未注册的执行错误码：${code}`)
    }
    super(message)
    this.name = 'TaskExecutionError'
    this.evidenceRefs = [...(options.evidenceRefs ?? [])]
    this.phase = options.phase
    this.processResult = options.processResult
  }
}
