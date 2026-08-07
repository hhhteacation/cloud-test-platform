import { stat } from 'node:fs/promises'

import { config as defaultConfig, type AppConfig } from './config.js'
import { BoundedProcessRunner, type ProcessRunner } from './process.js'
import type { MediaIntegrityResult, MediaMetadata } from './types.js'

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  nb_read_frames?: string
  nb_frames?: string
  duration?: string
}

interface ProbeOutput {
  streams?: ProbeStream[]
  format?: { duration?: string; format_name?: string }
}

function numeric(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function frameRate(value: string | undefined) {
  if (!value) return undefined
  const [numerator, denominator] = value.split('/').map(Number)
  if (!Number.isFinite(numerator)) return undefined
  if (!denominator) return numerator
  return numerator / denominator
}

export class MediaIntegrityChecker {
  private readonly runner: ProcessRunner
  private readonly config: AppConfig

  constructor(options: { runner?: ProcessRunner; config?: AppConfig } = {}) {
    this.config = options.config ?? defaultConfig
    this.runner = options.runner ?? new BoundedProcessRunner({
      maxOutputBytes: this.config.maxProcessOutputBytes,
      killGraceMs: this.config.processKillGraceMs,
    })
  }

  async check(filePath: string, signal?: AbortSignal): Promise<MediaIntegrityResult> {
    const file = await stat(filePath).catch(() => undefined)
    if (!file || file.size <= 0) return this.failed('MEDIA_EMPTY_FILE', '输出视频不存在或为空')

    let probe: ProbeOutput
    try {
      const result = await this.runner.run(this.config.ffprobePath, [
        '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', filePath,
      ], { signal, timeoutMs: 120_000 })
      probe = JSON.parse(result.stdout) as ProbeOutput
    } catch (error) {
      return this.failed('MEDIA_PROBE_FAILED', `FFprobe 无法读取输出视频：${error instanceof Error ? error.message : String(error)}`)
    }

    const video = probe.streams?.find((stream) => stream.codec_type === 'video')
    if (!video) return this.failed('MEDIA_VIDEO_STREAM_MISSING', '输出文件中没有可识别的视频流')
    const audio = probe.streams?.find((stream) => stream.codec_type === 'audio')
    const metadata: MediaMetadata = {
      sizeBytes: file.size,
      container: probe.format?.format_name,
      videoCodec: video.codec_name,
      width: numeric(video.width),
      height: numeric(video.height),
      frameRate: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate),
      frameCount: numeric(video.nb_read_frames) ?? numeric(video.nb_frames),
      durationSeconds: numeric(video.duration) ?? numeric(probe.format?.duration),
      hasAudio: Boolean(audio),
      audioCodec: audio?.codec_name,
    }

    try {
      await this.runner.run(this.config.ffmpegPath, [
        '-v', 'error', '-xerror', '-i', filePath, '-map', '0:v:0', '-f', 'null', '-',
      ], { signal, timeoutMs: 30 * 60_000 })
    } catch (error) {
      return this.failed(
        'MEDIA_DECODE_FAILED',
        `输出视频无法完整解码，可能已损坏或截断：${error instanceof Error ? error.message : String(error)}`,
        metadata,
      )
    }

    return { status: 'passed', message: '容器、视频流和完整解码检查通过', metadata }
  }

  private failed(failureCode: string, message: string, metadata?: MediaMetadata): MediaIntegrityResult {
    return { status: 'failed', failureCode, message, metadata }
  }
}
