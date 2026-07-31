export const MAX_APK_SIZE_BYTES = 1024 * 1024 * 1024
export const MAX_VIDEO_SIZE_BYTES = 4 * 1024 * 1024 * 1024

export type UploadArtifactKind = 'apk' | 'video'

export interface UploadFileLike {
  name: string
  type?: string
  size: number
}

/**
 * 前后端都还会再次校验文件；这里负责在浏览器选择文件时尽早给出可读提示。
 */
export function validateUploadFile(
  file: UploadFileLike,
  kind: UploadArtifactKind,
): string | undefined {
  if (!file.size) {
    return kind === 'apk' ? '不能选择空的 APK 文件' : '不能上传空 MP4'
  }

  const lowerName = file.name.toLowerCase()
  if (kind === 'apk' && !lowerName.endsWith('.apk')) {
    return '仅支持 APK 安装包'
  }

  if (
    kind === 'video' &&
    file.type !== 'video/mp4' &&
    !lowerName.endsWith('.mp4')
  ) {
    return '仅支持 MP4 视频素材'
  }

  if (kind === 'apk' && file.size > MAX_APK_SIZE_BYTES) {
    return 'APK 文件不能超过 1 GB'
  }

  if (kind === 'video' && file.size > MAX_VIDEO_SIZE_BYTES) {
    return 'MP4 文件不能超过 4 GB'
  }

  return undefined
}
