import { create } from 'zustand'
import type { HostAccountNotice, HostAccountsState, HostLaunchRefusal, HostMachineAccounts } from '../../shared/host-accounts'
import type { RemoteMachineView, RemoteMachinesState } from '../../shared/remote-machines'
import { useSessionStore } from './sessionStore'
import { hostLaunchable, machineLabel } from '../utils/hostAccounts'

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
}

/** What a tab does once a sign-in on its machine ends signed in: start again
 *  on that account (`restart`, a launch that started nothing) or switch to it
 *  (`switch`). */
export type HostRunMode = 'restart' | 'switch'

/** A tab waiting for a sign-in on its machine to end. */
export interface HostWaiting {
  sessionId: string
  did: string
  profileId: string
  mode: HostRunMode
}

/** A tab whose wait is over: it starts again, or switches, on `profileId`. */
export interface HostRun {
  id: number
  sessionId: string
  profileId: string
  mode: HostRunMode
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

  /** The machines (once per run unless `force`) and their last reads. */
  load: (opts?: { force?: boolean }) => Promise<void>
  /** The Machines page read the machines itself: kept here too. */
  setMachines: (state: RemoteMachinesState) => void
  setAccounts: (state: HostAccountsState) => void
  applyAccounts: (m: HostMachineAccounts) => void
  openNotice: (n: HostNotice) => void
  closeNotice: (sessionId: string) => void
  waitForSignIn: (w: HostWaiting) => void
  /** A sign-in tab ended (`sign-in-ended`): the tabs waiting on that account
   *  and machine go on when it ended signed in, else stop waiting. */
  signInEnded: (did: string, profileId: string, launchable: boolean) => void
  takeRun: (id: number) => void
  showMessage: (m: { title: string; text: string } | null) => void
}

let loading: Promise<void> | null = null
let runSeq = 0

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

  openNotice: (n) => set((s) => ({ notices: [...s.notices.filter((x) => x.sessionId !== n.sessionId), n] })),

  closeNotice: (sessionId) => set((s) => ({ notices: s.notices.filter((x) => x.sessionId !== sessionId) })),

  waitForSignIn: (w) => set((s) => ({ waiting: [...s.waiting.filter((x) => x.sessionId !== w.sessionId), w] })),

  signInEnded: (did, profileId, launchable) => set((s) => {
    const done = s.waiting.filter((w) => w.did === did && w.profileId === profileId)
    if (done.length === 0) return {}
    const waiting = s.waiting.filter((w) => !(w.did === did && w.profileId === profileId))
    if (!launchable) return { waiting }
    return { waiting, runs: [...s.runs, ...done.map((w) => ({ id: ++runSeq, sessionId: w.sessionId, profileId: w.profileId, mode: w.mode }))] }
  }),

  takeRun: (id) => set((s) => ({ runs: s.runs.filter((r) => r.id !== id) })),

  showMessage: (message) => set({ message }),
}))

/** For tests: back to a store that read nothing. */
export function resetHostAccountsStore(): void {
  loading = null
  useHostAccountsStore.setState({ ...INITIAL })
}

/** The notice a launch refusal asks (frame 2), or null: a refusal for a
 *  machine whose accounts could not be read says so in its tab and asks
 *  nothing here (its choices would not hold: nothing is known there). */
export function noticeOfRefusal(sessionId: string, r: HostLaunchRefusal, label?: string): HostNotice | null {
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
  }
}

/** One push from main (REMOTE_ACCOUNT_NOTICE): a launch that started nothing
 *  opens its notice (for a tab that is still open, and not a sign-in tab); a
 *  sign-in tab's end lets the tabs waiting on it go on. */
export function handleHostAccountNotice(n: HostAccountNotice): void {
  const store = useHostAccountsStore.getState()
  if (!n || typeof n !== 'object') return
  if (n.kind === 'launch-refused') {
    const s = useSessionStore.getState().sessions.find((x) => x.id === n.sessionId)
    if (!s || s.remoteAccountSignIn) return
    const m = store.machines.find((x) => x.did === n.refusal?.did)
    const notice = noticeOfRefusal(n.sessionId, n.refusal, m ? machineLabel(m) : undefined)
    if (notice) store.openNotice(notice)
    return
  }
  if (n.kind === 'sign-in-ended') store.signInEnded(n.did, n.profileId, hostLaunchable(n.state))
}

/** The app root listens once: each machine's read as it lands, and each
 *  account notice. Returns the unsubscribe. */
export function listenHostAccounts(): () => void {
  const remote = window.electronAPI?.machines?.remote
  const offs: Array<() => void> = []
  if (typeof remote?.onAccountsChanged === 'function') offs.push(remote.onAccountsChanged((m) => useHostAccountsStore.getState().applyAccounts(m)))
  if (typeof remote?.onAccountNotice === 'function') offs.push(remote.onAccountNotice((n) => handleHostAccountNotice(n)))
  return () => { for (const off of offs) { try { off() } catch { /* gone */ } } }
}
