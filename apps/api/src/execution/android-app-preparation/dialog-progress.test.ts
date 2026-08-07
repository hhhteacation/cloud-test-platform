import { describe, expect, it } from 'vitest'

import type { InstallProgressSignature } from './dialog-state.js'
import { DialogProgressTracker } from './dialog-progress.js'

function signature(overrides: Partial<InstallProgressSignature> = {}): InstallProgressSignature {
  return {
    pageKind: 'unrecognized-page',
    windowPackage: 'com.android.packageinstaller',
    windowComponent: 'com.android.packageinstaller/.InstallActivity',
    pageFingerprint: 'installer:loading',
    ...overrides,
  }
}

describe('DialogProgressTracker', () => {
  it('does not reset the grace window when the same business signature is observed again', () => {
    const tracker = new DialogProgressTracker()

    expect(tracker.observe({ kind: 'unrecognized', signature: signature() }, 1_000))
      .toEqual({ changed: true, elapsedMs: 0 })
    expect(tracker.observe({ kind: 'unrecognized', signature: signature() }, 1_400))
      .toEqual({ changed: false, elapsedMs: 400 })
    expect(tracker.observe({ kind: 'waiting', signature: signature() }, 1_900))
      .toEqual({ changed: false, elapsedMs: 900 })
  })

  it('starts a new grace window when the page fingerprint changes', () => {
    const tracker = new DialogProgressTracker()

    tracker.observe({
      kind: 'unrecognized',
      signature: signature({ pageFingerprint: 'installer:checkbox=false' }),
    }, 2_000)
    expect(tracker.observe({
      kind: 'unrecognized',
      signature: signature({ pageFingerprint: 'installer:checkbox=true' }),
    }, 2_800)).toEqual({ changed: true, elapsedMs: 0 })
    expect(tracker.observe({
      kind: 'unrecognized',
      signature: signature({ pageFingerprint: 'installer:checkbox=true' }),
    }, 3_100)).toEqual({ changed: false, elapsedMs: 300 })
  })

  it('treats a recognized target state change as progress even when the page remains on the same window', () => {
    const tracker = new DialogProgressTracker()
    const baseTarget = {
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

    tracker.observe({
      kind: 'waiting',
      signature: signature({
        pageKind: 'recognized-action',
        profileId: 'honor-profile',
        action: 'continue-install',
        target: baseTarget,
      }),
    }, 4_000)

    expect(tracker.observe({
      kind: 'waiting',
      signature: signature({
        pageKind: 'recognized-action',
        profileId: 'honor-profile',
        action: 'continue-install',
        target: { ...baseTarget, enabled: true },
      }),
    }, 4_800)).toEqual({ changed: true, elapsedMs: 0 })
  })

  it('clears the previous observation after reset', () => {
    const tracker = new DialogProgressTracker()

    tracker.observe({ kind: 'waiting', signature: signature({ pageFingerprint: 'installer:continue' }) }, 4_000)
    tracker.reset()

    expect(tracker.observe({
      kind: 'waiting',
      signature: signature({ pageFingerprint: 'installer:continue' }),
    }, 9_000)).toEqual({ changed: true, elapsedMs: 0 })
  })

  it('never reports negative elapsed time when the clock moves backwards', () => {
    const tracker = new DialogProgressTracker()

    tracker.observe({ kind: 'unrecognized', signature: signature() }, 5_000)
    expect(tracker.observe({ kind: 'unrecognized', signature: signature() }, 4_000))
      .toEqual({ changed: false, elapsedMs: 0 })
  })
})
