import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildAttemptManifest,
  captureAndroidDeviceSnapshot,
  writeAttemptManifest,
} from './attempt-manifest.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Attempt Manifest seam', () => {
  it('records source identity, input identity and the evidence directory before execution', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'attempt-manifest-'))
    roots.push(root)
    const inputPath = path.join(root, 'input.mp4')
    const evidenceDirectory = path.join(root, 'evidence')
    const manifestPath = path.join(evidenceDirectory, 'attempt-manifest.json')
    await writeFile(inputPath, 'known-input')

    const manifest = await buildAttemptManifest({
      attemptId: 'attempt-1',
      deviceSerial: '192.168.5.3:5555',
      deviceName: 'PKR110',
      protocolId: 'morpho-video-postprocessor-batch-v2',
      profileVersion: 'android-dialog-profiles@1',
      inputPath,
      evidenceDirectory,
    }, {
      now: () => new Date('2026-08-09T01:02:03.000Z'),
      readSourceIdentity: async () => ({ commitSha: 'abc123', dirty: false }),
    })

    await writeAttemptManifest(manifestPath, manifest)
    const persisted = JSON.parse(await readFile(manifestPath, 'utf8'))

    expect(persisted).toMatchObject({
      attemptId: 'attempt-1',
      commitSha: 'abc123',
      dirty: false,
      startedAt: '2026-08-09T01:02:03.000Z',
      protocolId: 'morpho-video-postprocessor-batch-v2',
      profileVersion: 'android-dialog-profiles@1',
      evidenceDirectory,
      device: {
        serial: '192.168.5.3:5555',
        manufacturer: 'unknown',
        model: 'PKR110',
        androidVersion: 'unknown',
        buildFingerprint: 'unknown',
      },
    })
    expect(persisted.inputFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('captures a read-only Android snapshot without treating missing observations as absent facts', async () => {
    const responses = new Map<string, { code: number; stdout: string; stderr: string }>([
      ['shell getprop ro.product.manufacturer', { code: 0, stdout: 'OnePlus\n', stderr: '' }],
      ['shell getprop ro.product.model', { code: 0, stdout: 'PKR110\n', stderr: '' }],
      ['shell getprop ro.build.version.release', { code: 0, stdout: '15\n', stderr: '' }],
      ['shell getprop ro.build.fingerprint', { code: 0, stdout: 'OnePlus/PKR110/build\n', stderr: '' }],
      ['shell dumpsys power', { code: 0, stdout: 'mWakefulness=Awake\nmInteractive=true', stderr: '' }],
      ['shell dumpsys window windows', { code: 0, stdout: 'mCurrentFocus=Window{abc u0 com.oplus.appdetail/.MainActivity}', stderr: '' }],
      ['shell pm list packages', { code: 0, stdout: 'package:com.android.permissioncontroller\npackage:com.oplus.appdetail\n', stderr: '' }],
      ['shell input help', { code: 0, stdout: 'Usage: input <command>', stderr: '' }],
    ])

    const snapshot = await captureAndroidDeviceSnapshot(
      'online',
      async (args) => responses.get(args.join(' ')) ?? { code: 1, stdout: '', stderr: 'missing fixture' },
    )

    expect(snapshot).toMatchObject({
      connectionStatus: 'online',
      manufacturer: 'OnePlus',
      model: 'PKR110',
      androidVersion: '15',
      buildFingerprint: 'OnePlus/PKR110/build',
      powerSummary: 'mWakefulness=Awake; mInteractive=true',
      currentWindow: 'com.oplus.appdetail/.MainActivity',
      controllerPackages: ['com.android.permissioncontroller', 'com.oplus.appdetail'],
      inputAutomationCommandAvailable: true,
    })
    expect(snapshot.observationFailures).toEqual([])
  })

  it('marks failed device observations explicitly instead of inventing values', async () => {
    const snapshot = await captureAndroidDeviceSnapshot(
      'online',
      async () => ({ code: 2, stdout: '', stderr: 'permission denied' }),
    )

    expect(snapshot).toMatchObject({
      connectionStatus: 'online',
      manufacturer: 'unknown',
      model: 'unknown',
      androidVersion: 'unknown',
      buildFingerprint: 'unknown',
      inputAutomationCommandAvailable: false,
    })
    expect(snapshot.observationFailures).toEqual(expect.arrayContaining([
      expect.stringContaining('ro.product.manufacturer'),
      expect.stringContaining('dumpsys window windows'),
    ]))
  })
})
