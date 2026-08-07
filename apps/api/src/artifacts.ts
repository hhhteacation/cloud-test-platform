import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { MultipartFile } from '@fastify/multipart'

import { findApkExecutionProtocol } from './apk-protocols.js'
import { config as defaultConfig, type AppConfig } from './config.js'
import { PlatformDatabase } from './database.js'
import { BoundedProcessRunner, type ProcessRunner } from './process.js'
import { assertDiskSpace, InsufficientDiskSpaceError } from './storage-health.js'
import type { ArtifactKind } from './types.js'

export class ArtifactValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ArtifactValidationError'
  }
}

export class UploadCapacityError extends Error {
  readonly code = 'UPLOAD_CAPACITY_REACHED'
  constructor() {
    super('当前上传任务已达到并发上限，请稍后重试')
    this.name = 'UploadCapacityError'
  }
}

export { InsufficientDiskSpaceError }

class ByteLimitTransform extends Transform {
  private received = 0

  constructor(private readonly maxBytes: number) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.received += chunk.length
    if (this.received > this.maxBytes) {
      callback(new ArtifactValidationError(`上传文件超过允许大小 ${this.maxBytes} 字节`, 'FILE_TOO_LARGE'))
      return
    }
    callback(null, chunk)
  }
}

export async function sha256File(filePath: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface ArtifactStore {
  insertArtifact: PlatformDatabase['insertArtifact']
  listArtifactStoragePaths(): string[]
}

export interface ArtifactServiceOptions {
  config?: AppConfig
  processRunner?: ProcessRunner
  diskCheck?: typeof assertDiskSpace
}

export class ArtifactService {
  private readonly config: AppConfig
  private readonly processRunner: ProcessRunner
  private readonly diskCheck: typeof assertDiskSpace
  private activeUploads = 0

  constructor(
    private readonly database: ArtifactStore,
    options: ArtifactServiceOptions = {},
  ) {
    this.config = options.config ?? defaultConfig
    this.processRunner = options.processRunner ?? new BoundedProcessRunner({
      maxOutputBytes: this.config.maxProcessOutputBytes,
      killGraceMs: this.config.processKillGraceMs,
    })
    this.diskCheck = options.diskCheck ?? assertDiskSpace
  }

  async saveUpload(part: MultipartFile, kind: ArtifactKind) {
    if (this.activeUploads >= this.config.maxConcurrentUploads) throw new UploadCapacityError()
    this.activeUploads += 1
    try {
      return await this.persistUpload(part, kind)
    } finally {
      this.activeUploads -= 1
    }
  }

  async reportOrphans() {
    const knownDirectories = new Set(this.database.listArtifactStoragePaths().map((storagePath) => path.dirname(path.resolve(storagePath))))
    await mkdir(this.config.artifactsDir, { recursive: true })
    const entries = await readdir(this.config.artifactsDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('store-'))
      .map((entry) => path.join(this.config.artifactsDir, entry.name))
      .filter((directory) => !knownDirectories.has(path.resolve(directory)))
  }

  private async persistUpload(part: MultipartFile, kind: ArtifactKind) {
    await this.diskCheck(this.config.dataDir, this.config.minFreeDiskBytes)
    await mkdir(this.config.artifactsDir, { recursive: true })
    await mkdir(this.config.quarantineDir, { recursive: true })

    const storageKey = `store-${randomUUID()}`
    const temporaryPath = path.join(this.config.quarantineDir, storageKey)
    const finalDirectory = path.join(this.config.artifactsDir, storageKey)
    const maxBytes = kind === 'apk' ? this.config.maxApkBytes : this.config.maxVideoBytes

    try {
      await pipeline(part.file, new ByteLimitTransform(maxBytes), createWriteStream(temporaryPath, { flags: 'wx' }))
      const fileStat = await stat(temporaryPath)
      if (part.file.truncated) throw new ArtifactValidationError('上传文件超过大小限制', 'FILE_TOO_LARGE')
      if (fileStat.size === 0) throw new ArtifactValidationError('不能上传空文件', 'EMPTY_FILE')

      const lowerName = part.filename.toLowerCase()
      if (kind === 'apk' && !lowerName.endsWith('.apk')) {
        throw new ArtifactValidationError('仅支持 APK 安装包', 'INVALID_APK_EXTENSION')
      }
      if (kind === 'video' && !lowerName.endsWith('.mp4') && part.mimetype !== 'video/mp4') {
        throw new ArtifactValidationError('仅支持 MP4 视频', 'INVALID_VIDEO_FORMAT')
      }

      const packageName = kind === 'apk' ? await this.validateApk(temporaryPath) : undefined
      const sha256 = await sha256File(temporaryPath)
      const finalName = kind === 'apk' ? 'test.apk' : 'input.mp4'
      const finalPath = path.join(finalDirectory, finalName)
      await mkdir(finalDirectory, { recursive: false })
      await rename(temporaryPath, finalPath)

      try {
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
        await rm(finalDirectory, { recursive: true, force: true })
        throw error
      }
    } catch (error) {
      await rm(temporaryPath, { force: true })
      if (error instanceof ArtifactValidationError || error instanceof InsufficientDiskSpaceError) throw error
      if (part.file.truncated) throw new ArtifactValidationError('上传文件超过大小限制', 'FILE_TOO_LARGE')
      throw error
    }
  }

  private async validateApk(apkPath: string) {
    let result
    try {
      result = await this.processRunner.run(this.config.aaptPath, ['dump', 'badging', apkPath], { timeoutMs: 30_000 })
    } catch (error) {
      throw new ArtifactValidationError(
        `无法读取 APK，请确认 Android Build Tools 已安装：${error instanceof Error ? error.message : String(error)}`,
        'INVALID_TEST_APK',
      )
    }
    const packageName = /package:\s+name='([^']+)'/.exec(result.stdout)?.[1]
    if (!packageName) throw new ArtifactValidationError('AAPT 未能从 APK 中读取 applicationId（包名）', 'INVALID_TEST_APK')
    if (!findApkExecutionProtocol(packageName)) {
      throw new ArtifactValidationError(
        `AAPT 检测到 APK 包名为 ${packageName}，但后端尚未配置该 APK 的输入、启动、输出和完成判断协议`,
        'UNSUPPORTED_APK_PROTOCOL',
      )
    }
    return packageName
  }
}
