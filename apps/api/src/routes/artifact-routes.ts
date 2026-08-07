import type { FastifyInstance } from 'fastify'

import { findApkExecutionProtocol, toPublicApkProtocol } from '../apk-protocols.js'
import {
  ArtifactService,
  ArtifactValidationError,
  InsufficientDiskSpaceError,
  UploadCapacityError,
} from '../artifacts.js'
import type { PlatformDatabase } from '../database.js'
import { sendVideoFile } from '../http-file.js'
import type { ArtifactKind, ArtifactRecord } from '../types.js'

function artifactResponse(artifact: ArtifactRecord) {
  const protocol = artifact.kind === 'apk' ? findApkExecutionProtocol(artifact.packageName) : undefined
  return {
    id: artifact.id, kind: artifact.kind, name: artifact.originalName,
    sizeBytes: artifact.sizeBytes, mimeType: artifact.mimeType, sha256: artifact.sha256,
    packageName: artifact.packageName,
    protocol: protocol ? toPublicApkProtocol(protocol) : undefined,
    previewUrl: artifact.kind === 'video' ? `/api/artifacts/${artifact.id}/content` : undefined,
  }
}

export function registerArtifactRoutes(app: FastifyInstance, database: PlatformDatabase, artifacts: ArtifactService) {
  app.post<{ Querystring: { kind?: string } }>('/api/artifacts', async (request, reply) => {
    const kind = request.query.kind as ArtifactKind | undefined
    if (kind !== 'apk' && kind !== 'video') return reply.code(400).send({ code: 'INVALID_ARTIFACT_KIND', message: 'kind 必须是 apk 或 video' })
    try {
      const part = await request.file()
      if (!part) return reply.code(400).send({ code: 'FILE_REQUIRED', message: '请选择要上传的文件' })
      const artifact = await artifacts.saveUpload(part, kind)
      return reply.code(201).send(artifactResponse(artifact))
    } catch (error) {
      if (error instanceof ArtifactValidationError) {
        return reply.code(error.code === 'FILE_TOO_LARGE' ? 413 : 400).send({ code: error.code, message: error.message })
      }
      if (error instanceof InsufficientDiskSpaceError) return reply.code(507).send({ code: error.code, message: error.message })
      if (error instanceof UploadCapacityError) return reply.code(429).send({ code: error.code, message: error.message })
      request.log.error(error)
      return reply.code(500).send({ code: 'ARTIFACT_UPLOAD_FAILED', message: error instanceof Error ? error.message : '文件上传失败' })
    }
  })

  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request, reply) => {
    const artifact = database.getArtifact(request.params.id)
    return artifact ? artifactResponse(artifact) : reply.code(404).send({ code: 'ARTIFACT_NOT_FOUND', message: '文件记录不存在' })
  })

  app.get<{ Params: { id: string } }>('/api/artifacts/:id/content', async (request, reply) => {
    const artifact = database.getArtifact(request.params.id)
    if (!artifact || artifact.kind !== 'video') return reply.code(404).send({ code: 'ARTIFACT_NOT_FOUND', message: '视频素材不存在' })
    return sendVideoFile(request, reply, artifact.storagePath)
  })
}
