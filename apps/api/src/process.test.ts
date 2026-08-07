import { describe, expect, it } from 'vitest'

import { ProcessError, runProcess } from './process.js'

describe('runProcess', () => {
  it('限制 stdout 和 stderr 的内存占用', async () => {
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('a'.repeat(100)); process.stderr.write('b'.repeat(100))"], {
      maxOutputBytes: 16,
    })
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(16)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
  })

  it('超时后返回包含已收集输出的错误', async () => {
    await expect(runProcess(process.execPath, ['-e', "console.log('started'); setInterval(() => {}, 1000)"], {
      timeoutMs: 50,
      killGraceMs: 10,
    })).rejects.toMatchObject<Partial<ProcessError>>({
      command: process.execPath,
    })
  })
})
