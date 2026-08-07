import type { DialogActionKind, DialogBlockMatch } from './dialog-profiles.js'
import type { HandledDialog } from './contracts.js'

/**
 * Business-relevant state used to decide whether a dialog phase is making
 * progress. A raw UI-node fingerprint is retained as evidence, but it is not
 * the only state used by the coordinator.
 */
export type DialogPageKind =
  | 'recognized-action'
  | 'unrecognized-page'
  | 'manual-action-required'

export interface InstallProgressSignature {
  pageKind: DialogPageKind
  windowPackage: string
  windowComponent?: string
  profileId?: string
  action?: DialogActionKind
  pageFingerprint?: string
  target?: {
    resourceId: string
    text: string
    contentDescription: string
    enabled: boolean
    checkable: boolean
    checked: boolean
    bounds?: string
    tapX: number
    tapY: number
  }
}

export type DialogProgressObservation = {
  kind: 'unrecognized' | 'waiting'
  signature: InstallProgressSignature
}

export type DialogInspectionResult =
  | { kind: 'none' }
  | {
    kind: 'handled'
    dialog: HandledDialog
    signature: InstallProgressSignature
  }
  | {
    kind: 'manual-action-required'
    block: DialogBlockMatch
    signature: InstallProgressSignature
  }
  | {
    kind: 'unrecognized'
    signature: InstallProgressSignature
  }
  | {
    kind: 'waiting'
    signature: InstallProgressSignature
    reason: 'action-awaiting-transition'
  }

/**
 * Converts the structured signature into a stable comparison key. Keeping
 * this in the domain seam prevents each coordinator from inventing a
 * different definition of "the same page".
 */
export function progressSignatureKey(signature: InstallProgressSignature) {
  return JSON.stringify([
    signature.pageKind,
    signature.windowPackage,
    signature.windowComponent ?? '',
    signature.profileId ?? '',
    signature.action ?? '',
    signature.pageFingerprint ?? '',
    signature.target
      ? [
        signature.target.resourceId,
        signature.target.text,
        signature.target.contentDescription,
        signature.target.enabled,
        signature.target.checkable,
        signature.target.checked,
        signature.target.bounds ?? '',
        signature.target.tapX,
        signature.target.tapY,
      ]
      : null,
  ])
}
