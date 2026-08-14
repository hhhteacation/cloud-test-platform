import { describe, expect, it } from 'vitest'

import { estimateTaskDiskBudget } from './storage-health.js'

describe('estimateTaskDiskBudget', () => {
  it('按输入、设备输出、视频运行开销和安全余量计算动态预算', () => {
    expect(estimateTaskDiskBudget({
      inputVideoBytes: 1_000,
      videoCount: 2,
      deviceCount: 3,
      outputExpansionFactor: 1.5,
      perVideoRunOverheadBytes: 100,
      safetyReserveBytes: 2_000,
    })).toEqual({
      inputBytes: 1_000,
      estimatedOutputBytes: 4_500,
      estimatedRunOverheadBytes: 600,
      safetyReserveBytes: 2_000,
      requiredAvailableBytes: 8_100,
    })
  })

  it('预算溢出时饱和到安全整数上限而不是产生不可靠数值', () => {
    expect(estimateTaskDiskBudget({
      inputVideoBytes: Number.MAX_SAFE_INTEGER,
      videoCount: 10,
      deviceCount: 10,
      outputExpansionFactor: 2,
      perVideoRunOverheadBytes: Number.MAX_SAFE_INTEGER,
      safetyReserveBytes: 1,
    }).requiredAvailableBytes).toBe(Number.MAX_SAFE_INTEGER)
  })
})
