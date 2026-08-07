import { statfs } from 'node:fs/promises'

export class InsufficientDiskSpaceError extends Error {
  readonly code = 'INSUFFICIENT_DISK_SPACE'
  constructor(readonly availableBytes: number, readonly minimumBytes: number) {
    super(`磁盘可用空间不足：当前 ${availableBytes} 字节，最低要求 ${minimumBytes} 字节`)
    this.name = 'InsufficientDiskSpaceError'
  }
}

export async function assertDiskSpace(dataDir: string, minimumBytes: number) {
  const disk = await statfs(dataDir)
  const availableBytes = disk.bavail * disk.bsize
  if (availableBytes < minimumBytes) throw new InsufficientDiskSpaceError(availableBytes, minimumBytes)
  return availableBytes
}
