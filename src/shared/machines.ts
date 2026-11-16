/**
 * The Machines page's seam (2.1.3-beta.6, plan section C).
 *
 * The page asks one MachinesSource what the session helper on a machine is
 * doing and which sessions it holds. This beta has one machine, This computer.
 * Main owns the source: the default one (src/main/ipc/machines-handlers.ts)
 * says the helper is off and holds nothing, and the helper work swaps in the
 * real one with setMachinesSource. The renderer only ever sees these types over
 * the typed bridge, so nothing here may name a path, a pipe or a process id.
 */

/** A terminal a session helper holds for a machine. */
export interface HeldSession {
  /** Stable id of the held terminal; the same string End and Re-attach take. */
  id: string
  /** A plain Terminal only tab, or a partner terminal beside an assistant. */
  kind: 'plain' | 'partner'
  /** What the tab is called, for the row. */
  label: string
  /** When the helper started it (ms since the epoch). */
  startedAt: number
  /** True while the app is connected to it. */
  attached: boolean
  /** True while a tab in the app shows it. A held terminal with no app
   *  attached and no tab is one a crash left behind. */
  tabOpen: boolean
}

/** What the session helper is doing on a machine. */
export type HelperState = 'off' | 'not-installed' | 'starting' | 'ready' | 'failed'

/** The answer of one helper self-test. */
export interface SelfTestResult {
  ok: boolean
  /** When the test finished (ms since the epoch). */
  at: number
  /** A plain sentence about what failed, or what passed. */
  detail?: string
}

/** Everything the page shows for one machine. */
export interface MachineStatus {
  id: 'this-computer'
  name: string
  helper: {
    state: HelperState
    version?: string
    /** The latest self-test, when one has run. */
    selfTest?: SelfTestResult
    /** A plain sentence that goes with the state (why it failed, say). */
    detail?: string
  }
  sessions: HeldSession[]
}

/** The answer of an action on one held session. A refusal carries a plain sentence. */
export interface MachineActionResult {
  ok: boolean
  message?: string
}

/** What the Machines page reads and does. Main owns the one that is plugged in. */
export interface MachinesSource {
  status(): Promise<MachineStatus>
  runSelfTest(): Promise<SelfTestResult>
  endSession(id: string): Promise<MachineActionResult>
  reattach(id: string): Promise<MachineActionResult>
}

/**
 * The shape of a held terminal's id. It is the session id the helper protocol
 * fixes (docs/remote/helper-protocol.md, section 1). End and Re-attach hand the
 * same string to the helper (`end --session <sid>`), so nothing else (a space,
 * a control character, a leading dash, a newline, a longer string) is ever a
 * held id. A source must hand the page ids of this shape.
 */
export const HELD_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,31}$/

/** What the page says when the source throws or stays silent. Main and the page both use it. */
export const MACHINES_NO_ANSWER = 'The session helper did not answer.'
