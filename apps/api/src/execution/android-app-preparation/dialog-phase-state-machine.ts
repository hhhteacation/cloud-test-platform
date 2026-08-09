import {
  createDialogInteractionState,
  type DialogInteractionState,
  type HandledDialog,
} from './contracts.js'
import type { DialogBusinessPhase } from './dialog-profiles.js'
import {
  progressSignatureKey,
  type DialogInspectionResult,
} from './dialog-state.js'

export type DialogCoordinatorState =
  | 'observing'
  | 'action-required'
  | 'action-executed'
  | 'waiting-transition'
  | 'completed'
  | 'manual-action-required'
  | 'unrecognized'
  | 'stalled'
  | 'failed'
  | 'cancelled'

export interface DialogPhaseStateMachineOptions {
  phase: DialogBusinessPhase
  stalledAfterMs: number
}

export interface DialogPhaseObservation {
  state: DialogCoordinatorState
  enteredStates: DialogCoordinatorState[]
  signatureChanged: boolean
  elapsedMs: number
  stable: boolean
  transitionVerified: boolean
}

type TemporalDialogInspection = Extract<
  DialogInspectionResult,
  { kind: 'unrecognized' | 'waiting' }
>

/**
 * Single writer for temporal dialog state inside one business phase.
 *
 * Profiles classify page facts and the controller may execute one safe action;
 * this module alone owns action history, repeated-signature timing, transition
 * verification and the phase state exposed to coordinators.
 */
export class DialogPhaseStateMachine {
  private readonly interaction = createDialogInteractionState()
  private readonly handled: HandledDialog[] = []
  private currentState: DialogCoordinatorState = 'observing'
  private awaitingTransition = false
  private progressSignature: string | undefined
  private progressObservedAt = 0

  constructor(private readonly options: DialogPhaseStateMachineOptions) {}

  interactionState(): DialogInteractionState {
    return this.interaction
  }

  state(): DialogCoordinatorState {
    return this.currentState
  }

  handledDialogs(): HandledDialog[] {
    return [...this.handled]
  }

  cancel(): DialogCoordinatorState {
    this.awaitingTransition = false
    this.currentState = 'cancelled'
    return this.currentState
  }

  fail(): DialogCoordinatorState {
    this.awaitingTransition = false
    this.currentState = 'failed'
    return this.currentState
  }

  complete(): DialogCoordinatorState {
    this.awaitingTransition = false
    this.currentState = 'completed'
    return this.currentState
  }

  markTimeout(): DialogCoordinatorState {
    this.currentState = this.awaitingTransition || this.currentState === 'waiting-transition'
      ? 'stalled'
      : 'failed'
    this.awaitingTransition = false
    return this.currentState
  }

  private observeProgress(inspection: TemporalDialogInspection, now: number) {
    const nextSignature = progressSignatureKey(inspection.signature)
    if (this.progressSignature !== nextSignature) {
      this.progressSignature = nextSignature
      this.progressObservedAt = now
      return { changed: true, elapsedMs: 0 }
    }

    return {
      changed: false,
      elapsedMs: Math.max(0, now - this.progressObservedAt),
    }
  }

  private resetProgress() {
    this.progressSignature = undefined
    this.progressObservedAt = 0
  }

  observe(inspection: DialogInspectionResult, now = Date.now()): DialogPhaseObservation {
    if (inspection.kind === 'none') {
      this.resetProgress()
      const transitionVerified = this.awaitingTransition
      this.awaitingTransition = false
      this.currentState = transitionVerified ? 'completed' : 'observing'
      return {
        state: this.currentState,
        enteredStates: [this.currentState],
        signatureChanged: transitionVerified,
        elapsedMs: 0,
        stable: transitionVerified,
        transitionVerified,
      }
    }

    if (inspection.kind === 'handled') {
      this.resetProgress()
      this.handled.push(inspection.dialog)
      this.awaitingTransition = true
      this.currentState = 'action-executed'
      return {
        state: this.currentState,
        enteredStates: ['action-required', 'action-executed'],
        signatureChanged: true,
        elapsedMs: 0,
        stable: false,
        transitionVerified: false,
      }
    }

    if (inspection.kind === 'manual-action-required') {
      this.resetProgress()
      this.awaitingTransition = false
      this.currentState = 'manual-action-required'
      return {
        state: this.currentState,
        enteredStates: [this.currentState],
        signatureChanged: true,
        elapsedMs: 0,
        stable: true,
        transitionVerified: false,
      }
    }

    if (inspection.kind === 'waiting') {
      const progress = this.observeProgress(inspection, now)
      this.currentState = progress.elapsedMs >= this.options.stalledAfterMs
        ? 'stalled'
        : 'waiting-transition'
      return {
        state: this.currentState,
        enteredStates: [this.currentState],
        signatureChanged: progress.changed,
        elapsedMs: progress.elapsedMs,
        stable: this.currentState === 'stalled',
        transitionVerified: false,
      }
    }

    if (inspection.kind === 'unrecognized') {
      const progress = this.observeProgress(inspection, now)
      this.currentState = 'unrecognized'
      return {
        state: this.currentState,
        enteredStates: [this.currentState],
        signatureChanged: progress.changed,
        elapsedMs: progress.elapsedMs,
        stable: progress.elapsedMs >= this.options.stalledAfterMs,
        transitionVerified: false,
      }
    }

    return inspection satisfies never
  }
}
