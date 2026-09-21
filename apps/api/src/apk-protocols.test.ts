import { describe, expect, it } from 'vitest'

import {
  buildExecutionPaths,
  buildInstallPlan,
  buildLaunchArguments,
  buildWarmupLaunchArguments,
  findApkExecutionProtocol,
  parseMorphoLogLine,
  resolveBatchTimeoutSeconds,
  resolveProtocolTimeoutSeconds,
} from './apk-protocols.js'

describe('APK execution protocol registry', () => {
  it('recognizes the platform carrier protocol', () => {
    const protocol = findApkExecutionProtocol('com.sdktest.platform')
    expect(protocol?.id).toBe('platform-carrier-v1')
    expect(protocol?.launch.supportsTaskId).toBe(true)
    expect(protocol?.result.apkGeneratesResultJson).toBe(true)
    expect(protocol?.install.dialogAutomation).toBeUndefined()
    expect(protocol?.batch).toBeUndefined()
  })

  it('recognizes Morpho VideoPostProcessor and exposes its real capabilities', () => {
    const protocol = findApkExecutionProtocol('com.morphoinc.videopostprocessor')
    expect(protocol?.id).toBe('morpho-video-postprocessor-batch-v2')
    expect(protocol?.launch.supportsTaskId).toBe(false)
    expect(protocol?.launch.supportsAutoRun).toBe(false)
    expect(protocol?.launch.requiresUiInteraction).toBe(false)
    expect(protocol?.batch).toEqual({ mode: 'directory' })
    expect(protocol?.result.apkGeneratesResultJson).toBe(false)
    expect(protocol?.output.filePattern).toBe('*_stabilized.mp4')
    expect(protocol?.install.mode).toBe('clean')
    expect(protocol?.install.runtimePermissions).toEqual([
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
    ])
    expect(protocol?.install.dialogAutomation).toMatchObject({
      mode: 'strict-whitelist',
      maxActions: 5,
      unrecognizedGraceMs: 20_000,
    })
    expect(protocol?.install.dialogAutomation?.profileIds).toContain('oplus-package-installer-v1')
    expect(protocol?.install.dialogAutomation?.profileIds).toContain(
      'honor-safe-mode-install-sheet-v1',
    )
    expect(protocol?.install.dialogAutomation?.profileIds).toContain(
      'honor-magic-os-unreviewed-app-block-v1',
    )
    expect(protocol?.install.dialogAutomation?.profileIds).toContain(
      'honor-x50-magic-os-unreviewed-app-install-v1',
    )
    expect(protocol?.install.dialogAutomation?.profileIds).toContain(
      'honor-x50-unknown-source-warning-v1',
    )
    expect(protocol?.install.dialogAutomation?.profileIds).toContain(
      'honor-x50-icp-notice-v1',
    )
    expect(protocol?.install.dialogAutomation?.profileIds).toContain(
      'xiaomi-hyperos-package-installer-v1',
    )
    expect(protocol?.progress.logTags).toEqual([
      'MORPHO',
      'MorphoVideoPProc/Controller',
      'MorphoVideoPProc/Decoder',
      'MorphoVideoPProc/denoiser',
      'MorphoVideoPProc/Encoder',
      'MorphoVideoPProc/Interface',
      'MorphoVideoPProc/Parser',
      'MorphoVideoPProc/Sensor',
      'MorphoVideoPProc/Stabilizer',
      'MorphoVideoPProc/WDR',
      'MorphoVideoStabilizer',
    ])
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
    expect(parseMorphoLogLine('I/MORPHO: Starting batch processing for path: /input')).toMatchObject({
      progress: 48,
      businessStarted: true,
    })
    expect(parseMorphoLogLine(
      'D MorphoVideoPProc/Interface: Processing file 1/1: input.mp4',
    )).toMatchObject({ progress: 58, businessStarted: true })
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

  it('parses the directory-batch signals observed on real devices', () => {
    // Step 0 真机日志形态（2026-09-18 Honor/Xiaomi）。
    expect(parseMorphoLogLine(
      '09-18 16:39:32.561 15284 15335 I MORPHO  : Processing file 2/3: vid-b.mp4',
    )).toMatchObject({
      businessStarted: true,
      processingFile: { index: 2, total: 3, fileName: 'vid-b.mp4' },
    })
    expect(parseMorphoLogLine(
      '09-18 14:33:12.526 8893 11272 E MorphoVideoPProc/Controller: [PIPELINE] Received Error: module=VideoStabilizer failure=12 code=6 fatal=1 frame=59 msg=video_stabilizer SDK process failed',
    )).toMatchObject({
      pipelineFatal: 'video_stabilizer SDK process failed',
    })
    expect(parseMorphoLogLine(
      '09-18 14:33:12.540 8893  8893 I MORPHO  : BatchProcessService destroyed',
    )).toMatchObject({ serviceDestroyed: true })
    expect(parseMorphoLogLine(
      '09-18 16:41:10.758 15284 15335 I MORPHO  : Created completion marker file: /storage/emulated/0/Android/data/com.morphoinc.videopostprocessor/files/VideoStabilizerDataPack/.batch_processing_complete',
    )).toMatchObject({ markerCreated: true })
    // 非致命 pipeline 事件（fatal=0）不得当成失败。
    expect(parseMorphoLogLine(
      'E MorphoVideoPProc/Controller: [PIPELINE] Received Error: module=Decoder failure=1 code=2 fatal=0 frame=3 msg=recoverable',
    )).toBeUndefined()
  })

  it('scales the batch deadline by participating video count only for directory-batch protocols', () => {
    const morpho = findApkExecutionProtocol('com.morphoinc.videopostprocessor')!
    const carrier = findApkExecutionProtocol('com.sdktest.platform')!

    expect(resolveBatchTimeoutSeconds(morpho, 300, 4)).toBe(1_200)
    expect(resolveBatchTimeoutSeconds(morpho, 300, 1)).toBe(300)
    expect(resolveBatchTimeoutSeconds(carrier, 300, 4)).toBe(300)
    // 协议下限先按单视频生效，再乘视频数。
    expect(resolveBatchTimeoutSeconds(
      { ...morpho, completion: { ...morpho.completion, minimumTimeoutSeconds: 120 } },
      60,
      3,
    )).toBe(360)
    expect(resolveBatchTimeoutSeconds(carrier, 300, 0)).toBe(300)
  })
})
