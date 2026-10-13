import { create } from 'zustand'

// WP2 commit 6: the per-launch acknowledgement an unverified sign-in needs
// (design 5.5). Transient by construction -- module state and a Zustand
// queue, never persisted, never written to a config or a session record.
//
// Two ways a launch is acknowledged:
//  - the New session dialog's checkbox, which covers exactly the launch the
//    dialog starts: a one-shot GRANT for that session id and account id,
//    consumed by the session's first spawn;
//  - a small confirm asked right before any other spawn of such a session
//    (a restart, a reopen after an app restart, a multi-spawn copy). This is
//    the same queue-and-promise pattern as the Claude account launch gate
//    (accountGateStore), kept separate from it.
// A declined confirm spawns nothing.
//
// O5 (owner decision 2026-10-11): a launch on the account 2.1.1-beta.2
// registered for the provider's own sign-in already on this computer may be
// answered a third way, "use this other account of the provider instead"
// (offered only when the launch asked for it: `offerSwitch`, read through
// requestChoice). Plain request() never sees that answer as a yes.

/** Session id -> the account id its one launch was acknowledged for. */
const grants = new Map<string, string>()

/** The dialog's ticked checkbox: acknowledge the one launch of `sessionId`
 *  on `accountId`. */
export function grantLaunchAcknowledgement(sessionId: string, accountId: string): void {
  grants.set(sessionId, accountId)
}

/** Use up a session's grant. True only for the account it was given for;
 *  either way the grant is gone, so it never covers a second launch. */
export function consumeLaunchAcknowledgement(sessionId: string, accountId: string): boolean {
  const granted = grants.get(sessionId)
  grants.delete(sessionId)
  return granted !== undefined && granted === accountId
}

/** A launch's answer: yes, no, or (only where offered) another account of the
 *  same provider to launch on instead. */
export type LaunchAckAnswer = boolean | { switchTo: string }

export interface PendingLaunchAck {
  /** This question, and no other: an answer names it, so a click meant for
   *  one launch can never land on the next one in the queue. */
  requestId: number
  sessionId: string
  /** The session's name, for the confirm's subtitle. */
  sessionLabel: string
  /** The account's name, as the Accounts surface shows it. */
  accountName: string
  /** The account's email, when known. */
  email?: string
  /** The provider's own home on this computer, rather than an account whose
   *  sign-in is merely unverified: the confirm words each differently. */
  external: boolean
  /** The account list could not be read, so the app cannot tell what this
   *  sign-in is: it asks anyway, and main still validates the account. */
  unknown: boolean
  /** A Cloud Agent's Retry, not a session launch: the confirm says so (P4.11). */
  retryAgent?: boolean
  /** The account this launch is on (the one asked about), when known. */
  accountId?: string
  /** O5: the confirm may offer another account of the provider instead (the launch
   *  then moves the session, and a saved config that used this account, to
   *  the one picked). */
  offerSwitch?: boolean
  /** O5: this launch resumes one exact conversation (a restored tab). Moved
   *  to another account from the confirm, it starts without it: an exact
   *  resume looks only in that account's own conversations, and nothing is
   *  carried at a launch (only a running session's Switch account carries
   *  one). The confirm says so where it offers the move. */
  resumesConversation?: boolean
  resolve: (answer: LaunchAckAnswer) => void
}

interface LaunchAckState {
  /** FIFO of launches waiting for a yes or no. The confirm renders queue[0]. */
  queue: PendingLaunchAck[]
  request: (req: Omit<PendingLaunchAck, 'resolve' | 'requestId' | 'offerSwitch'>) => Promise<boolean>
  /** As request, but answered with LaunchAckAnswer: another account is a
   *  possible answer when `offerSwitch` is set. */
  requestChoice: (req: Omit<PendingLaunchAck, 'resolve' | 'requestId'>) => Promise<LaunchAckAnswer>
  /** Answer ONE question, by its id. An id no longer queued (withdrawn, or
   *  already answered) is ignored. */
  answer: (requestId: number, yes: boolean) => void
  /** Answer ONE question with another account, by its id. Ignored unless
   *  that question offered it (`offerSwitch`), and for an empty id or the
   *  very account the question is about. */
  switchAccount: (requestId: number, accountId: string) => void
  /** Re-entry guard: a confirm is already queued for this session. */
  isPending: (sessionId: string) => boolean
  /** The view that asked is gone (a closed tab, a restart that remounts it):
   *  drop its question, answered "no", so nothing spawns from it and a
   *  remounted view can ask afresh. */
  withdraw: (sessionId: string) => void
}

let nextRequestId = 1

export const useLaunchAckStore = create<LaunchAckState>((set, get) => ({
  queue: [],
  // Never offers another account, and an answer that is not a plain yes is a no.
  request: (req) => get().requestChoice({ ...req, offerSwitch: false }).then((a) => a === true),
  requestChoice: (req) => new Promise<LaunchAckAnswer>((resolve) => {
    const requestId = nextRequestId++
    set((s) => ({ queue: [...s.queue, { ...req, requestId, resolve }] }))
  }),
  answer: (requestId, yes) => {
    const entry = get().queue.find((p) => p.requestId === requestId)
    if (!entry) return
    set((s) => ({ queue: s.queue.filter((p) => p.requestId !== requestId) }))
    // After the state update, so the awaiting launch sees a settled queue.
    entry.resolve(yes === true)
  },
  switchAccount: (requestId, accountId) => {
    const entry = get().queue.find((p) => p.requestId === requestId)
    if (!entry || entry.offerSwitch !== true) return
    if (typeof accountId !== 'string' || !accountId || accountId === entry.accountId) return
    set((s) => ({ queue: s.queue.filter((p) => p.requestId !== requestId) }))
    entry.resolve({ switchTo: accountId })
  },
  isPending: (sessionId) => get().queue.some((p) => p.sessionId === sessionId),
  withdraw: (sessionId) => {
    const gone = get().queue.filter((p) => p.sessionId === sessionId)
    if (gone.length === 0) return
    set((s) => ({ queue: s.queue.filter((p) => p.sessionId !== sessionId) }))
    for (const p of gone) p.resolve(false)
  },
}))
