export type ApkProtocolProgressMode = 'structured_log' | 'logcat_pattern'
export type ApkProtocolCompletionMode = 'result_json' | 'marker_file'

export interface ApkDialogAutomationConfig {
  mode: 'none' | 'strict-whitelist'
  profileIds: string[]
  timeoutMs: number
  pollIntervalMs: number
  maxActions: number
  /**
   * OEM installers often render a scanning/loading state before their buttons
   * become actionable. Keep refusing to click, but allow that state to settle
   * before classifying the stable UI as an unknown dialog.
   */
  unrecognizedGraceMs?: number
}

export interface ApkExecutionProtocol {
  id: string
  name: string
  packageName: string
  launchActivity: string
  requiresRunAs: boolean
  install: {
    mode: 'replace' | 'clean'
    description: string
    runtimePermissions?: string[]
    dialogAutomation?: ApkDialogAutomationConfig
  }
  input: {
    description: string
    remoteDirectoryTemplate: string
    fileName: string
    preserveOriginalFileName?: boolean
    launchValue: 'input_file' | 'input_directory'
  }
  launch: {
    description: string
    action?: string
    supportsTaskId: boolean
    supportsAutoRun: boolean
    requiresUiInteraction: boolean
    warmupBeforeTransferMs?: number
    postLaunchDialogAutomation?: ApkDialogAutomationConfig
  }
  output: {
    description: string
    remoteDirectoryTemplate: string
    filePattern: string
    fixedFileName?: string
    appCreatesDirectory?: boolean
    clearDirectoryBeforeRun?: boolean
  }
  progress: {
    mode: ApkProtocolProgressMode
    description: string
    logTag: string
    /** Tags or tag prefixes that should be retained from the threadtime logcat stream. */
    logTags?: readonly string[]
  }
  completion: {
    mode: ApkProtocolCompletionMode
    description: string
    remotePathTemplate: string
    /** Only use this when the APK vendor explicitly documents a hard minimum. */
    minimumTimeoutSeconds?: number
  }
  failure: {
    description: string
  }
  result: {
    apkGeneratesResultJson: boolean
    description: string
    remotePathTemplate?: string
  }
  cancellation: {
    mode: 'force_stop'
    description: string
  }
}

export interface ExecutionPathContext {
  taskId: string
  manufacturer?: string
  model?: string
  inputFileName?: string
}

export interface ApkExecutionPaths {
  remoteTaskRoot: string
  remoteInputDirectory: string
  remoteInputFile: string
  remoteOutputDirectory: string
  remoteOutputFile: string
  remoteCompletionPath: string
  remoteResultFile?: string
}

const PLATFORM_CARRIER_PROTOCOL: ApkExecutionProtocol = {
  id: 'platform-carrier-v1',
  name: 'SDK Test Platform 测试载体协议 v1',
  packageName: 'com.sdktest.platform',
  launchActivity: 'com.sdktest.platform/.MainActivity',
  requiresRunAs: true,
  install: {
    mode: 'replace',
    description: '保留应用数据并使用 adb install -r -t 更新测试载体。',
  },
  input: {
    description: '后端把 MP4 推送到 APK 专属 files/tasks/{taskId}/input/input.mp4。',
    remoteDirectoryTemplate: '/sdcard/Android/data/{packageName}/files/tasks/{taskId}/input',
    fileName: 'input.mp4',
    launchValue: 'input_file',
  },
  launch: {
    description: '启动 MainActivity，并传入 task_id 和 auto_run=true。',
    supportsTaskId: true,
    supportsAutoRun: true,
    requiresUiInteraction: false,
  },
  output: {
    description: 'APK 固定生成 files/tasks/{taskId}/output/output.mp4。',
    remoteDirectoryTemplate: '/sdcard/Android/data/{packageName}/files/tasks/{taskId}/output',
    filePattern: 'output.mp4',
    fixedFileName: 'output.mp4',
  },
  progress: {
    mode: 'structured_log',
    description: '读取 SDK_COMPAT 标签下包含 taskId、progress 和 checkKey 的 JSON 日志。',
    logTag: 'SDK_COMPAT',
  },
  completion: {
    mode: 'result_json',
    description: 'result/result.json 出现且 taskId 与当前任务一致时认为 APK 已返回最终结果。',
    remotePathTemplate: '/sdcard/Android/data/{packageName}/files/tasks/{taskId}/result/result.json',
  },
  failure: {
    description: '读取 result.json 的 failureCode/failureMessage，并结合进程退出、超时和输出文件校验。',
  },
  result: {
    apkGeneratesResultJson: true,
    description: 'APK 生成机器可读 result.json。',
    remotePathTemplate: '/sdcard/Android/data/{packageName}/files/tasks/{taskId}/result/result.json',
  },
  cancellation: {
    mode: 'force_stop',
    description: '终止 ADB 子进程并执行 am force-stop com.sdktest.platform。',
  },
}

const MORPHO_PROTOCOL: ApkExecutionProtocol = {
  id: 'morpho-video-postprocessor-batch-v2',
  name: 'Morpho VideoPostProcessor 批处理协议 v2',
  packageName: 'com.morphoinc.videopostprocessor',
  launchActivity: 'com.morphoinc.videopostprocessor/.MainActivity',
  requiresRunAs: false,
  install: {
    mode: 'clean',
    description: '与 Demo batch_process.sh 一致：先卸载旧包，再全新安装，避免缓存和旧数据影响批处理。',
    runtimePermissions: [
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
    ],
    dialogAutomation: {
      mode: 'strict-whitelist',
      profileIds: [
        'vivo-package-installer-v1',
        'honor-package-installer-v1',
        'honor-x50-unknown-source-warning-v1',
        'honor-x50-icp-notice-v1',
        'honor-safe-mode-install-sheet-v1',
        'honor-x50-magic-os-unreviewed-app-install-v1',
        'honor-magic-os-unreviewed-app-block-v1',
        'xiaomi-hyperos-package-installer-v1',
        'oplus-package-installer-v1',
        'oplus-package-installer-risk-v2',
        'oplus-package-installer-finish-v1',
        'android-runtime-permission-v1',
      ],
      timeoutMs: 120_000,
      pollIntervalMs: 500,
      maxActions: 5,
      unrecognizedGraceMs: 20_000,
    },
  },
  input: {
    description: '与 Demo batch_process.sh 一致：把原始文件名 MP4 推送到 VideoStabilizerDataPack 根目录。',
    remoteDirectoryTemplate: '/storage/emulated/0/Android/data/{packageName}/files/VideoStabilizerDataPack',
    fileName: 'input.mp4',
    preserveOriginalFileName: true,
    launchValue: 'input_directory',
  },
  launch: {
    description: '先普通启动 MainActivity 并等待 1 秒，再通过 ACTION_BATCH_PROCESS 和 material_path 启动批处理。',
    action: 'com.morphoinc.videopostprocessor.ACTION_BATCH_PROCESS',
    supportsTaskId: false,
    supportsAutoRun: false,
    requiresUiInteraction: false,
    warmupBeforeTransferMs: 1_000,
    postLaunchDialogAutomation: {
      mode: 'strict-whitelist',
      profileIds: ['oplus-storage-compatibility-warning-v1'],
      timeoutMs: 4_000,
      pollIntervalMs: 250,
      maxActions: 4,
      unrecognizedGraceMs: 1_000,
    },
  },
  output: {
    description: 'Morpho 在 VideoStabilizerDataPack/stabilized 下生成“厂商_型号_输入名_stabilized.mp4”。',
    remoteDirectoryTemplate: '/storage/emulated/0/Android/data/{packageName}/files/VideoStabilizerDataPack/stabilized',
    filePattern: '*_stabilized.mp4',
    appCreatesDirectory: true,
    clearDirectoryBeforeRun: false,
  },
  progress: {
    mode: 'logcat_pattern',
    description: '读取 MORPHO 日志中的启动、文件扫描、处理文件、Input、Output 和错误文本来映射平台进度。',
    logTag: 'MORPHO',
    logTags: [
      'MORPHO',
      'MorphoVideoPProc/Controller',
      'MorphoVideoPProc/Decoder',
      'MorphoVideoPProc/Encoder',
      'MorphoVideoPProc/Interface',
      'MorphoVideoPProc/Parser',
      'MorphoVideoPProc/Sensor',
      'MorphoVideoPProc/Stabilizer',
      'MorphoVideoPProc/WDR',
    ],
  },
  completion: {
    mode: 'marker_file',
    description: '等待 VideoStabilizerDataPack/.batch_processing_complete；还必须确认本次输出非空且日志没有处理错误。',
    remotePathTemplate: '/storage/emulated/0/Android/data/{packageName}/files/VideoStabilizerDataPack/.batch_processing_complete',
  },
  failure: {
    description: '从 MORPHO Error processing file 日志、无 MP4、超时、崩溃、marker 后无输出或空输出判断失败。',
  },
  result: {
    apkGeneratesResultJson: false,
    description: 'Morpho APK 不生成 result.json；后端根据日志、marker 和输出文件合成平台 result.json。',
  },
  cancellation: {
    mode: 'force_stop',
    description: 'Morpho 没有专用 cancel Intent；终止 ADB 子进程并执行 am force-stop com.morphoinc.videopostprocessor。',
  },
}

export const APK_EXECUTION_PROTOCOLS: readonly ApkExecutionProtocol[] = [
  PLATFORM_CARRIER_PROTOCOL,
  MORPHO_PROTOCOL,
]

export function findApkExecutionProtocol(packageName: string | undefined) {
  return APK_EXECUTION_PROTOCOLS.find((protocol) => protocol.packageName === packageName)
}

function renderTemplate(template: string, protocol: ApkExecutionProtocol, context: ExecutionPathContext) {
  return template
    .replaceAll('{packageName}', protocol.packageName)
    .replaceAll('{taskId}', context.taskId)
}

function morphoDevicePart(value: string | undefined, fallback: string) {
  return (value?.trim() || fallback).replaceAll(' ', '')
}

function safeRemoteFileName(originalName: string | undefined, fallback: string) {
  const baseName = originalName?.split(/[\\/]/).pop()?.trim()
  if (!baseName || !baseName.toLowerCase().endsWith('.mp4')) return fallback

  const stem = baseName
    .slice(0, -4)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 96)

  return stem ? `${stem}.mp4` : fallback
}

export function buildExecutionPaths(
  protocol: ApkExecutionProtocol,
  context: ExecutionPathContext,
): ApkExecutionPaths {
  const remoteInputDirectory = renderTemplate(protocol.input.remoteDirectoryTemplate, protocol, context)
  const remoteOutputDirectory = renderTemplate(protocol.output.remoteDirectoryTemplate, protocol, context)
  const remoteTaskRoot = `/sdcard/Android/data/${protocol.packageName}/files/tasks/${context.taskId}`
  const inputFileName = protocol.input.preserveOriginalFileName
    ? safeRemoteFileName(context.inputFileName, protocol.input.fileName)
    : protocol.input.fileName
  const remoteInputFile = `${remoteInputDirectory}/${inputFileName}`
  const remoteResultFile = protocol.result.remotePathTemplate
    ? renderTemplate(protocol.result.remotePathTemplate, protocol, context)
    : undefined
  const remoteCompletionPath = renderTemplate(protocol.completion.remotePathTemplate, protocol, context)

  const remoteOutputFile = protocol.output.fixedFileName
    ? `${remoteOutputDirectory}/${protocol.output.fixedFileName}`
    : `${remoteOutputDirectory}/${morphoDevicePart(context.manufacturer, 'UNKNOWN')}_${morphoDevicePart(context.model, 'UNKNOWN')}_${inputFileName.replace(/\.mp4$/i, '')}_stabilized.mp4`

  return {
    remoteTaskRoot,
    remoteInputDirectory,
    remoteInputFile,
    remoteOutputDirectory,
    remoteOutputFile,
    remoteCompletionPath,
    remoteResultFile,
  }
}

export function buildInstallPlan(
  protocol: Pick<ApkExecutionProtocol, 'packageName' | 'install'>,
  apkPath: string,
) {
  if (protocol.install.mode === 'clean') {
    return {
      uninstallPackage: protocol.packageName,
      installArguments: ['install', apkPath],
    }
  }
  return {
    installArguments: ['install', '-r', '-t', apkPath],
  }
}

export function buildWarmupLaunchArguments(protocol: ApkExecutionProtocol) {
  if (!protocol.launch.warmupBeforeTransferMs) return undefined
  return ['shell', 'am', 'start', protocol.launchActivity]
}

export function buildLaunchArguments(
  protocol: ApkExecutionProtocol,
  paths: ApkExecutionPaths,
  taskId: string,
) {
  if (protocol.id === MORPHO_PROTOCOL.id) {
    return [
      'shell', 'am', 'start',
      '-a', protocol.launch.action!,
      '--es', 'material_path', paths.remoteInputDirectory,
      protocol.launchActivity,
    ]
  }

  const args = ['shell', 'am', 'start', '-W', '-n', protocol.launchActivity]
  args.push('--es', 'task_id', taskId, '--ez', 'auto_run', 'true')
  return args
}

export interface MorphoLogSignal {
  businessStarted?: boolean
  progress?: number
  message?: string
  failureMessage?: string
  outputPath?: string
}

export function parseMorphoLogLine(line: string): MorphoLogSignal | undefined {
  if (!/MORPHO|MorphoVideoPProc\//.test(line)) return undefined

  const error = /Error processing file:\s*(.+)$/i.exec(line)
  if (error) return { progress: 65, message: `Morpho 处理失败：${error[1]}`, failureMessage: error[1].trim() }
  if (/no mp4|not found.*mp4|directory.*not exist/i.test(line)) {
    return { progress: 50, message: 'Morpho 未找到可处理的 MP4', failureMessage: 'Morpho 未找到可处理的 MP4' }
  }
  if (line.includes('Starting batch processing for path:')) return { businessStarted: true, progress: 48, message: 'Morpho 批处理服务已开始扫描输入目录' }
  if (/Found\s+\d+\s+mp4/i.test(line) || line.includes('Found mp4 file:')) return { businessStarted: true, progress: 52, message: 'Morpho 已发现输入 MP4' }
  if (line.includes('Processing file ')) return { businessStarted: true, progress: 58, message: 'Morpho 正在处理输入 MP4' }
  if (line.includes('Input:')) return { businessStarted: true, progress: 62, message: 'Morpho SDK 已读取输入路径' }
  const output = /Output:\s*(.+\.mp4)\s*$/i.exec(line)
  if (output) {
    return {
      businessStarted: true,
      progress: 68,
      message: 'Morpho SDK 已确定输出路径',
      outputPath: output[1].trim(),
    }
  }
  return undefined
}

export function resolveProtocolTimeoutSeconds(
  protocol: ApkExecutionProtocol,
  configuredTimeoutSeconds: number,
) {
  const minimum = protocol.completion.minimumTimeoutSeconds
  return minimum ? Math.max(configuredTimeoutSeconds, minimum) : configuredTimeoutSeconds
}

export function toPublicApkProtocol(protocol: ApkExecutionProtocol) {
  return {
    ...protocol,
    recognized: true as const,
    executable: true as const,
  }
}
