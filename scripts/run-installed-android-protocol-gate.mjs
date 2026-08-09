import { appendFileSync } from 'node:fs'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  buildExecutionPaths,
  findApkExecutionProtocol,
} from '../apps/api/dist/apk-protocols.js'
import { AdbDeviceClient } from '../apps/api/dist/execution/adb-client.js'
import { AdbStreams } from '../apps/api/dist/execution/adb-streams.js'
import {
  ANDROID_DIALOG_PROFILE_VERSION,
  buildAttemptManifest,
  captureAndroidDeviceSnapshot,
  writeAttemptManifest,
} from '../apps/api/dist/execution/attempt-manifest.js'
import { createProtocolExecutor } from '../apps/api/dist/execution/protocol-executor-factory.js'

function positiveInteger(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function adbPath() {
  return process.env.ADB_PATH?.trim()
    || path.join(process.env.ANDROID_SDK_ROOT || path.join(process.env.HOME || '', 'Library/Android/sdk'), 'platform-tools/adb')
}

function summarizeError(error) {
  if (!(error instanceof Error)) return { message: String(error) }
  return {
    name: error.name,
    message: error.message,
    code: typeof error.code === 'string' ? error.code : undefined,
    stack: error.stack,
  }
}

async function assertFileExists(targetPath, label) {
  try {
    await access(targetPath)
  } catch {
    throw new Error(`${label} does not exist: ${targetPath}`)
  }
}

async function main() {
  const serial = required('ADB_SERIAL')
  const packageName = required('APK_PACKAGE_NAME')
  const inputPath = path.resolve(required('INPUT_VIDEO_PATH'))
  const evidenceRoot = path.resolve(required('GATE_EVIDENCE_DIR'))
  const attempts = positiveInteger('GATE_ATTEMPTS', 3)
  const timeoutSeconds = positiveInteger('GATE_TIMEOUT_SECONDS', 300)
  const pollIntervalMs = positiveInteger('POLL_INTERVAL_MS', 1000)
  const maxLogcatBytes = positiveInteger('MAX_LOGCAT_BYTES', 16 * 1024 * 1024)
  const minFreeDiskBytes = positiveInteger('MIN_FREE_DISK_BYTES', 10 * 1024 * 1024 * 1024)
  const protocol = findApkExecutionProtocol(packageName)
  if (!protocol) throw new Error(`No registered Platform Protocol for ${packageName}`)
  if (!protocol.executable && 'executable' in protocol) {
    throw new Error(`Platform Protocol ${protocol.id} is not executable`)
  }

  await assertFileExists(inputPath, 'INPUT_VIDEO_PATH')
  await mkdir(evidenceRoot, { recursive: true })

  const device = new AdbDeviceClient(adbPath(), serial)
  const results = []
  const generatedAt = new Date().toISOString()
  const reportPath = path.join(evidenceRoot, 'gate-report.json')

  for (let ordinal = 1; ordinal <= attempts; ordinal += 1) {
    const attemptId = `installed-gate-${ordinal}-${randomUUID()}`
    const taskId = `installed-gate-${randomUUID()}`
    const runDirectory = path.join(evidenceRoot, attemptId)
    const diagnosticsDirectory = path.join(runDirectory, 'diagnostics')
    await mkdir(diagnosticsDirectory, { recursive: true })

    let manifest = await buildAttemptManifest({
      attemptId,
      deviceSerial: serial,
      deviceName: serial,
      protocolId: protocol.id,
      profileVersion: ANDROID_DIALOG_PROFILE_VERSION,
      inputPath,
      evidenceDirectory: runDirectory,
    })
    await writeAttemptManifest(path.join(runDirectory, 'attempt-manifest.json'), manifest)

    const controller = new AbortController()
    const startedAt = new Date().toISOString()
    const eventsPath = path.join(runDirectory, 'gate-events.jsonl')
    const record = (event) => appendFileSync(
      eventsPath,
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      'utf8',
    )

    try {
      if (manifest.dirty) {
        throw new Error('Installed-state Gate requires a clean worktree; manifest is dirty')
      }

      const connectionStatus = await device.connectionStatus()
      const snapshot = await captureAndroidDeviceSnapshot(
        connectionStatus,
        (args) => device.observe(args, controller.signal, 30_000),
      )
      await writeFile(
        path.join(runDirectory, 'device-snapshot.json'),
        `${JSON.stringify(snapshot, null, 2)}\n`,
      )
      manifest = {
        ...manifest,
        device: {
          serial,
          manufacturer: snapshot.manufacturer,
          model: snapshot.model,
          androidVersion: snapshot.androidVersion,
          buildFingerprint: snapshot.buildFingerprint,
        },
      }
      await writeAttemptManifest(path.join(runDirectory, 'attempt-manifest.json'), manifest)
      if (connectionStatus !== 'online') throw new Error(`Device connection is ${connectionStatus}`)

      const installedBefore = await device.observe(
        ['shell', 'pm', 'path', protocol.packageName],
        controller.signal,
        15_000,
      )
      if (installedBefore.code !== 0 || !installedBefore.stdout.includes('package:')) {
        throw new Error(`Installed-state precondition failed for ${protocol.packageName}`)
      }

      const paths = buildExecutionPaths(protocol, {
        taskId,
        manufacturer: snapshot.manufacturer,
        model: snapshot.model,
        inputFileName: path.basename(inputPath),
      })
      const streams = new AdbStreams(adbPath(), serial, undefined, {
        maxLogBytes: maxLogcatBytes,
        killGraceMs: 3000,
      })
      const executor = createProtocolExecutor(protocol, {
        device,
        streams,
        pollIntervalMs,
        maxLogcatBytes,
        minFreeDiskBytes,
      })
      const result = await executor.execute({
        executionKey: attemptId,
        taskId,
        protocol,
        paths,
        input: { localPath: inputPath, originalName: path.basename(inputPath) },
        local: {
          runDirectory,
          resultPath: path.join(runDirectory, 'result.json'),
          outputPath: path.join(runDirectory, 'output.mp4'),
          logcatPath: path.join(runDirectory, 'logcat.txt'),
          diagnosticsDirectory,
        },
        configuredTimeoutSeconds: timeoutSeconds,
        signal: controller.signal,
        reporter: {
          update(phase, progress, message) {
            record({ type: 'update', phase, progress, message })
            process.stdout.write(`[${ordinal}/${attempts}] ${phase} ${progress} ${message}\n`)
          },
          addLog(message, level = 'info') {
            record({ type: 'log', level, message })
          },
          setProcessingProgress(progress) {
            record({ type: 'processing-progress', progress })
          },
          upsertCheck(check) {
            record({ type: 'check', check })
          },
          isCancelled() { return false },
        },
      })

      const installedAfter = await device.observe(
        ['shell', 'pm', 'path', protocol.packageName],
        controller.signal,
        15_000,
      )
      const packageStillInstalled = installedAfter.code === 0
        && installedAfter.stdout.includes('package:')
      if (!packageStillInstalled) {
        throw new Error(`Protocol execution removed installed package ${protocol.packageName}`)
      }

      const item = {
        ordinal,
        attemptId,
        status: 'passed',
        startedAt,
        finishedAt: new Date().toISOString(),
        packageStillInstalled,
        manifest,
        result,
      }
      results.push(item)
      await writeFile(
        path.join(runDirectory, 'gate-result.json'),
        `${JSON.stringify(item, null, 2)}\n`,
      )
    } catch (error) {
      const item = {
        ordinal,
        attemptId,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        manifest,
        error: summarizeError(error),
      }
      results.push(item)
      await writeFile(
        path.join(runDirectory, 'gate-result.json'),
        `${JSON.stringify(item, null, 2)}\n`,
      )
      break
    }
  }

  const report = {
    kind: 'installed-state-android-protocol-executor-gate',
    generatedAt,
    protocolId: protocol.id,
    packageName: protocol.packageName,
    attemptsRequested: attempts,
    commitSha: results[0]?.manifest?.commitSha ?? 'unknown',
    dirty: results.some((item) => item.manifest?.dirty !== false),
    note: 'Invokes the production ProtocolExecutor directly and intentionally skips ApplicationPreparation.',
    results,
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`REPORT ${reportPath}\n`)

  if (results.length !== attempts || results.some((item) => item.status !== 'passed')) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`${summarizeError(error).message}\n`)
  process.exitCode = 1
})
