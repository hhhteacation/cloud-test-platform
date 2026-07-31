import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import type { MultipartFile } from '@fastify/multipart'

import { findApkExecutionProtocol } from './apk-protocols.js'
import { artifactsDir, config } from './config.js'
import { PlatformDatabase } from './database.js'
import { runProcess } from './process.js'
import type { ArtifactKind } from './types.js'

export class ArtifactValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

async function sha256File(filePath: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export class ArtifactService {
  constructor(private readonly database: PlatformDatabase) {}

  async saveUpload(part: MultipartFile, kind: ArtifactKind) {
    await mkdir(artifactsDir, { recursive: true })
    const storageKey = `store-${randomUUID()}`
    const temporaryDirectory = path.join(artifactsDir, '.tmp')
    const temporaryPath = path.join(temporaryDirectory, storageKey)
    await mkdir(temporaryDirectory, { recursive: true })

    try {
      await pipeline(part.file, createWriteStream(temporaryPath, { flags: 'wx' }))
      const fileStat = await stat(temporaryPath)
      if (part.file.truncated) {
        throw new ArtifactValidationError('上传文件超过大小限制', 'FILE_TOO_LARGE')
      }
      if (fileStat.size === 0) {
        throw new ArtifactValidationError('不能上传空文件', 'EMPTY_FILE')
      }

      const lowerName = part.filename.toLowerCase()
      if (kind === 'apk' && !lowerName.endsWith('.apk')) {
        throw new ArtifactValidationError('仅支持 APK 安装包', 'INVALID_APK_EXTENSION')
      }
      if (kind === 'video' && !lowerName.endsWith('.mp4') && part.mimetype !== 'video/mp4') {
        throw new ArtifactValidationError('仅支持 MP4 视频', 'INVALID_VIDEO_FORMAT')
      }
      const maxBytes = kind === 'apk' ? config.maxApkBytes : config.maxVideoBytes
      if (fileStat.size > maxBytes) {
        throw new ArtifactValidationError('上传文件超过允许大小', 'FILE_TOO_LARGE')
      }

      let packageName: string | undefined
      if (kind === 'apk') {
        packageName = await this.validateApk(temporaryPath)
      }

      const finalDirectory = path.join(artifactsDir, storageKey)
      const finalName = kind === 'apk' ? 'test.apk' : 'input.mp4'
      const finalPath = path.join(finalDirectory, finalName)
      await mkdir(finalDirectory, { recursive: true })
      await rename(temporaryPath, finalPath)
      const sha256 = await sha256File(finalPath)
      return this.database.insertArtifact({
        kind,
        originalName: path.basename(part.filename),
        mimeType: kind === 'apk' ? 'application/vnd.android.package-archive' : 'video/mp4',
        storagePath: finalPath,
        sizeBytes: fileStat.size,
        sha256,
        packageName,
      })
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }

  private async validateApk(apkPath: string) {
    let result
    try {
      result = await runProcess(config.aaptPath, ['dump', 'badging', apkPath], { timeoutMs: 30_000 })
    } catch (error) {
      throw new ArtifactValidationError(
        `无法读取 APK，请确认 Android Build Tools 36 已安装：${error instanceof Error ? error.message : String(error)}`,
        'INVALID_TEST_APK',
      )
    }
    const packageName = /package:\s+name='([^']+)'/.exec(result.stdout)?.[1]
    if (!packageName) {
      throw new ArtifactValidationError(
        'AAPT 未能从 APK 中读取 applicationId（包名）',
        'INVALID_TEST_APK',
      )
    }
    const protocol = findApkExecutionProtocol(packageName)
    if (!protocol) {
      throw new ArtifactValidationError(
        `AAPT 检测到 APK 包名为 ${packageName}，但后端尚未配置该 APK 的输入、启动、输出和完成判断协议`,
        'UNSUPPORTED_APK_PROTOCOL',
      )
    }
    return packageName
  }
}
