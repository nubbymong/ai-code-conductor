import { create } from 'zustand'
import type { HostAccountNotice, HostAccountsState, HostLaunchRefusal, HostMachineAccounts } from '../../shared/host-accounts'
import type { RemoteMachineView, RemoteMachinesState } from '../../shared/remote-machines'
import { useSessionStore } from './sessionStore'
import { hostElsewhere, hostLaunchable, machineLabel, type AdoptTab } from '../utils/hostAccounts'

/**
 * 2.1.3-beta.20 section 5 (Accounts across machines): each Linux machine's
 * accounts as its last read found them (phase 3's MACHINES_REMOTE_ACCOUNTS,
 * no exec; then each push as a read lands), the machines' names, the
 * not-signed-in notices waiting to be answered (frame 2), and the tabs that
 * go on once a sign-in there ends signed in.
 *
 * Read by the account cards (frame 1), the Machines card (frame 4) and the
 * Switch Account list (frame 3). Nothing here is saved: the machines are read
 * again in each run, at Check, the start-up list, a sign-in tab's end and
 * each helper tab's launch (main's section 3.1.6), never polled.
 *
 * Round 1 (MAJOR-1): a tab waits for one sign-in tab, not for any sign-in of
 * that account there: see HostWaiting and pruneHostWaits.
 */

/** Why a notice asks (frame 2): a helper tab whose launch started nothing for
 *  its account (`launch`), or a Switch Account to an account not signed in
 *  there (`switch`). */
export type HostNoticeKind = 'launch' | 'switch'

/** One not-signed-in notice. */
export interface HostNotice {
  kind: HostNoticeKind
  /** The tab it is about. */
  sessionId: string
  did: string
  machineName: string
  /** The account asked for. */
  profileId: string
  state: 'not-signed-in' | 'someone-else'
  /** `someone-else`: who its folder there is signed in as. */
  identity?: string
  /** Accounts of this computer signed in on that machine now (the notice's
   *  "another account" choice), the one asked for left out. */
  signedInThere: string[]
  /** Round 1 (MINOR-3): the tab's next start continues its conversation (a
   *  Switch Account's, or a refused start that carried it, or a kept tab). */
  carry?: boolean
  /** Round 1 (MINOR-2): the account's folder there is the app on another
   *  computer's, so no Sign in there is offered. */
  elsewhere?: boolean
  /** Round 2 (R2-1): and it may be this computer's own from an earlier
   *  install (main's refusal `adoptable`): the notice offers Adopt. */
  adoptable?: boolean
}

/** What a tab does once a sign-in on its machine ends signed in: start again
 *  on that account (`restart`, a launch that started nothing) or switch to it
 *  (`switch`). */
export type HostRunMode = 'restart' | 'switch'

/** How long a tab waits for its sign-in tab at most (round 1, MAJOR-1). */
export const SIGN_IN_WAIT_MS = 20 * 60_000
/** How long after its sign-in tab's terminal ended the tab still waits for
 *  that sign-in's end (main reads the machine first): a sign-in tab that
 *  started nothing never sends one. */
export const SIGN_IN_END_GRACE_MS = 90_000

/**
 * A tab waiting for ONE sign-in tab (round 1, MAJOR-1): it goes on only when
 * that sign-in tab ends signed in as that account on that machine, and only
 * while the tab is still the run it was when it began to wait (`createdAt`:
 * a Restart or a Switch starts another). Any other way out drops it.
 */
export interface HostWaiting {
  /** The waiting tab, and its run when it began to wait. */
  sessionId: string
  createdAt: number
  /** The sign-in tab it waits for. */
  signInTabId: string
  did: string
  profileId: string
  mode: HostRunMode
  carry: boolean
  /** Past this it waits no more. */
  until: number
  /** Its sign-in tab's terminal ended: its sign-in end must come by then. */
  endBy?: number
}

/** A tab whose wait is over: it starts again, or switches, on `profileId`. */
export interface HostRun {
  id: number
  sessionId: string
  createdAt: number
  profileId: string
  mode: HostRunMode
  carry: boolean
}

interface HostAccountsStore {
  /** Remote sessions through the helper exist here (Windows) and were read. */
  available: boolean
  /** The helper switch (Settings, General, under Terminal). */
  switchOn: boolean
  /** The added machines, as the Machines page lists them. */
  machines: RemoteMachineView[]
  /** Each machine's accounts, by device id. */
  byDid: Record<string, HostMachineAccounts>
  /** The machines were read once this run. */
  loaded: boolean
  notices: HostNotice[]
  waiting: HostWaiting[]
  runs: HostRun[]
  /** A plain answer the notice host shows (a Switch Account that could not
   *  go ahead), or null. */
  message: { title: string; text: string } | null
  /** Round 2 (R2-1): Adopt asked for (a machine card, an account card, the
   *  notice): the notice host asks first, naming the accounts. */
  adoptAsk: HostAdoptAsk | null

  /** The machines (once per run unless `force`) and their last reads. */
  load: (opts?: { force?: boolean }) => Promise<void>
  /** The Machines page read the machines itself: kept here too. */
  setMachines: (state: RemoteMachinesState) => void
  setAccounts: (state: HostAccountsState) => void
  applyAccounts: (m: HostMachineAccounts) => void
  /** A new notice for a tab drops that tab's wait (it is asked again). */
  openNotice: (n: HostNotice) => void
  closeNotice: (sessionId: string) => void
  waitForSignIn: (w: Omit<HostWaiting, 'until' | 'endBy'>) => void
  /** The tab waits no more (Cancel, another account, a switch). */
  dropWaits: (sessionId: string) => void
  /** Sign-in tab `signInTabId` ended (`sign-in-ended`): the tab waiting on
   *  it, for that account and machine, goes on when it ended signed in, else
   *  stops waiting. Any other sign-in's end changes nothing. */
  signInEnded: (signInTabId: string, did: string, profileId: string, launchable: boolean) => void
  takeRun: (id: number) => void
  showMessage: (m: { title: string; text: string } | null) => void
  askAdopt: (a: HostAdoptAsk | null) => void
}

/** Round 2 (R2-1): an Adopt to ask about: the machine, its short name, and
 *  the folders (by this computer's profile ids) Adopt would take. */
export interface HostAdoptAsk {
  did: string
  machineName: string
  profileIds: string[]
  /** Round 3 (R3-2), round 4 (R4-1, R4-3): asked from a tab's notice: the
   *  tab, the account it asked for and why it asked; its result names the
   *  tab's next step only once that account was adopted (adoptNextText). */
  tab?: AdoptTab
}

let loading: Promise<void> | null = null
let runSeq = 0
let pruneTimer: ReturnType<typeof setTimeout> | null = null
/** The tabs whose last start carried their conversation (round 1, MINOR-3;
 *  TerminalView notes each SSH start), by session id. */
const carriedStarts = new Set<string>()

/** TerminalView, at each SSH start: whether it carried the conversation. */
export function noteStartCarried(sessionId: string, carried: boolean): void {
  if (carried) carriedStarts.add(sessionId)
  else carriedStarts.delete(sessionId)
}

/** The tab's last start carried its conversation (a refused one's retry carries it again). */
export function startCarried(sessionId: string): boolean {
  return carriedStarts.has(sessionId)
}

const INITIAL = {
  available: false,
  switchOn: false,
  machines: [] as RemoteMachineView[],
  byDid: {} as Record<string, HostMachineAccounts>,
  loaded: false,
  notices: [] as HostNotice[],
  waiting: [] as HostWaiting[],
  runs: [] as HostRun[],
  message: null as { title: string; text: string } | null,
  adoptAsk: null as HostAdoptAsk | null,
}

export const useHostAccountsStore = create<HostAccountsStore>((set, get) => ({
  ...INITIAL,

  load: async (opts = {}) => {
    const remote = window.electronAPI?.machines?.remote
    if (!remote) return
    if (loading) return loading
    loading = (async () => {
      try {
        if ((!get().loaded || opts.force) && typeof remote.state === 'function') {
          get().setMachines(await remote.state())
        }
        if (typeof remote.accounts === 'function') get().setAccounts(await remote.accounts())
      } catch {
        /* nothing read: the lines stay as they were */
      } finally {
        loading = null
      }
    })()
    return loading
  },

  setMachines: (state) => set({ available: state.available, switchOn: state.switchOn, machines: state.machines, loaded: true }),

  setAccounts: (state) => {
    const byDid: Record<string, HostMachineAccounts> = {}
    for (const m of state.machines ?? []) if (m && typeof m.did === 'string') byDid[m.did] = m
    set({ byDid })
  },

  applyAccounts: (m) => {
    if (!m || typeof m.did !== 'string') return
    set((s) => ({ byDid: { ...s.byDid, [m.did]: m } }))
  },

  openNotice: (n) => set((s) => ({
    notices: [...s.notices.filter((x) => x.sessionId !== n.sessionId), n],
    waiting: s.waiting.filter((w) => w.sessionId !== n.sessionId),
  })),

  closeNotice: (sessionId) => set((s) => ({ notices: s.notices.filter((x) => x.sessionId !== sessionId) })),

  waitForSignIn: (w) => {
    set((s) => ({ waiting: [...s.waiting.filter((x) => x.sessionId !== w.sessionId), { ...w, until: Date.now() + SIGN_IN_WAIT_MS }] }))
    schedulePrune()
  },

  dropWaits: (sessionId) => set((s) => (s.waiting.some((w) => w.sessionId === sessionId) ? { waiting: s.waiting.filter((w) => w.sessionId !== sessionId) } : {})),

  signInEnded: (signInTabId, did, profileId, launchable) => set((s) => {
    const mine = (w: HostWaiting) => w.signInTabId === signInTabId && w.did === did && w.profileId === profileId
    const done = s.waiting.filter(mine)
    if (done.length === 0) return {}
    const waiting = s.waiting.filter((w) => !mine(w))
    if (!launchable) return { waiting }
    return { waiting, runs: [...s.runs, ...done.map((w) => ({ id: ++runSeq, sessionId: w.sessionId, createdAt: w.createdAt, profileId: w.profileId, mode: w.mode, carry: w.carry }))] }
  }),

  takeRun: (id) => set((s) => ({ runs: s.runs.filter((r) => r.id !== id) })),

  showMessage: (message) => set({ message }),

  askAdopt: (adoptAsk) => set({ adoptAsk }),
}))

/**
 * Round 1 (MAJOR-1): drop each wait that no longer holds: its waiting tab
 * closed or started again (another run), its sign-in tab closed, its time
 * limit passed, or its sign-in tab's terminal ended and no sign-in end came
 * within the grace. A sign-in tab whose terminal ended starts that grace.
 * Then the next check is set for the nearest deadline.
 */
export function pruneHostWaits(now = Date.now()): void {
  const store = useHostAccountsStore.getState()
  if (store.waiting.length === 0) { schedulePrune(); return }
  const sessions = useSessionStore.getState().sessions
  let changed = false
  const waiting: HostWaiting[] = []
  for (const w of store.waiting) {
    const tab = sessions.find((s) => s.id === w.sessionId)
    const signIn = sessions.find((s) => s.id === w.signInTabId)
    const endBy = w.endBy ?? (signIn?.ptyExited ? now + SIGN_IN_END_GRACE_MS : undefined)
    // Round 2 (R1-N1): a finished sign-in tab closed before main's read after
    // it answers keeps the wait until the grace ends; one closed before it
    // finished (no end seen) drops it.
    const holds = !!tab && tab.createdAt === w.createdAt && (!!signIn || endBy !== undefined) && now < w.until && !(endBy !== undefined && now > endBy)
    if (!holds) { changed = true; continue }
    if (endBy !== w.endBy) changed = true
    waiting.push(endBy !== w.endBy ? { ...w, endBy } : w)
  }
  if (changed) useHostAccountsStore.setState({ waiting })
  schedulePrune()
}

/** The next check of the waits, at the nearest deadline (none: no timer). */
function schedulePrune(): void {
  if (pruneTimer) { clearTimeout(pruneTimer); pruneTimer = null }
  const waits = useHostAccountsStore.getState().waiting
  if (waits.length === 0) return
  const next = Math.min(...waits.map((w) => Math.min(w.until, w.endBy ?? Infinity)))
  pruneTimer = setTimeout(() => { pruneTimer = null; pruneHostWaits() }, Math.max(0, next - Date.now()) + 50)
}

/** For tests: back to a store that read nothing. */
export function resetHostAccountsStore(): void {
  loading = null
  if (pruneTimer) { clearTimeout(pruneTimer); pruneTimer = null }
  carriedStarts.clear()
  useHostAccountsStore.setState({ ...INITIAL })
}

/** The notice a launch refusal asks (frame 2), or null: a refusal for a
 *  machine whose accounts could not be read says so in its tab and asks
 *  nothing here (its choices would not hold: nothing is known there). */
export function noticeOfRefusal(sessionId: string, r: HostLaunchRefusal, label?: string, more: Pick<HostNotice, 'carry' | 'elsewhere' | 'adoptable'> = {}): HostNotice | null {
  // Round 2 (R2-1): main names the folder as another install's that may be
  // this computer's own; its folder there is another's either way. Round 3
  // (R3-1): one rule with the cards: not when the machine's read says not
  // every such folder there is this computer's (`more.adoptable` false).
  const adoptable = r.adoptable === true && more.adoptable !== false
  if (r.state !== 'not-signed-in' && r.state !== 'someone-else') return null
  return {
    kind: 'launch',
    sessionId,
    did: r.did,
    // The machine's short name when its card is known here, else main's.
    machineName: label || r.machineName,
    profileId: r.profileId,
    state: r.state,
    ...(r.identity ? { identity: r.identity } : {}),
    signedInThere: r.signedInThere.filter((id) => id !== r.profileId),
    ...(more.carry ? { carry: true } : {}),
    ...(more.elsewhere || adoptable ? { elsewhere: true } : {}),
    ...(adoptable ? { adoptable: true } : {}),
  }
}

/** One push from main (REMOTE_ACCOUNT_NOTICE): a launch that started nothing
 *  opens its notice (for a tab that is still open, and not a sign-in tab),
 *  carrying the conversation again when that start carried it or the tab is
 *  kept, and saying so when the account's folder there is another
 *  computer's; a sign-in tab's end lets the tab waiting on THAT tab go on. */
export function handleHostAccountNotice(n: HostAccountNotice): void {
  const store = useHostAccountsStore.getState()
  if (!n || typeof n !== 'object') return
  if (n.kind === 'launch-refused') {
    const s = useSessionStore.getState().sessions.find((x) => x.id === n.sessionId)
    if (!s || s.remoteAccountSignIn) return
    const m = store.machines.find((x) => x.did === n.refusal?.did)
    const kept = s.remoteVia === 'helper' && s.sshConfig?.detachable !== false
    const notice = noticeOfRefusal(n.sessionId, n.refusal, m ? machineLabel(m) : undefined, {
      carry: startCarried(n.sessionId) || kept,
      elsewhere: hostElsewhere(store.byDid[n.refusal?.did ?? ''], n.refusal?.profileId ?? ''),
      // Round 3 (R3-1): the machine's read decides as the cards decide.
      ...(store.byDid[n.refusal?.did ?? '']?.readAt != null && store.byDid[n.refusal?.did ?? '']?.mayBeEarlierInstall !== true ? { adoptable: false } : {}),
    })
    if (notice) store.openNotice(notice)
    return
  }
  if (n.kind === 'sign-in-ended') store.signInEnded(n.sessionId, n.did, n.profileId, hostLaunchable(n.state))
}

/** The app root listens once: each machine's read as it lands, each account
 *  notice, and the tabs (a wait whose tab closed or started again goes).
 *  Returns the unsubscribe. */
export function listenHostAccounts(): () => void {
  const remote = window.electronAPI?.machines?.remote
  const offs: Array<() => void> = []
  if (typeof remote?.onAccountsChanged === 'function') offs.push(remote.onAccountsChanged((m) => useHostAccountsStore.getState().applyAccounts(m)))
  if (typeof remote?.onAccountNotice === 'function') offs.push(remote.onAccountNotice((n) => handleHostAccountNotice(n)))
  offs.push(useSessionStore.subscribe(() => { if (useHostAccountsStore.getState().waiting.length > 0) pruneHostWaits() }))
  return () => { for (const off of offs) { try { off() } catch { /* gone */ } } }
}
