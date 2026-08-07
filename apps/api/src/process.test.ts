import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ProcessError, runProcess } from './process.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('runProcess', () => {
  it('限制 stdout 和 stderr 的内存占用', async () => {
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('a'.repeat(100)); process.stderr.write('b'.repeat(100))"], {
      maxOutputBytes: 16,
    })
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(16)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stdoutBytes).toBe(100)
    expect(result.stderrBytes).toBe(100)
  })

  it('在内存截断时仍把完整 stdout/stderr 写入 Evidence 文件', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloud-test-process-evidence-'))
    temporaryDirectories.push(directory)
    const stdoutPath = path.join(directory, 'stdout.txt')
    const stderrPath = path.join(directory, 'stderr.txt')

    const result = await runProcess(
      process.execPath,
      ['-e', "process.stdout.write('a'.repeat(100)); process.stderr.write('b'.repeat(100))"],
      { maxOutputBytes: 16, captureStdoutPath: stdoutPath, captureStderrPath: stderrPath },
    )

    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(await readFile(stdoutPath, 'utf8')).toBe('a'.repeat(100))
    expect(await readFile(stderrPath, 'utf8')).toBe('b'.repeat(100))
  })

  it('超时后返回包含已收集输出的错误，并完成 Evidence 文件写入', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloud-test-process-timeout-'))
    temporaryDirectories.push(directory)
    const stdoutPath = path.join(directory, 'stdout.txt')
    let caught: unknown
    try {
      await runProcess(process.execPath, ['-e', "process.stdout.write('started\\n'); setInterval(() => {}, 1000)"], {
        timeoutMs: 50,
        killGraceMs: 10,
        captureStdoutPath: stdoutPath,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject<Partial<ProcessError>>({
      command: process.execPath,
      result: expect.objectContaining({ stdout: 'started\n' }),
    })
    await expect(readFile(stdoutPath, 'utf8')).resolves.toBe('started\n')
  })

  it('把 Evidence 路径错误作为明确的 ProcessError 返回', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloud-test-process-capture-error-'))
    temporaryDirectories.push(directory)
    await expect(runProcess(process.execPath, ['-e', "setTimeout(() => {}, 1000)"], {
      captureStdoutPath: path.join(directory, 'missing', 'stdout.txt'),
      killGraceMs: 10,
    })).rejects.toMatchObject<Partial<ProcessError>>({
      message: expect.stringContaining('Evidence 写入失败'),
      command: process.execPath,
    })
  })
})
