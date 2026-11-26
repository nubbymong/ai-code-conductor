import type React from 'react'
import { create } from 'zustand'

/**
 * A terminal that starts while another pane is in front of it (2.1.3-beta.19
 * fix round). A Restart remounts the tab's terminal view, and the view builds
 * its terminal and starts its PTY only once its pane has a size
 * (TerminalView initTerminal and fitAndSpawn, aicc_planning#398). With the
 * Agent Canvas, the logs or the browser in front, the terminal's pane is
 * `display: none` (App.tsx), so a Restart pressed there started nothing until
 * the terminal was shown again (on the Rocky line: pressed 10:23:13.887Z,
 * started 69 s later, 3 s after the terminal was brought back).
 *
 * Such a view now says it waits for a size (this store); while it does, App
 * lays its pane out under the pane in front, at that pane's size, invisible
 * and out of the pointer's way, so the view builds its terminal and starts at
 * once at the size it would have. Once it has fitted, it stops waiting and the
 * pane is hidden again. A view whose tab is not the one shown still waits as
 * before (its whole tab is hidden), and a main view behind the partner
 * terminal still starts only when it is shown.
 */
interface TerminalSizeWaitState {
  /** The terminal views (by their PTY id) waiting for a size to start in. */
  waiting: Record<string, true>
  set: (ptyId: string, on: boolean) => void
}

export const useTerminalSizeWaitStore = create<TerminalSizeWaitState>((set) => ({
  waiting: {},
  set: (ptyId, on) => set((s) => {
    if (on === (s.waiting[ptyId] === true)) return s
    const waiting = { ...s.waiting }
    if (on) waiting[ptyId] = true
    else delete waiting[ptyId]
    return { waiting }
  }),
}))

/**
 * A session's terminal pane: shown; laid out behind the pane in front
 * (`startsBehind`: it is the terminal that pane covers, and its view waits for
 * a size to start in); or hidden. The session's own wrapper is `position:
 * relative` while one starts behind (App.tsx).
 */
export function terminalPaneStyle(o: { shown: boolean; startsBehind: boolean }): React.CSSProperties {
  if (o.shown) return { display: 'flex', minHeight: 0 }
  if (o.startsBehind) return { display: 'flex', minHeight: 0, position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none' }
  return { display: 'none', minHeight: 0 }
}
