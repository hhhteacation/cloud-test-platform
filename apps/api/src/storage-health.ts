import { statfs } from 'node:fs/promises'

export class InsufficientDiskSpaceError extends Error {
  readonly code = 'INSUFFICIENT_DISK_SPACE'
  constructor(readonly availableBytes: number, readonly minimumBytes: number) {
    super(`磁盘可用空间不足：当前 ${availableBytes} 字节，创建任务至少需要保留 ${minimumBytes} 字节`)
    this.name = 'InsufficientDiskSpaceError'
  }
}

export interface TaskDiskBudgetInput {
  inputVideoBytes: number
  videoCount: number
  deviceCount: number
  outputExpansionFactor: number
  perVideoRunOverheadBytes: number
  safetyReserveBytes: number
}

export interface TaskDiskBudget {
  inputBytes: number
  estimatedOutputBytes: number
  estimatedRunOverheadBytes: number
  safetyReserveBytes: number
  requiredAvailableBytes: number
}

/**
 * Estimates the free space that must still be available immediately before a task is created.
 * The expansion factor and per-run overhead are operational assumptions supplied by config;
 * they are intentionally not presented as measured properties of an APK.
 */
export function estimateTaskDiskBudget(input: TaskDiskBudgetInput): TaskDiskBudget {
  const runCount = multiplySafely(input.videoCount, input.deviceCount)
  const estimatedOutputBytes = multiplySafely(
    multiplySafely(input.inputVideoBytes, input.deviceCount),
    input.outputExpansionFactor,
  )
  const estimatedRunOverheadBytes = multiplySafely(runCount, input.perVideoRunOverheadBytes)
  const requiredAvailableBytes = addSafely(
    input.inputVideoBytes,
    estimatedOutputBytes,
    estimatedRunOverheadBytes,
    input.safetyReserveBytes,
  )
  return {
    inputBytes: input.inputVideoBytes,
    estimatedOutputBytes,
    estimatedRunOverheadBytes,
    safetyReserveBytes: input.safetyReserveBytes,
    requiredAvailableBytes,
  }
}

export async function assertDiskSpace(dataDir: string, minimumBytes: number) {
  const disk = await statfs(dataDir)
  const availableBytes = disk.bavail * disk.bsize
  if (availableBytes < minimumBytes) throw new InsufficientDiskSpaceError(availableBytes, minimumBytes)
  return availableBytes
}

function multiplySafely(left: number, right: number) {
  const value = Math.ceil(left * right)
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER
}

function addSafely(...values: number[]) {
  let total = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value) || total > Number.MAX_SAFE_INTEGER - value) return Number.MAX_SAFE_INTEGER
    total += value
  }
  return total
}
