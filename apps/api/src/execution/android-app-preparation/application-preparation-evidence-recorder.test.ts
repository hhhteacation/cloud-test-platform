import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { TaskExecutionError } from '../execution-errors.js'
import { ApplicationPreparationEvidenceRecorder } from './application-preparation-evidence-recorder.js'

async function readJson(targetPath: string) {
  return JSON.parse(await readFile(targetPath, 'utf8')) as Record<string, unknown>
}

describe('ApplicationPreparationEvidenceRecorder', () => {
  it('records failed ADB commands with preserved process output', async () => {
    const diagnosticsDirectory = await mkdtemp(path.join(tmpdir(), 'preparation-command-evidence-'))
    try {
      const recorder = new ApplicationPreparationEvidenceRecorder({
        diagnosticsDirectory,
        captureScreenshot: async () => undefined,
        now: () => new Date('2026-08-09T06:30:00.000Z'),
      })
      const error = new TaskExecutionError('ADB Failure [-99]', 'APK_INSTALL_FAILED', {
        processResult: {
          code: -99,
          stdout: 'Performing Streamed Install\n',
          stderr: 'Failure [-99]\n',
          stdoutBytes: 28,
          stderrBytes: 14,
        },
      })

      const evidenceRef = await recorder.recordCommand({
        phase: 'install',
        operation: 'install',
        args: ['install', '-r', '/private/tmp/test.apk'],
        startedAt: new Date('2026-08-09T06:29:58.000Z'),
        finishedAt: new Date('2026-08-09T06:30:00.000Z'),
        error,
      })

      expect(evidenceRef).toMatch(/adb-command\.json$/)
      const evidence = await readJson(path.join(diagnosticsDirectory, evidenceRef!))
      expect(evidence).toMatchObject({
        phase: 'install',
        operation: 'install',
        status: 'failed',
        durationMs: 2000,
        result: {
          exitCode: -99,
          stdout: 'Performing Streamed Install\n',
          stderr: 'Failure [-99]\n',
        },
        error: {
          code: 'APK_INSTALL_FAILED',
          message: 'ADB Failure [-99]',
        },
      })
    } finally {
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  })

  it('correlates a dialog frame, action and transition without recapturing the same page', async () => {
    const diagnosticsDirectory = await mkdtemp(path.join(tmpdir(), 'preparation-dialog-evidence-'))
    const screenshots: string[] = []
    try {
      const recorder = new ApplicationPreparationEvidenceRecorder({
        diagnosticsDirectory,
        captureScreenshot: async (targetPath) => {
          screenshots.push(targetPath)
          await writeFile(targetPath, Buffer.from('png'))
        },
        now: () => new Date('2026-08-09T06:31:00.000Z'),
      })
      const inspection = {
        kind: 'handled' as const,
        dialog: {
          profileId: 'oplus-package-installer-v1',
          action: 'continue-install',
          timestamp: '2026-08-09T06:31:00.000Z',
        },
        signature: {
          pageKind: 'recognized-action' as const,
          windowPackage: 'com.oplus.appdetail',
          windowComponent: 'com.oplus.appdetail/com.oplus.appdetail.model.guide.ui.InstallGuideActivity',
          profileId: 'oplus-package-installer-v1',
          action: 'continue-install' as const,
          pageFingerprint: 'pkr110-install-guide',
        },
      }

      const evidenceDirectory = await recorder.recordDialogObservation({
        phase: 'install',
        focusedWindowPackage: 'com.oplus.appdetail',
        focusedWindowComponent: inspection.signature.windowComponent,
        currentWindow: 'mCurrentFocus=com.oplus.appdetail/.InstallGuideActivity',
        uiXml: '<hierarchy />',
        inspection,
        signal: new AbortController().signal,
      })
      const duplicateDirectory = await recorder.recordDialogObservation({
        phase: 'install',
        focusedWindowPackage: 'com.oplus.appdetail',
        focusedWindowComponent: inspection.signature.windowComponent,
        currentWindow: 'mCurrentFocus=com.oplus.appdetail/.InstallGuideActivity',
        uiXml: '<hierarchy />',
        inspection,
        signal: new AbortController().signal,
      })
      await recorder.recordTransition(evidenceDirectory, {
        phase: 'install',
        inspection,
        observation: {
          state: 'action-executed',
          enteredStates: ['action-required', 'action-executed'],
          signatureChanged: true,
          elapsedMs: 0,
          stable: false,
          transitionVerified: false,
        },
      })
      await recorder.recordTransition(evidenceDirectory, {
        phase: 'install',
        inspection: { kind: 'none' },
        observation: {
          state: 'completed',
          enteredStates: ['completed'],
          signatureChanged: true,
          elapsedMs: 0,
          stable: true,
          transitionVerified: true,
        },
      })

      expect(duplicateDirectory).toBe(evidenceDirectory)
      expect(screenshots).toHaveLength(1)
      expect(await readFile(path.join(diagnosticsDirectory, evidenceDirectory!, 'window.txt'), 'utf8'))
        .toContain('InstallGuideActivity')
      expect(await readFile(path.join(diagnosticsDirectory, evidenceDirectory!, 'ui.xml'), 'utf8'))
        .toBe('<hierarchy />')
      expect(await readJson(path.join(diagnosticsDirectory, evidenceDirectory!, 'action-result.json')))
        .toMatchObject({
          outcome: 'handled',
          profileId: 'oplus-package-installer-v1',
          action: 'continue-install',
          screenshot: { status: 'captured' },
        })
      expect(await readJson(path.join(diagnosticsDirectory, evidenceDirectory!, 'transition-result.json')))
        .toMatchObject({
          phase: 'install',
          history: [
            { state: 'action-executed', transitionVerified: false },
            { state: 'completed', transitionVerified: true },
          ],
        })
    } finally {
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  })

  it('never turns an Evidence filesystem failure into the primary business failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'preparation-evidence-failure-'))
    const invalidDirectory = path.join(root, 'not-a-directory')
    try {
      await writeFile(invalidDirectory, 'file')
      const recorder = new ApplicationPreparationEvidenceRecorder({
        diagnosticsDirectory: invalidDirectory,
        captureScreenshot: async () => {
          throw new Error('screenshot failed')
        },
      })

      await expect(recorder.recordCommand({
        phase: 'install',
        operation: 'install',
        args: ['install', 'test.apk'],
        startedAt: new Date(),
        finishedAt: new Date(),
        result: { code: 0, stdout: 'Success', stderr: '' },
      })).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
