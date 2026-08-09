import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApkDialogAutomationConfig } from '../../apk-protocols.js'
import { TaskExecutionError } from '../execution-errors.js'
import type { DialogInspectionResult } from './dialog-state.js'
import type { RuntimePermissionManager } from './runtime-permissions.js'
import { RuntimePermissionDialogCoordinator } from './runtime-permission-dialog-coordinator.js'
import type { SystemDialogController } from './system-dialog-controller.js'

type InspectOptions = Parameters<SystemDialogController['inspectAndHandle']>[0]
type SaveOptions = Parameters<SystemDialogController['saveTimeoutDiagnostics']>[0]

const signal = new AbortController().signal

function automation(overrides: Partial<ApkDialogAutomationConfig> = {}): ApkDialogAutomationConfig {
  return {
    mode: 'strict-whitelist',
    profileIds: [
      'honor-package-installer-v1',
      'honor-magic-os-unreviewed-app-block-v1',
      'android-runtime-permission-v1',
    ],
    timeoutMs: 20,
    pollIntervalMs: 1,
    maxActions: 5,
    unrecognizedGraceMs: 5,
    ...overrides,
  }
}

function request(overrides: Partial<ReturnType<typeof baseRequest>> = {}) {
  return { ...baseRequest(), ...overrides }
}

function baseRequest() {
  return {
    manufacturer: 'HONOR',
    packageName: 'com.morphoinc.videopostprocessor',
    applicationLabel: 'Morpho VideoStabilizer',
    permissions: ['android.permission.CAMERA'],
    diagnosticsDirectory: '/tmp/not-used',
    automation: automation(),
    signal,
    onEvent: vi.fn(),
  }
}

function fakePermissions(...grantStates: boolean[]) {
  let index = 0
  const areAllGranted = vi.fn(async () => {
    const state = grantStates[Math.min(index, grantStates.length - 1)] ?? false
    index += 1
    return state
  })
  const verifyAll = vi.fn(async () => ['android.permission.CAMERA'])
  return {
    value: { areAllGranted, verifyAll } as unknown as RuntimePermissionManager,
    areAllGranted,
    verifyAll,
  }
}

function fakeDialogs(inspect: (options: InspectOptions) => DialogInspectionResult) {
  const inspectAndHandle = vi.fn(async (options: InspectOptions) => inspect(options))
  const saveTimeoutDiagnostics = vi.fn(async (_options: SaveOptions) => undefined)
  return {
    value: { inspectAndHandle, saveTimeoutDiagnostics } as unknown as SystemDialogController,
    inspectAndHandle,
    saveTimeoutDiagnostics,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RuntimePermissionDialogCoordinator', () => {
  it('returns without inspecting UI when all permissions are already granted', async () => {
    const permissions = fakePermissions(true)
    const dialogs = fakeDialogs(() => ({ kind: 'none' }))
    const coordinator = new RuntimePermissionDialogCoordinator(permissions.value, dialogs.value)

    await expect(coordinator.waitUntilGranted(request())).resolves.toEqual([])

    expect(permissions.verifyAll).toHaveBeenCalledOnce()
    expect(dialogs.inspectAndHandle).not.toHaveBeenCalled()
  })

  it('records a handled dialog and completes after the permission state changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const permissions = fakePermissions(false, true)
    const dialogs = fakeDialogs(() => ({
      kind: 'handled',
      dialog: {
        profileId: 'android-runtime-permission-v1',
        action: 'allow-permission',
        timestamp: '2026-08-07T00:00:00.000Z',
      },
      signature: {
        pageKind: 'recognized-action',
        windowPackage: 'com.android.permissioncontroller',
        profileId: 'android-runtime-permission-v1',
        action: 'allow-permission',
      },
    }))
    const coordinator = new RuntimePermissionDialogCoordinator(permissions.value, dialogs.value)
    const outcome = coordinator.waitUntilGranted(request())

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toEqual([
      expect.objectContaining({ profileId: 'android-runtime-permission-v1' }),
    ])
    expect(permissions.verifyAll).toHaveBeenCalledOnce()
    expect(dialogs.inspectAndHandle).toHaveBeenCalledOnce()
  })

  it('records runtime-permission state transitions against the captured dialog frame', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const permissions = fakePermissions(false, true)
    const dialogs = fakeDialogs(() => ({
      kind: 'handled',
      evidenceDirectory: 'application-preparation/runtime-permission/0001-dialog-frame',
      dialog: {
        profileId: 'android-runtime-permission-v1',
        action: 'allow-permission',
        timestamp: '2026-08-09T00:00:00.000Z',
      },
      signature: {
        pageKind: 'recognized-action',
        windowPackage: 'com.android.permissioncontroller',
        profileId: 'android-runtime-permission-v1',
        action: 'allow-permission',
      },
    }))
    const evidence = { recordTransition: vi.fn(async () => undefined) }
    const coordinator = new RuntimePermissionDialogCoordinator(
      permissions.value,
      dialogs.value,
      evidence,
    )
    const outcome = coordinator.waitUntilGranted(request())

    await vi.runAllTimersAsync()
    await expect(outcome).resolves.toHaveLength(1)
    expect(evidence.recordTransition).toHaveBeenNthCalledWith(
      1,
      'application-preparation/runtime-permission/0001-dialog-frame',
      expect.objectContaining({
        phase: 'runtime-permission',
        inspection: expect.objectContaining({ kind: 'handled' }),
        observation: expect.objectContaining({ state: 'action-executed' }),
      }),
    )
    expect(evidence.recordTransition).toHaveBeenNthCalledWith(
      2,
      'application-preparation/runtime-permission/0001-dialog-frame',
      expect.objectContaining({
        phase: 'runtime-permission',
        inspection: expect.objectContaining({ kind: 'none' }),
        observation: expect.objectContaining({
          state: 'completed',
          transitionVerified: true,
        }),
      }),
    )
  })

  it('forwards the configured Profile set while the phase prevents install actions', async () => {
    const dialogs = fakeDialogs(() => ({ kind: 'none' }))
    const coordinator = new RuntimePermissionDialogCoordinator(fakePermissions(true).value, dialogs.value)

    await coordinator.handleResidualDialog(request())

    expect(dialogs.inspectAndHandle).toHaveBeenCalledOnce()
    expect(dialogs.inspectAndHandle.mock.calls[0][0]).toMatchObject({
      phase: 'runtime-permission',
      profileIds: automation().profileIds,
    })
  })

  it('verifies that a handled residual permission page disappears before completing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const inspections: DialogInspectionResult[] = [{
      kind: 'handled',
      dialog: {
        profileId: 'android-runtime-permission-v1',
        action: 'allow-permission',
        timestamp: '2026-08-09T00:00:00.000Z',
      },
      signature: {
        pageKind: 'recognized-action',
        windowPackage: 'com.android.permissioncontroller',
        profileId: 'android-runtime-permission-v1',
        action: 'allow-permission',
      },
    }, { kind: 'none' }]
    let inspectionIndex = 0
    const dialogs = fakeDialogs(() => inspections[Math.min(
      inspectionIndex++,
      inspections.length - 1,
    )])
    const coordinator = new RuntimePermissionDialogCoordinator(
      fakePermissions(true).value,
      dialogs.value,
    )
    const outcome = coordinator.handleResidualDialog(request())

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toEqual([
      expect.objectContaining({ profileId: 'android-runtime-permission-v1' }),
    ])
    expect(dialogs.inspectAndHandle).toHaveBeenCalledTimes(2)
  })

  it('fails immediately when a configured block Profile requires manual action', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const dialogs = fakeDialogs(() => ({
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
    }))
    const coordinator = new RuntimePermissionDialogCoordinator(fakePermissions(false).value, dialogs.value)
    const outcome = coordinator.waitUntilGranted(request()).catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    const error = await outcome
    expect(error).toBeInstanceOf(TaskExecutionError)
    expect(error).toMatchObject({
      code: 'INSTALL_USER_ACTION_REQUIRED',
      message: '需要人工确认安装授权',
    })
    expect(dialogs.inspectAndHandle).toHaveBeenCalledOnce()
    expect(dialogs.saveTimeoutDiagnostics).not.toHaveBeenCalled()
  })
  it('observes once before applying a budget that expires during setup', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1)

    const dialogs = fakeDialogs(() => ({
      kind: 'unrecognized',
      signature: {
        pageKind: 'unrecognized-page',
        windowPackage: 'com.android.permissioncontroller',
        pageFingerprint: 'same-unknown-page',
      },
    }))
    const coordinator = new RuntimePermissionDialogCoordinator(fakePermissions(false).value, dialogs.value)
    const outcome = coordinator.handleResidualDialog(request({
      automation: automation({ timeoutMs: 1, pollIntervalMs: 1, unrecognizedGraceMs: 0 }),
    })).catch((error: unknown) => error)

    const error = await outcome
    expect(error).toMatchObject({ code: 'RUNTIME_PERMISSION_DIALOG_UNRECOGNIZED' })
    expect(dialogs.inspectAndHandle).toHaveBeenCalledOnce()
  })

  it('reports a stable unknown page as unrecognized and preserves diagnostics', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const dialogs = fakeDialogs(() => ({
      kind: 'unrecognized',
      signature: {
        pageKind: 'unrecognized-page',
        windowPackage: 'com.android.permissioncontroller',
        pageFingerprint: 'same-unknown-page',
      },
    }))
    const coordinator = new RuntimePermissionDialogCoordinator(fakePermissions(false).value, dialogs.value)
    const outcome = coordinator.waitUntilGranted(request({
      automation: automation({ timeoutMs: 20, unrecognizedGraceMs: 2 }),
    })).catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    const error = await outcome
    expect(error).toMatchObject({
      code: 'RUNTIME_PERMISSION_DIALOG_UNRECOGNIZED',
      message: expect.stringContaining('未满足严格权限白名单'),
    })
    expect(dialogs.saveTimeoutDiagnostics).toHaveBeenCalledOnce()
  })

  it('reports a recognized action that never transitions as a timeout, not an unknown page', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const dialogs = fakeDialogs(() => ({
      kind: 'waiting',
      reason: 'action-awaiting-transition',
      signature: {
        pageKind: 'recognized-action',
        windowPackage: 'com.android.permissioncontroller',
        profileId: 'android-runtime-permission-v1',
        action: 'allow-permission',
      },
    }))
    const coordinator = new RuntimePermissionDialogCoordinator(fakePermissions(false).value, dialogs.value)
    const outcome = coordinator.waitUntilGranted(request({
      automation: automation({ timeoutMs: 20, unrecognizedGraceMs: 2 }),
    })).catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    const error = await outcome
    expect(error).toBeInstanceOf(TaskExecutionError)
    expect(error).toMatchObject({
      code: 'RUNTIME_PERMISSION_DIALOG_TIMEOUT',
      message: expect.stringContaining('没有发生可验证迁移'),
    })
    expect(dialogs.saveTimeoutDiagnostics).toHaveBeenCalledOnce()
  })
})
