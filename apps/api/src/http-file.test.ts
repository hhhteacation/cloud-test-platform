import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sendVideoFile } from './http-file.js'

describe('视频文件 HTTP Range 响应', () => {
  let directory: string
  let filePath: string
  let app: FastifyInstance

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'sdk-video-range-'))
    filePath = path.join(directory, 'output.mp4')
    await writeFile(filePath, Buffer.from('0123456789'))
    app = Fastify()
    app.get('/video', (request, reply) => sendVideoFile(request, reply, filePath))
  })

  afterEach(async () => {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('无 Range 时返回完整文件', async () => {
    const response = await app.inject({ method: 'GET', url: '/video' })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('0123456789')
    expect(response.headers['accept-ranges']).toBe('bytes')
  })

  it('合法 Range 返回 206 和指定字节', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/video',
      headers: { range: 'bytes=2-5' },
    })
    expect(response.statusCode).toBe(206)
    expect(response.body).toBe('2345')
    expect(response.headers['content-range']).toBe('bytes 2-5/10')
  })

  it('越界 Range 返回 416', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/video',
      headers: { range: 'bytes=20-30' },
    })
    expect(response.statusCode).toBe(416)
    expect(response.headers['content-range']).toBe('bytes */10')
  })
})
