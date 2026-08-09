import { describe, expect, it } from 'vitest'

import { DialogPhaseStateMachine } from './dialog-phase-state-machine.js'
import type { DialogInspectionResult } from './dialog-state.js'

const recognizedSignature = {
  pageKind: 'recognized-action' as const,
  windowPackage: 'com.oplus.appdetail',
  windowComponent: 'com.oplus.appdetail/.InstallGuideActivity',
  profileId: 'oplus-package-installer-v1',
  action: 'continue-install' as const,
  pageFingerprint: 'pkr110-install-risk-page',
}

const handled: DialogInspectionResult = {
  kind: 'handled',
  signature: recognizedSignature,
  dialog: {
    profileId: 'oplus-package-installer-v1',
    action: 'continue-install',
    timestamp: '2026-08-09T05:30:00.000Z',
  },
}

const waiting: DialogInspectionResult = {
  kind: 'waiting',
  signature: recognizedSignature,
  reason: 'action-awaiting-transition',
}

describe('DialogPhaseStateMachine', () => {
  it('owns action, waiting, and stalled transitions for one business phase', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'install',
      stalledAfterMs: 1_000,
    })

    expect(machine.observe(handled, 10_000)).toMatchObject({
      state: 'action-executed',
      enteredStates: ['action-required', 'action-executed'],
      stable: false,
    })
    expect(machine.observe(waiting, 10_100)).toMatchObject({
      state: 'waiting-transition',
      signatureChanged: true,
      elapsedMs: 0,
      stable: false,
    })
    expect(machine.observe(waiting, 11_100)).toMatchObject({
      state: 'stalled',
      signatureChanged: false,
      elapsedMs: 1_000,
      stable: true,
    })
    expect(machine.handledDialogs()).toEqual([handled.dialog])
  })

  it('verifies a handled page transition when the dialog disappears', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'install',
      stalledAfterMs: 1_000,
    })

    machine.observe(handled, 10_000)

    expect(machine.observe({ kind: 'none' }, 10_100)).toMatchObject({
      state: 'completed',
      enteredStates: ['completed'],
      stable: true,
      transitionVerified: true,
    })
  })

  it('preserves a known manual-action block as a terminal business state', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'runtime-permission',
      stalledAfterMs: 1_000,
    })

    expect(machine.observe({
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
    }, 10_000)).toMatchObject({
      state: 'manual-action-required',
      enteredStates: ['manual-action-required'],
      stable: true,
      transitionVerified: false,
    })
  })

  it('requires an unchanged unknown business signature to become stable', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'post-launch',
      stalledAfterMs: 1_000,
    })
    const unknown: DialogInspectionResult = {
      kind: 'unrecognized',
      signature: {
        pageKind: 'unrecognized-page',
        windowPackage: 'com.oplus.appdetail',
        pageFingerprint: 'unknown-page-a',
      },
    }

    expect(machine.observe(unknown, 10_000)).toMatchObject({
      state: 'unrecognized',
      signatureChanged: true,
      elapsedMs: 0,
      stable: false,
    })
    expect(machine.observe(unknown, 11_000)).toMatchObject({
      state: 'unrecognized',
      signatureChanged: false,
      elapsedMs: 1_000,
      stable: true,
    })
  })

  it('restarts the stability clock when the business signature changes', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'post-launch',
      stalledAfterMs: 1_000,
    })

    machine.observe({
      kind: 'unrecognized',
      signature: {
        pageKind: 'unrecognized-page',
        windowPackage: 'com.oplus.appdetail',
        pageFingerprint: 'unknown-page-a',
      },
    }, 10_000)

    expect(machine.observe({
      kind: 'unrecognized',
      signature: {
        pageKind: 'unrecognized-page',
        windowPackage: 'com.oplus.appdetail',
        pageFingerprint: 'unknown-page-b',
      },
    }, 10_900)).toMatchObject({
      state: 'unrecognized',
      signatureChanged: true,
      elapsedMs: 0,
      stable: false,
    })
  })

  it('records cancellation as the final phase state', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'install',
      stalledAfterMs: 1_000,
    })

    expect(machine.cancel()).toBe('cancelled')
    expect(machine.state()).toBe('cancelled')
  })

  it('records an external phase failure without changing its business cause', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'runtime-permission',
      stalledAfterMs: 1_000,
    })

    expect(machine.fail()).toBe('failed')
    expect(machine.state()).toBe('failed')
  })

  it('records externally verified phase completion', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'runtime-permission',
      stalledAfterMs: 1_000,
    })

    expect(machine.complete()).toBe('completed')
    expect(machine.state()).toBe('completed')
  })

  it('classifies a phase timeout after an action as stalled', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'install',
      stalledAfterMs: 1_000,
    })

    machine.observe(handled, 10_000)

    expect(machine.markTimeout()).toBe('stalled')
    expect(machine.state()).toBe('stalled')
  })

  it('classifies a phase timeout without an awaiting transition as failed', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'post-launch',
      stalledAfterMs: 1_000,
    })

    expect(machine.markTimeout()).toBe('failed')
    expect(machine.state()).toBe('failed')
  })

  it('treats a recognized target state change as business progress', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'install',
      stalledAfterMs: 1_000,
    })
    const target = {
      resourceId: 'android:id/button1',
      text: '继续',
      contentDescription: '',
      enabled: false,
      checkable: false,
      checked: false,
      bounds: '0,0,100,100',
      tapX: 50,
      tapY: 50,
    }

    machine.observe({
      kind: 'waiting',
      reason: 'action-awaiting-transition',
      signature: { ...recognizedSignature, target },
    }, 10_000)

    expect(machine.observe({
      kind: 'waiting',
      reason: 'action-awaiting-transition',
      signature: {
        ...recognizedSignature,
        target: { ...target, enabled: true },
      },
    }, 10_900)).toMatchObject({
      signatureChanged: true,
      elapsedMs: 0,
      stable: false,
    })
  })

  it('never reports negative stability time when the observation clock moves backwards', () => {
    const machine = new DialogPhaseStateMachine({
      phase: 'post-launch',
      stalledAfterMs: 1_000,
    })
    const unknown: DialogInspectionResult = {
      kind: 'unrecognized',
      signature: {
        pageKind: 'unrecognized-page',
        windowPackage: 'com.oplus.appdetail',
        pageFingerprint: 'same-unknown-page',
      },
    }

    machine.observe(unknown, 10_000)

    expect(machine.observe(unknown, 9_000)).toMatchObject({
      signatureChanged: false,
      elapsedMs: 0,
      stable: false,
    })
  })
})
