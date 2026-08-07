import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { AdbStreams, type LogcatStreamEvent } from './adb-streams.js'

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('等待 ADB 流输出超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function fakeAdb(root: string) {
  const script = path.join(root, 'fake-adb.sh')
  await writeFile(script, `#!/bin/sh
case "$*" in
  *logcat*)
    i=0
    while [ "$i" -lt 100 ]; do
      echo "SDK_COMPAT: very-long-log-line-$i-abcdefghijklmnopqrstuvwxyz"
      i=$((i + 1))
    done
    sleep 30
    ;;
  *screencap*)
    printf 'partial-png'
    exit 7
    ;;
esac
exit 0
`)
  await chmod(script, 0o755)
  return script
}

describe('AdbStreams', () => {
  it('使用原生 Tag 白名单采集业务日志且不启用全量 Verbose', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adb-threadtime-'))
    const adbPath = path.join(root, 'fake-adb.sh')
    const argumentsPath = path.join(root, 'arguments.txt')
    await writeFile(adbPath, `#!/bin/sh
printf '%s' "$*" > "${argumentsPath}"
echo "07-31 16:10:45.503 15420 16119 D MorphoVideoPProc/Interface: Start processing..."
echo "07-31 16:10:45.515 15420 16119 I ActivityManager: unrelated line"
echo "07-31 16:10:45.516 15420 16119 V SDK_COMPAT: {\\"progress\\":50}"
exec sleep 30
`)
    await chmod(adbPath, 0o755)
    const target = path.join(root, 'logcat.txt')
    const received: string[] = []
    const streams = new AdbStreams(adbPath, 'serial-1', undefined, { killGraceMs: 10 })
    const stop = await streams.startLogcat(
      'run-1', target, new AbortController().signal,
      ['MORPHO', 'MorphoVideoPProc/Interface'],
      (line) => received.push(line),
    )

    await waitFor(async () => received.length === 3)
    await stop()

    expect(await readFile(argumentsPath, 'utf8')).toBe(
      '-s serial-1 logcat -T 1 -v threadtime MORPHO:V MorphoVideoPProc/Interface:V *:S',
    )
    expect(received).toHaveLength(3)
    const content = await readFile(target, 'utf8')
    expect(content).toContain('MorphoVideoPProc/Interface')
    expect(content).toContain('ActivityManager: unrelated line')
    expect(content).toContain('SDK_COMPAT')
  })

  it('达到独立容量上限时只停止当前抓取并写入明确标记', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adb-streams-'))
    const adbPath = await fakeAdb(root)
    const targetDir = path.join(root, 'logs')
    await mkdir(targetDir)
    const target = path.join(targetDir, 'logcat.txt')
    const events: LogcatStreamEvent[] = []
    const streams = new AdbStreams(adbPath, 'serial-1', undefined, { maxLogBytes: 64, killGraceMs: 10 })
    const stop = await streams.startLogcat(
      'run-1', target, new AbortController().signal, ['MORPHO'],
      () => undefined, (event) => events.push(event), 64,
    )

    await waitFor(async () => (await readFile(target, 'utf8').catch(() => '')).includes('LOGCAT_TRUNCATED'))
    await stop()
    const content = await readFile(target, 'utf8')
    expect(content).toContain('LOGCAT_TRUNCATED')
    expect(events).toContainEqual({ type: 'truncated', maxBytes: 64 })
    expect(Buffer.byteLength(content)).toBeLessThan(256)
  })

  it('自然退出时保留文件并报告 LOGCAT_PROCESS_EXITED，停止函数仍可安全调用', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adb-process-exit-'))
    const adbPath = path.join(root, 'fake-adb.sh')
    await writeFile(adbPath, `#!/bin/sh
printf 'ActivityManager: process exited test\n'
printf 'adb diagnostic\n' >&2
exit 7
`)
    await chmod(adbPath, 0o755)
    const target = path.join(root, 'logcat.txt')
    const events: LogcatStreamEvent[] = []
    const streams = new AdbStreams(adbPath, 'serial-exit', undefined, { killGraceMs: 10 })
    const stop = await streams.startLogcat(
      'run-exit', target, new AbortController().signal, ['MORPHO'],
      () => undefined, (event) => events.push(event),
    )

    await waitFor(async () => events.some((event) => event.type === 'process_exited'))
    await stop()
    await stop()

    expect(await readFile(target, 'utf8')).toContain('ActivityManager: process exited test')
    expect(events).toContainEqual(expect.objectContaining({
      type: 'process_exited', code: 7, stderr: 'adb diagnostic',
    }))
  })

  it('停止一个设备的抓取不会停止另一个设备的独立子进程', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adb-isolation-'))
    const adbPath = path.join(root, 'fake-adb.sh')
    await writeFile(adbPath, `#!/bin/sh
i=0
while true; do
  echo "$2 line-$i"
  i=$((i + 1))
  sleep 0.02
done
`)
    await chmod(adbPath, 0o755)
    const targetA = path.join(root, 'a.log')
    const targetB = path.join(root, 'b.log')
    const streamA = new AdbStreams(adbPath, 'device-A', undefined, { killGraceMs: 10 })
    const streamB = new AdbStreams(adbPath, 'device-B', undefined, { killGraceMs: 10 })
    const stopA = await streamA.startLogcat(
      'run-A', targetA, new AbortController().signal, ['MORPHO'], () => undefined,
    )
    const stopB = await streamB.startLogcat(
      'run-B', targetB, new AbortController().signal, ['MORPHO'], () => undefined,
    )

    await waitFor(async () => (await stat(targetB)).size > 0)
    await stopA()
    const before = (await stat(targetB)).size
    await waitFor(async () => (await stat(targetB)).size > before)
    await stopB()

    expect(await readFile(targetA, 'utf8')).toContain('device-A')
    expect(await readFile(targetB, 'utf8')).toContain('device-B')
  })

  it('一次性保存全量失败快照并使用独立容量上限', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adb-logcat-snapshot-'))
    const adbPath = path.join(root, 'fake-adb.sh')
    const argumentsPath = path.join(root, 'arguments.txt')
    await writeFile(adbPath, `#!/bin/sh
printf '%s' "$*" > "${argumentsPath}"
printf 'system failure context line 1\nsystem failure context line 2\n'
`)
    await chmod(adbPath, 0o755)
    const target = path.join(root, 'diagnostics', 'logcat-full-failure.txt')
    const streams = new AdbStreams(adbPath, 'serial-snapshot', undefined, { killGraceMs: 10 })

    await streams.captureLogcatSnapshot(
      'run-snapshot', target, new AbortController().signal, 32,
    )

    expect(await readFile(argumentsPath, 'utf8')).toBe(
      '-s serial-snapshot logcat -d -b all -v threadtime',
    )
    const content = await readFile(target, 'utf8')
    expect(content).toContain('LOGCAT_TRUNCATED')
    expect(Buffer.byteLength(content)).toBeLessThan(256)
  })

  it('截图命令失败时删除半文件', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adb-screenshot-'))
    const adbPath = await fakeAdb(root)
    const target = path.join(root, 'screenshots', 'failed.png')
    const streams = new AdbStreams(adbPath, 'serial-1', undefined, { killGraceMs: 10 })

    await expect(streams.captureScreenshot('task-1', target, new AbortController().signal)).rejects.toThrow('截图失败')
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
