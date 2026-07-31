import { describe, expect, it } from 'vitest'

import {
  MAX_APK_SIZE_BYTES,
  MAX_VIDEO_SIZE_BYTES,
  validateUploadFile,
} from './uploadValidation'

describe('上传文件校验', () => {
  it('接受非空 APK 和 MP4', () => {
    expect(validateUploadFile({ name: 'carrier.apk', size: 10 }, 'apk')).toBeUndefined()
    expect(validateUploadFile({ name: 'input.mp4', type: 'video/mp4', size: 10 }, 'video')).toBeUndefined()
  })

  it('拒绝空文件和错误扩展名', () => {
    expect(validateUploadFile({ name: 'empty.apk', size: 0 }, 'apk')).toContain('空')
    expect(validateUploadFile({ name: 'input.txt', type: 'text/plain', size: 10 }, 'video')).toContain('MP4')
  })

  it('拒绝超过配置上限的文件', () => {
    expect(validateUploadFile({ name: 'huge.apk', size: MAX_APK_SIZE_BYTES + 1 }, 'apk')).toContain('1 GB')
    expect(validateUploadFile({ name: 'huge.mp4', size: MAX_VIDEO_SIZE_BYTES + 1 }, 'video')).toContain('4 GB')
  })
})
