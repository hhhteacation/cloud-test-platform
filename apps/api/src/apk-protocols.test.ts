import { describe, expect, it } from 'vitest'

import {
  buildExecutionPaths,
  buildInstallPlan,
  buildLaunchArguments,
  buildWarmupLaunchArguments,
  findApkExecutionProtocol,
  parseMorphoLogLine,
  resolveProtocolTimeoutSeconds,
} from './apk-protocols.js'

describe('APK execution protocol registry', () => {
  it('recognizes the platform carrier protocol', () => {
    const protocol = findApkExecutionProtocol('com.sdktest.platform')
    expect(protocol?.id).toBe('platform-carrier-v1')
    expect(protocol?.launch.supportsTaskId).toBe(true)
    expect(protocol?.result.apkGeneratesResultJson).toBe(true)
  })

  it('recognizes Morpho VideoPostProcessor and exposes its real capabilities', () => {
    const protocol = findApkExecutionProtocol('com.morphoinc.videopostprocessor')
    expect(protocol?.id).toBe('morpho-video-postprocessor-batch-v2')
    expect(protocol?.launch.supportsTaskId).toBe(false)
    expect(protocol?.launch.supportsAutoRun).toBe(false)
    expect(protocol?.launch.requiresUiInteraction).toBe(false)
    expect(protocol?.result.apkGeneratesResultJson).toBe(false)
    expect(protocol?.output.filePattern).toBe('*_stabilized.mp4')
    expect(protocol?.install.mode).toBe('clean')
    expect(protocol?.install.runtimePermissions).toEqual([
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
    ])
    expect(protocol?.install.dialogAutomation).toMatchObject({
      mode: 'strict-whitelist',
      maxActions: 4,
      unrecognizedGraceMs: 20_000,
    })
    expect(protocol?.install.dialogAutomation?.profileIds).toContain('oplus-package-installer-v1')
  })

  it('does not pretend an unknown APK has an executable protocol', () => {
    expect(findApkExecutionProtocol('com.example.unknown')).toBeUndefined()
  })

  it('builds Morpho input, marker, output and launch arguments', () => {
    const protocol = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const paths = buildExecutionPaths(protocol, {
      taskId: 'task-123',
      manufacturer: 'HONOR',
      model: 'FCP-AN10',
      inputFileName: 'test.mp4',
    })

    expect(paths.remoteInputDirectory).toBe(
      '/storage/emulated/0/Android/data/com.morphoinc.videopostprocessor/files/VideoStabilizerDataPack',
    )
    expect(paths.remoteInputFile).toBe(`${paths.remoteInputDirectory}/test.mp4`)
    expect(paths.remoteCompletionPath).toBe(
      '/storage/emulated/0/Android/data/com.morphoinc.videopostprocessor/files/VideoStabilizerDataPack/.batch_processing_complete',
    )
    expect(paths.remoteOutputFile).toBe(
      '/storage/emulated/0/Android/data/com.morphoinc.videopostprocessor/files/VideoStabilizerDataPack/stabilized/HONOR_FCP-AN10_test_stabilized.mp4',
    )
    expect(buildWarmupLaunchArguments(protocol)).toEqual([
      'shell', 'am', 'start', 'com.morphoinc.videopostprocessor/.MainActivity',
    ])
    expect(buildInstallPlan(protocol, '/tmp/demo.apk')).toEqual({
      uninstallPackage: 'com.morphoinc.videopostprocessor',
      installArguments: ['install', '/tmp/demo.apk'],
    })
    expect(buildLaunchArguments(protocol, paths, 'task-123')).toEqual([
      'shell', 'am', 'start',
      '-a', 'com.morphoinc.videopostprocessor.ACTION_BATCH_PROCESS',
      '--es', 'material_path', paths.remoteInputDirectory,
      'com.morphoinc.videopostprocessor/.MainActivity',
    ])
    expect(protocol.output.appCreatesDirectory).toBe(true)
    expect(protocol.output.clearDirectoryBeforeRun).toBe(false)
    expect(resolveProtocolTimeoutSeconds(protocol, 300)).toBe(300)
  })

  it('sanitizes an uploaded MP4 name without changing the Demo material directory', () => {
    const protocol = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const paths = buildExecutionPaths(protocol, {
      taskId: 'task-123',
      manufacturer: 'vivo',
      model: 'V2324A',
      inputFileName: '../测试 video (1).mp4',
    })

    expect(paths.remoteInputDirectory).toBe(
      '/storage/emulated/0/Android/data/com.morphoinc.videopostprocessor/files/VideoStabilizerDataPack',
    )
    expect(paths.remoteInputFile).toBe(`${paths.remoteInputDirectory}/_video_1_.mp4`)
    expect(paths.remoteOutputFile).toBe(
      `${paths.remoteOutputDirectory}/vivo_V2324A__video_1__stabilized.mp4`,
    )
  })

  it('maps Morpho log lines to progress and failures', () => {
    expect(parseMorphoLogLine('I/MORPHO: Starting batch processing for path: /input')).toMatchObject({ progress: 48 })
    expect(parseMorphoLogLine('I/MORPHO: Processing file 1/1: input.mp4')).toMatchObject({ progress: 58 })
    expect(parseMorphoLogLine(
      'I/MORPHO: Output: /storage/emulated/0/Android/data/com.morphoinc.videopostprocessor/files/VideoStabilizerDataPack/stabilized/vivo_V2324A_test_stabilized.mp4',
    )).toMatchObject({
      progress: 68,
      outputPath: '/storage/emulated/0/Android/data/com.morphoinc.videopostprocessor/files/VideoStabilizerDataPack/stabilized/vivo_V2324A_test_stabilized.mp4',
    })
    expect(parseMorphoLogLine('E/MORPHO: Error processing file: native init failed')).toMatchObject({
      failureMessage: 'native init failed',
    })
  })
})
