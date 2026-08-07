import type { DialogProgressObservation, InstallProgressSignature } from './dialog-state.js'
import { progressSignatureKey } from './dialog-state.js'

export type { DialogProgressObservation } from './dialog-state.js'

export type DialogProgress = {
  changed: boolean
  elapsedMs: number
}

/**
 * Owns the temporal meaning of a repeated dialog observation.
 *
 * The coordinator supplies a structured business progress signature. The
 * tracker does not decide whether a phase is successful or failed; it only
 * reports whether the observed state changed and how long the unchanged state
 * has remained visible.
 */
export class DialogProgressTracker {
  private signatureKey: string | undefined
  private observedAt = 0

  observe(observation: DialogProgressObservation, now = Date.now()): DialogProgress {
    const nextKey = progressSignatureKey(observation.signature)
    if (this.signatureKey !== nextKey) {
      this.signatureKey = nextKey
      this.observedAt = now
      return { changed: true, elapsedMs: 0 }
    }

    return {
      changed: false,
      elapsedMs: Math.max(0, now - this.observedAt),
    }
  }

  reset() {
    this.signatureKey = undefined
    this.observedAt = 0
  }
}

export function dialogProgressObservation(
  inspection: { kind: 'unrecognized' | 'waiting'; signature: InstallProgressSignature },
): DialogProgressObservation {
  return inspection
}
