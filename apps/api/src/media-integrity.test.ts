import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from './config.js'
import { MediaIntegrityChecker } from './media-integrity.js'
import type { ProcessRunner } from './process.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

async function videoFile() {
  const directory = await mkdtemp(path.join(tmpdir(), 'media-integrity-'))
  directories.push(directory)
  const filePath = path.join(directory, 'output.mp4')
  await writeFile(filePath, 'not-empty')
  return filePath
}

function checker(runner: ProcessRunner) {
  return new MediaIntegrityChecker({
    runner,
    config: loadConfig({ HOME: '/tmp', CLOUD_TEST_DATA_DIR: '/tmp/media-integrity-data' }),
  })
}

describe('MediaIntegrityChecker', () => {
  it('记录 808 等元数据但不把它作为 Gate', async () => {
    const calls: string[] = []
    const result = await checker({
      async run(command) {
        const tool = path.basename(command)
        calls.push(tool)
        if (tool === 'ffprobe') return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            streams: [
              { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', nb_read_frames: '803' },
              { codec_type: 'audio', codec_name: 'aac' },
            ],
            format: { duration: '26.77', format_name: 'mov,mp4' },
          }),
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }).check(await videoFile())

    expect(result.status).toBe('passed')
    expect(result.metadata).toMatchObject({ frameCount: 803, width: 1920, hasAudio: true })
    expect(calls).toEqual(['ffprobe', 'ffmpeg'])
  })

  it('完整解码失败时返回明确失败', async () => {
    const result = await checker({
      async run(command) {
        if (path.basename(command) === 'ffprobe') return {
          code: 0, stderr: '',
          stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264' }], format: {} }),
        }
        throw new Error('invalid data at end of file')
      },
    }).check(await videoFile())
    expect(result).toMatchObject({ status: 'failed', failureCode: 'MEDIA_DECODE_FAILED' })
  })
})
