import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactService, ArtifactValidationError } from './artifacts.js'
import { loadConfig } from './config.js'
import type { ArtifactRecord } from './types.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

async function fixture(maxVideoBytes = 8) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'artifact-service-'))
  directories.push(dataDir)
  const records: ArtifactRecord[] = []
  const config = loadConfig({
    HOME: '/tmp', CLOUD_TEST_DATA_DIR: dataDir,
    MAX_VIDEO_BYTES: String(maxVideoBytes), MAX_APK_BYTES: '8',
    MIN_FREE_DISK_BYTES: '1', MAX_CONCURRENT_UPLOADS: '1',
  })
  const service = new ArtifactService({
    insertArtifact(input) {
      const record = { ...input, id: 'artifact-1', createdAt: new Date().toISOString() }
      records.push(record)
      return record
    },
    listArtifactStoragePaths: () => records.map((record) => record.storagePath),
  }, { config, diskCheck: async () => 1024 })
  return { service, config, records }
}

function multipartFile(contents: string, filename = 'input.mp4') {
  const file = Readable.from([Buffer.from(contents)]) as any
  file.truncated = false
  return { file, filename, mimetype: 'video/mp4' } as any
}

describe('ArtifactService', () => {
  it('在流式写入阶段拒绝超限文件且不留下孤儿目录', async () => {
    const { service, config } = await fixture(4)
    await expect(service.saveUpload(multipartFile('12345'), 'video')).rejects.toBeInstanceOf(ArtifactValidationError)
    await expect(readdir(config.artifactsDir)).resolves.toEqual([])
    await expect(readdir(config.quarantineDir)).resolves.toEqual([])
  })

  it('数据库写入失败时删除已经移动的正式文件', async () => {
    const { service, config } = await fixture(8)
    const failing = new ArtifactService({
      insertArtifact() { throw new Error('db failed') },
      listArtifactStoragePaths: () => [],
    }, { config, diskCheck: async () => 1024 })
    await expect(failing.saveUpload(multipartFile('1234'), 'video')).rejects.toThrow('db failed')
    await expect(readdir(config.artifactsDir)).resolves.toEqual([])
  })
})
