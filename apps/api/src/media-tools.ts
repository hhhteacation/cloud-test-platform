import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'

function bundledToolPath(path: string | undefined, command: string) {
  return path?.trim() || command
}

export const bundledMediaTools = {
  ffmpegPath: bundledToolPath(ffmpegInstaller.path, 'ffmpeg'),
  ffprobePath: bundledToolPath(ffprobeInstaller.path, 'ffprobe'),
} as const
