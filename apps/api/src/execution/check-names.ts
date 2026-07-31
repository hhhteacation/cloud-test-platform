const CHECK_NAMES: Record<string, string> = {
  launch: '应用启动',
  input: '输入 MP4 校验',
  sdk_init: 'SDK 初始化',
  processing: 'SDK 视频处理',
  output_generated: '输出 MP4 生成',
  output_load: '输出视频加载',
  first_frame: '输出首帧展示',
  play: '开始播放',
  continuous: '连续播放 5 秒',
  pause: '暂停',
  resume: '恢复播放',
  seek: '进度拖动',
  loop: '循环播放',
  rotation: '旋转后继续播放',
  complete: '播放完成',
  no_crash: '全过程无崩溃',
}

export function getCheckName(key: string) {
  return CHECK_NAMES[key] ?? key
}
