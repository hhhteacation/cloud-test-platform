import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApkDialogAutomationConfig } from '../../apk-protocols.js'
import type { ProcessResult } from '../../process.js'
import { TaskExecutionError } from '../execution-errors.js'
import type { AndroidPreparationDevice } from './contracts.js'
import type { DialogInspectionResult } from './dialog-state.js'
import { PostLaunchDialogCoordinator } from './post-launch-dialog-coordinator.js'
import type { SystemDialogController } from './system-dialog-controller.js'
import { SystemDialogController as RealSystemDialogController } from './system-dialog-controller.js'

type InspectOptions = Parameters<SystemDialogController['inspectAndHandle']>[0]
type SaveOptions = Parameters<SystemDialogController['saveTimeoutDiagnostics']>[0]

const fixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
  'utf8',
)

function automation(overrides: Partial<ApkDialogAutomationConfig> = {}): ApkDialogAutomationConfig {
  return {
    mode: 'strict-whitelist',
    profileIds: ['oplus-storage-compatibility-warning-v1'],
    timeoutMs: 20,
    pollIntervalMs: 1,
    maxActions: 2,
    unrecognizedGraceMs: 2,
    ...overrides,
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    manufacturer: 'OPPO',
    packageName: 'com.morphoinc.videopostprocessor',
    applicationLabel: 'Morpho VideoStabilizer',
    diagnosticsDirectory: '/tmp/not-used',
    automation: automation(),
    signal: new AbortController().signal,
    onEvent: vi.fn(),
    ...overrides,
  }
}

function handled(): DialogInspectionResult {
  return {
    kind: 'handled',
    dialog: {
      profileId: 'oplus-storage-compatibility-warning-v1',
      action: 'dismiss-compatibility-warning',
      timestamp: '2026-08-07T00:00:00.000Z',
    },
    signature: {
      pageKind: 'recognized-action',
      windowPackage: 'com.android.permissioncontroller',
      profileId: 'oplus-storage-compatibility-warning-v1',
      action: 'dismiss-compatibility-warning',
    },
  }
}

function waiting(): DialogInspectionResult {
  return {
    kind: 'waiting',
    reason: 'action-awaiting-transition',
    signature: {
      pageKind: 'recognized-action',
      windowPackage: 'com.android.permissioncontroller',
      profileId: 'oplus-storage-compatibility-warning-v1',
      action: 'dismiss-compatibility-warning',
    },
  }
}

function unrecognized(pageFingerprint = 'unknown-page'): DialogInspectionResult {
  return {
    kind: 'unrecognized',
    signature: {
      pageKind: 'unrecognized-page',
      windowPackage: 'com.android.permissioncontroller',
      pageFingerprint,
    },
  }
}

function fakeDialogs(sequence: DialogInspectionResult[]) {
  let index = 0
  const inspectAndHandle = vi.fn(async (_options: InspectOptions) => {
    const result = sequence[Math.min(index, sequence.length - 1)]
    index += 1
    return result
  })
  const saveTimeoutDiagnostics = vi.fn(async (_options: SaveOptions) => undefined)
  return {
    value: { inspectAndHandle, saveTimeoutDiagnostics } as unknown as SystemDialogController,
    inspectAndHandle,
    saveTimeoutDiagnostics,
  }
}

class RepeatedOplusCompatibilityPageDevice implements AndroidPreparationDevice {
  readonly calls: string[][] = []

  async connectionStatus() { return 'online' as const }
  async isPackageInstalled() { return true }

  async run(args: string[]): Promise<ProcessResult> {
    this.calls.push(args)
    const command = args.join(' ')
    if (command === 'shell dumpsys window windows') {
      return this.result(
        'mCurrentFocus=Window{123 u0 com.android.permissioncontroller/com.oplusos.permissioncontroller.permission.ui.OplusCompatibilityAlertActivity}',
      )
    }
    if (command === 'exec-out uiautomator dump /dev/tty') {
      return this.result(fixture('oplus-coloros-storage-compatibility-warning.xml'))
    }
    if (command === 'shell pm path com.android.permissioncontroller') {
      return this.result('package:/system/priv-app/PermissionController/PermissionController.apk')
    }
    return this.result('')
  }

  private result(stdout: string): ProcessResult {
    return { code: 0, stdout, stderr: '' }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PostLaunchDialogCoordinator', () => {
  it('treats an entirely absent optional dialog as success', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const dialogs = fakeDialogs([{ kind: 'none' }])
    const coordinator = new PostLaunchDialogCoordinator(dialogs.value)
    const outcome = coordinator.handleOptionalDialog(request())

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toEqual([])
    expect(dialogs.saveTimeoutDiagnostics).not.toHaveBeenCalled()
  })

  it('verifies that a handled page leaves before completing the phase', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const dialogs = fakeDialogs([handled(), { kind: 'none' }])
    const coordinator = new PostLaunchDialogCoordinator(dialogs.value)
    const outcome = coordinator.handleOptionalDialog(request())

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toEqual([
      expect.objectContaining({ profileId: 'oplus-storage-compatibility-warning-v1' }),
    ])
    expect(dialogs.inspectAndHandle).toHaveBeenCalledTimes(2)
  })

  it('reports a handled action with no page transition as a post-launch timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const dialogs = fakeDialogs([handled(), waiting()])
    const coordinator = new PostLaunchDialogCoordinator(dialogs.value)
    const outcome = coordinator.handleOptionalDialog(request()).catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    const error = await outcome
    expect(error).toBeInstanceOf(TaskExecutionError)
    expect(error).toMatchObject({
      code: 'POST_LAUNCH_DIALOG_TIMEOUT',
      message: expect.stringContaining('没有发生可验证迁移'),
    })
    expect(dialogs.saveTimeoutDiagnostics).toHaveBeenCalledOnce()
  })

  it('classifies a stable unknown system page separately from a transition timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const dialogs = fakeDialogs([unrecognized()])
    const coordinator = new PostLaunchDialogCoordinator(dialogs.value)
    const outcome = coordinator.handleOptionalDialog(request()).catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    const error = await outcome
    expect(error).toBeInstanceOf(TaskExecutionError)
    expect(error).toMatchObject({ code: 'POST_LAUNCH_DIALOG_UNRECOGNIZED' })
    expect(dialogs.saveTimeoutDiagnostics).toHaveBeenCalledOnce()
  })

  it('uses the overall phase timeout when observed pages keep changing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const dialogs = fakeDialogs([
      unrecognized('unknown-a'),
      waiting(),
      unrecognized('unknown-b'),
      waiting(),
    ])
    const coordinator = new PostLaunchDialogCoordinator(dialogs.value)
    const outcome = coordinator.handleOptionalDialog(request({
      automation: automation({ timeoutMs: 5, unrecognizedGraceMs: 10 }),
    })).catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    const error = await outcome
    expect(error).toBeInstanceOf(TaskExecutionError)
    expect(error).toMatchObject({ code: 'POST_LAUNCH_DIALOG_TIMEOUT' })
    expect(dialogs.saveTimeoutDiagnostics).toHaveBeenCalledOnce()
  })

  it('stops polling when the phase is cancelled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const abortController = new AbortController()
    const dialogs = fakeDialogs([{ kind: 'none' }])
    const coordinator = new PostLaunchDialogCoordinator(dialogs.value)
    const outcome = coordinator.handleOptionalDialog(request({ signal: abortController.signal }))
    const rejection = expect(outcome).rejects.toMatchObject({ name: 'AbortError' })

    await vi.advanceTimersByTimeAsync(1)
    abortController.abort()
    await vi.runAllTimersAsync()

    await rejection
  })

  it('keeps a real recognized Oplus frame in waiting state after one tap and times out the phase', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const device = new RepeatedOplusCompatibilityPageDevice()
    const realController = new RealSystemDialogController(device, async () => undefined)
    const saveTimeoutDiagnostics = vi.fn(async () => undefined)
    const coordinator = new PostLaunchDialogCoordinator({
      inspectAndHandle: realController.inspectAndHandle.bind(realController),
      saveTimeoutDiagnostics,
    })
    const outcome = coordinator.handleOptionalDialog(request()).catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    const error = await outcome
    expect(error).toBeInstanceOf(TaskExecutionError)
    expect(error).toMatchObject({ code: 'POST_LAUNCH_DIALOG_TIMEOUT' })
    expect(device.calls.filter((args) => args.slice(0, 3).join(' ') === 'shell input tap')).toHaveLength(1)
    expect(saveTimeoutDiagnostics).toHaveBeenCalledOnce()
  })

  it('preserves install user-action semantics when a known install block remains visible', async () => {
    const dialogs = fakeDialogs([{
      kind: 'manual-action-required',
      block: {
        profileId: 'honor-magic-os-unreviewed-app-block-v1',
        reason: 'honor-install-authorization-required',
        summary: '需要人工确认安装授权',
      },
      signature: {
        pageKind: 'manual-action-required',
        windowPackage: 'com.android.packageinstaller',
      },
    }])
    const coordinator = new PostLaunchDialogCoordinator(dialogs.value)

    await expect(coordinator.handleOptionalDialog(request({
      manufacturer: 'HONOR',
      automation: automation({
        profileIds: ['honor-magic-os-unreviewed-app-block-v1'],
      }),
    }))).rejects.toMatchObject({
      code: 'INSTALL_USER_ACTION_REQUIRED',
      message: '需要人工确认安装授权',
    })
  })
})
