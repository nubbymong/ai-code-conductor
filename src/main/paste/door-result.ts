// The session input module's clipboard paste door's answer as a press's
// (ADR-032; plan 2.1.3-beta.21 phase 2, 2.1.3): one mapping for the paste
// module (./index.ts) and the helper tab's route (./helper-route.ts, plan
// block 5.1), which both ask that one door. Pure: no Electron, so the helper
// route loads under plain Node (tests/live/remote-paste.live.ts).
import { notPasted, type PasteKeyResult } from '../../shared/clipboard-paste'
import type { ClipboardPasteDoorResult } from '../session-input'

/** The door's answer as the press's. */
export function fromDoor(result: ClipboardPasteDoorResult): PasteKeyResult {
  switch (result.outcome) {
    case 'sent': return { outcome: 'sent' }
    case 'placeholder': return { outcome: 'pasted' }
    case 'no-placeholder': return notPasted('no-placeholder')
    case 'busy': return notPasted('busy')
    case 'sentence-not-sent': return notPasted('sentence-not-sent')
    case 'prompt-on-screen': return notPasted('prompt-on-screen')
    case 'session-gone': return notPasted('session-gone')
    case 'refused-key': return notPasted('no-key')
    default: return notPasted('not-available')
  }
}
