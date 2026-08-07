import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { FastifyReply, FastifyRequest } from 'fastify'

export async function sendVideoFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  options: { downloadName?: string } = {},
) {
  const fileStat = await stat(filePath)
  const range = request.headers.range
  reply.header('Accept-Ranges', 'bytes')
  reply.header('Content-Type', 'video/mp4')
  if (options.downloadName) {
    reply.header('Content-Disposition', `attachment; filename="${path.basename(options.downloadName)}"`)
  }

  if (!range) {
    reply.header('Content-Length', fileStat.size)
    return reply.send(createReadStream(filePath))
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!match) return reply.code(416).send({ code: 'INVALID_RANGE', message: '无效的视频 Range 请求' })
  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''
  if (!hasStart && !hasEnd) {
    reply.header('Content-Range', `bytes */${fileStat.size}`)
    return reply.code(416).send()
  }

  let start: number
  let end: number
  if (!hasStart) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      reply.header('Content-Range', `bytes */${fileStat.size}`)
      return reply.code(416).send()
    }
    start = Math.max(0, fileStat.size - suffixLength)
    end = fileStat.size - 1
  } else {
    start = Number(match[1])
    end = hasEnd ? Number(match[2]) : fileStat.size - 1
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= fileStat.size) {
    reply.header('Content-Range', `bytes */${fileStat.size}`)
    return reply.code(416).send()
  }
  const safeEnd = Math.min(end, fileStat.size - 1)
  reply.code(206)
  reply.header('Content-Range', `bytes ${start}-${safeEnd}/${fileStat.size}`)
  reply.header('Content-Length', safeEnd - start + 1)
  return reply.send(createReadStream(filePath, { start, end: safeEnd }))
}
