import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useReauthAccount } from '../hooks/useReauthAccount'
import { resolveAccountColourKey } from '../../shared/account-chip-color'
import { resolveIdentityColor, type IdentityColorKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { formatResetTime } from '../utils/terminalFormatting'
import PageFrame from './PageFrame'
import { ProviderMark } from './sidebar/Badges'
import { RowMenu, type MenuItem } from './ui/RowMenu'
import { describeAuthWindow, subscriptionPlanLabel, type AuthWindowTone, type ProfileAuthInfo } from '../../shared/account-auth'
import type { AccountUsage, AllowanceCredits, UsageBucket } from '../../shared/usage-types'
import { bucketPastReset, isModelBucket, relAgo } from '../../shared/usage-labels'
import { isAccountActive, type AccountProfile } from '../../shared/account-types'
import type { AccountsSnapshot, AccountView, ProviderAccountUsageView, ProviderId } from '../../shared/providers'
import { useClaudeOff, CLAUDE_OFF_ACCOUNTS_LINE } from '../lib/claudeOff'
import { useRenderAtNextReset } from '../hooks/useRenderAtNextReset'
import { useRenderEvery } from '../hooks/useRenderEvery'
import { useSettingsStore } from '../stores/settingsStore'
import { usesCodex } from '../onboarding/provider-choice'
import { PROVIDER_NAMES } from '../provider-names'
import {
  useProviderAccountsStore, selectProviderAccounts, accountForLegacyId, accountDisplayName, providerView, signInMethodLabel,
} from '../stores/providerAccountsStore'
import {
  USAGE_SORT_KEYS, USAGE_SORT_LABEL, DEFAULT_USAGE_SORT, resolveUsageSort, resolveUsageProviderFilter, filterEntries, filterShows,
  usageRowState, accountViewState, usageRowEntry, accountViewEntry, arrangeCards, countStates, mostRoomDetail,
  mainWindow, percentLeft, roomWindow, usedUpWindow,
  type UsageSortKey, type UsageProviderFilter, type UsageCardState, type UsageGridEntry, type UsageBand,
} from '../utils/accountUsageGrid'
import {
  ACCOUNT_USAGE_BODY_CLASS, ACCOUNT_USAGE_GRID_CLASS, ACCOUNT_USAGE_CARD_CLASS, ACCOUNT_USAGE_NAME_CLASS,
  ACCOUNT_USAGE_MACHINES_CLASS, ACCOUNT_USAGE_MACHINE_ROW_CLASS, ACCOUNT_USAGE_MACHINE_NAME_CLASS, ACCOUNT_USAGE_MACHINE_STATE_CLASS, ACCOUNT_USAGE_MACHINE_BUTTON_CLASS,
} from './account-usage-layout'
import { useHostAccountsStore } from '../stores/hostAccountsStore'
import { cardMachineLine, machineLabel, signInOnTitle, toSignInCount, type HostLineTone, type HostMachineRef, type HostSignInLine } from '../utils/hostAccounts'
import { openHostSignInTab } from '../utils/hostSignIn'

/** D5 (usage UX, approved as drawn): the one line the page shows for Claude
 *  Code while it is switched off. */
export const CLAUDE_OFF_USAGE_LINE = CLAUDE_OFF_ACCOUNTS_LINE

/** Usage track MP4 (approved canvas, Account usage option A): the notes a
 *  Codex account shows in place of bars. */
export const NO_SESSION_YET_LINE = 'No session on this account yet. Its allowance shows after the first one.'
export const PER_TOKEN_LINE = 'Billed per token, so there is no plan allowance.'

/** nubbymong/aicc_planning#445 (the approved mockup v1): the lines a card
 *  and the page foot say. */
export const PARKED_LINE = 'Parked, not polled. Reactivate this account in Settings › Accounts to use it again.'
export const RENEWAL_LINE = 'An account whose reading is old renews its own sign-in in the background. You are asked to sign in only when its sign-in has truly run out. The countdown is the date that happens.'
export const UNAVAILABLE_LINE = 'Couldn’t load this account’s usage.'
const EXPIRED_NOTE = 'Its long-lived sign-in ran out, so Claude Code needs you to sign in once.'
const MISSING_NOTE = 'This account has no sign-in stored, so Claude Code needs you to sign in once.'
const SIGNED_OUT_NOTE = 'It needs signing in again before its usage can be read.'
const RENEWING_LINE = 'Renewing its sign-in by itself'
/** 2.1.3-beta.20 section 5 (frame 1): the foot's line while Linux machines
 *  are added. Lend from this computer is not built yet, so it is not named. */
export const MACHINES_FOOT_LINE = 'Accounts you add in Settings › Accounts are on every machine. Signed in on a machine: the sign-in is kept on that machine.'

// The providers the page shows cards for, in the order they show. The page
// asks for a provider's accounts and usage by its id; it never branches on it.
const CLAUDE: ProviderId = 'claude'
const CODEX: ProviderId = 'codex'

/** A window focus reloads the page's Codex views at most this often. */
export const FOCUS_REFRESH_MS = 60_000

/** How often an open page re-renders so its ages move on ("just now", then
 *  "1 min ago"): ages are in whole minutes, so a reading never shows more
 *  than half a minute behind. */
const AGE_TICK_MS = 30_000
/** In the registry-change bookkeeping: the stream read this account, before
 *  its sign-in state was known here. */
const READ_BY_STREAM = 'read-by-stream'
/** The card menu's width (the mockup's): its "Sign in again now" line wraps. */
const CARD_MENU_WIDTH = 236

const MUTED = 'var(--text-muted)'

const TONE_TEXT: Record<AuthWindowTone, string> = {
  expired: 'text-red',
  critical: 'text-red',
  warning: 'text-yellow',
  ok: '',
  unknown: '',
}

const peopleIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="3.25" />
    <path d="M5.5 19.5c0-3.4 3-5.5 6.5-5.5s6.5 2.1 6.5 5.5" />
  </svg>
)

/** An account's identity as a card shows it: its name, when it has one, and
 *  its colour. */
export interface CardIdentity {
  name?: string
  colourKey?: string
}

function identityOf(snapshot: AccountsSnapshot | null, account: AccountView | undefined): CardIdentity | undefined {
  if (!account) return undefined
  const identity = snapshot?.identities.find((i) => i.id === account.identityId)
  if (!identity) return undefined
  const name = identity.friendlyName?.trim()
  return name ? { name, colourKey: identity.colourKey } : { colourKey: identity.colourKey }
}

/** The name a Claude Code card leads with: the identity's, unless it is the
 *  email; else the full email; else the profile's name. */
function claudeCardName(identity: CardIdentity | undefined, email: string | null, plain: string): { title: string; hasName: boolean } {
  const named = identity?.name?.trim()
  const hasName = !!named && named !== email
  return { title: hasName ? named! : (email || plain), hasName }
}

/**
 * What the page last showed, kept while the app runs (never saved): when the
 * page opens again every card is drawn at once from it (the account list,
 * each account's last reading and where each card stood) while the fresh
 * readings come in. Claude Code's part is dropped while Claude Code is off,
 * and the other provider's while it is off, so nothing of a switched-off
 * provider is shown from here.
 */
interface PageMemory {
  profiles: AccountProfile[] | null
  auth: Record<string, ProfileAuthInfo>
  usage: Record<string, AccountUsage>
  /** When each profile last had a reading with figures, epoch ms. */
  lastOkAt: Record<string, number>
  views: Record<string, ProviderAccountUsageView>
  basis: UsageGridEntry[] | null
}
const memory: PageMemory = { profiles: null, auth: {}, usage: {}, lastOkAt: {}, views: {}, basis: null }

/** Forget what the page last showed: the next opening starts from nothing. */
export function forgetAccountUsagePage(): void {
  memory.profiles = null
  memory.auth = {}
  memory.usage = {}
  memory.lastOkAt = {}
  memory.views = {}
  memory.basis = null
}

const without = (set: ReadonlySet<string>, id: string): Set<string> => { const next = new Set(set); next.delete(id); return next }
const withId = (set: ReadonlySet<string>, id: string): Set<string> => new Set(set).add(id)

// All-accounts usage overview. A full PageFrame view (reached from the nav-rail
// person icon, shown with 2+ accounts across the providers that are on) rather
// than a slide-in right-bar, so it matches Tokenomics/Memory and lives in the
// `panels` typography region -- which (with rem sizing below) lets Font & Size
// scale it. nubbymong/aicc_planning#445 (the approved mockup v1): one grid of
// every provider's cards, filtered by provider, sorted by 5h left, weekly left
// or name, in three bands; every card is drawn at once and its meters animate
// until its fresh reading lands, and the cards move only once the readings
// have settled. Claude Code's accounts are read directly, no session needed;
// Codex's show an open session's figure, else the last one in the account's
// own history.
export default function AccountUsagePanel({ onClose, onReauthNavigate, onOpenTokenomics }: {
  onClose: () => void
  /** Switch the app to the sessions view so the user sees the login shell. */
  onReauthNavigate: () => void
  /** Opens Tokenomics (the foot's link). */
  onOpenTokenomics?: () => void
}) {
  const theme = useResolvedTheme()
  const reauth = useReauthAccount()
  // D5: with Claude Code switched off the page reads nothing of it -- not the
  // credential state (authInfo reads every account's credential file), not
  // the usage stream -- and shows one line. Turning it back on loads again.
  const claudeOff = useClaudeOff()
  // Codex has cards only once it is answered on: a user who does not use
  // Codex sees no Codex card and no filter, and nothing of Codex is asked for.
  const codexOn = useSettingsStore((s) => usesCodex(s.settings))
  const savedSort = useSettingsStore((s) => s.settings.accountUsageSort)
  const savedProvider = useSettingsStore((s) => s.settings.accountUsageProvider)
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const codexAccounts = useMemo(() => selectProviderAccounts(snapshot, CODEX), [snapshot])
  // 2.1.3-beta.20 section 5 (frame 1): each Linux machine's last read of the
  // accounts there (no exec), for the Claude Code cards' "On machines" block.
  // Shown while the helper switch is on and a machine is added.
  const hostMachines = useHostAccountsStore((s) => s.machines)
  const hostByDid = useHostAccountsStore((s) => s.byDid)
  const hostShown = useHostAccountsStore((s) => s.available && s.switchOn && s.machines.length > 0)
  const [hostProblem, setHostProblem] = useState<string | null>(null)
  // On open the machines are read again too (the switch or the list may have
  // changed since), as the Machines page reads them on each open.
  useEffect(() => { void useHostAccountsStore.getState().load({ force: true }) }, [])
  // The account list drives the cards (a local read, so it resolves at once;
  // the last list shown, while it does). null = not resolved and none shown
  // before (a placeholder card or two show meanwhile).
  const [profiles, setProfiles] = useState<AccountProfile[] | null>(() => (claudeOff ? null : memory.profiles))
  const [usageByProfile, setUsageByProfile] = useState<Record<string, AccountUsage>>(() => (claudeOff ? {} : memory.usage))
  const [authInfo, setAuthInfo] = useState<Record<string, ProfileAuthInfo>>(() => (claudeOff ? {} : memory.auth))
  const [lastOkAt, setLastOkAt] = useState<Record<string, number>>(() => (claudeOff ? {} : memory.lastOkAt))
  // Which accounts this load has read fresh. A card with no fresh reading
  // while its provider streams animates its meters (its last reading, dimmed,
  // or placeholders); a card's "Read usage again" animates it alone.
  const [freshClaude, setFreshClaude] = useState<ReadonlySet<string>>(() => new Set())
  const [readingClaude, setReadingClaude] = useState<ReadonlySet<string>>(() => new Set())
  // True while a stream is in flight: a profile with no result yet is loading
  // WHILE streaming, and a terminal "couldn't load" card once the stream has
  // settled, so a failed load never animates forever.
  const [streaming, setStreaming] = useState(true)
  const [loadError, setLoadError] = useState(false)
  // Codex's accounts come from the registry the app already holds; their
  // views stream in the same way, one per account.
  const [codexViews, setCodexViews] = useState<Record<string, ProviderAccountUsageView>>(() => (codexOn ? memory.views : {}))
  const [freshCodex, setFreshCodex] = useState<ReadonlySet<string>>(() => new Set())
  const [readingCodex, setReadingCodex] = useState<ReadonlySet<string>>(() => new Set())
  const [codexStreaming, setCodexStreaming] = useState(codexOn)
  // Main answered that Codex is off (switched off in between): no cards.
  const [codexStreamOff, setCodexStreamOff] = useState(false)
  // Generation guards, one per provider: a Refresh (or that provider's switch
  // flipping) supersedes its in-flight load, so a late result from the previous
  // stream (or its settle) is ignored rather than repopulating a card the new
  // load has just reset. Each provider loads on its own: switching Codex on or
  // off never re-asks Claude Code, and the other way round.
  const claudeGen = useRef(0)
  const codexGen = useRef(0)
  // The Codex accounts (and each one's sign-in state) as of the last stream
  // or the last registry change handled, so a change after it reads that
  // account again.
  const codexSeen = useRef<Map<string, string>>(new Map())
  const codexAccountsRef = useRef(codexAccounts)
  codexAccountsRef.current = codexAccounts

  const loadClaude = useCallback(async (opts: { quiet?: boolean } = {}) => {
    const gen = ++claudeGen.current
    if (claudeOff) {
      setUsageByProfile({})
      setAuthInfo({})
      setLastOkAt({})
      setProfiles([])
      setFreshClaude(new Set())
      setLoadError(false)
      setStreaming(false)
      return
    }
    // Every card keeps its last reading and animates its meters until the
    // new one lands (a quiet reload does not animate them). The account list
    // and the credential state are both local file reads, so they resolve at
    // once and independently of the network usage fetch -- one slow account
    // must not hold back the others' cards or the forced-login countdown.
    if (!opts.quiet) setFreshClaude(new Set())
    setLoadError(false)
    setStreaming(true)
    try {
      const [profs, auth] = await Promise.all([
        window.electronAPI.accountProfiles.list(),
        window.electronAPI.accountProfiles.authInfo().catch(() => [] as ProfileAuthInfo[]),
      ])
      if (claudeGen.current !== gen) return // a newer load took over
      setProfiles(profs)
      setAuthInfo(Object.fromEntries(auth.map((a) => [a.profileId, a])))
      // Stream each account's usage in as it resolves (plan P3): an OPEN account
      // snaps in instantly from its live figure (no call), a CLOSED one fills in
      // as its staggered call lands.
      await window.electronAPI.accountUsage.fetchAllStream((usage) => {
        if (claudeGen.current !== gen) return // ignore a superseded stream's result
        setUsageByProfile((prev) => ({ ...prev, [usage.profileId]: usage }))
        setFreshClaude((prev) => withId(prev, usage.profileId))
        if (usage.status === 'ok' && usage.buckets.length > 0) setLastOkAt((prev) => ({ ...prev, [usage.profileId]: usage.fetchedAt }))
      })
    } catch {
      // A rejected list()/stream (a corrupt profiles read, say) must not leave the
      // page animating: record the error so unresolved cards show a terminal state
      // and an empty list reads as an error rather than "No accounts found".
      if (claudeGen.current === gen) { setLoadError(true); setProfiles((prev) => prev ?? []) }
    } finally {
      if (claudeGen.current === gen) setStreaming(false)
    }
  }, [claudeOff])

  // `read` (MP8 round 2, ADR-022 bound 7): a closed Codex account is read
  // afresh only when the page opens or on Refresh; the window-focus reload
  // shows the live, kept or last-seen figure only.
  const loadCodex = useCallback(async (opts: { quiet?: boolean; read?: boolean } = {}) => {
    const gen = ++codexGen.current
    if (!opts.quiet) setFreshCodex(new Set())
    setCodexStreamOff(false)
    codexSeen.current = new Map(codexAccountsRef.current.map((a) => [a.id, a.lastKnownAuthState]))
    if (!codexOn) { setCodexViews({}); setCodexStreaming(false); return }
    setCodexStreaming(true)
    try {
      const api = window.electronAPI?.providerAccounts
      if (!api?.usageStream) return // no stream: the cards turn to "couldn't load"
      const r = await api.usageStream(CODEX, (view) => {
        if (codexGen.current !== gen || !view || typeof view.accountId !== 'string') return
        // The stream read this account: a registry copy arriving after it
        // started is not a change to read it again for.
        if (!codexSeen.current.has(view.accountId)) codexSeen.current.set(view.accountId, READ_BY_STREAM)
        setCodexViews((prev) => ({ ...prev, [view.accountId]: view }))
        setFreshCodex((prev) => withId(prev, view.accountId))
      }, { read: opts.read !== false })
      if (codexGen.current === gen && r && r.ok === true && r.provider === 'off') setCodexStreamOff(true)
    } catch {
      // A failed stream leaves the unresolved cards to read again, one account each.
    } finally {
      if (codexGen.current === gen) setCodexStreaming(false)
    }
  }, [codexOn])

  useEffect(() => { void loadClaude() }, [loadClaude])
  useEffect(() => { void loadCodex() }, [loadCodex])
  // Usage track MP8: the page closing stops its Codex stream in main, and a
  // fresh read under way with it: nothing is read for a page no one sees.
  useEffect(() => () => {
    try { void window.electronAPI?.providerAccounts?.usageStreamStop?.(CODEX)?.catch(() => {}) } catch { /* the page is going anyway */ }
  }, [])
  // Refresh (and a window focus) reloads both.
  const load = useCallback(async (opts: { quiet?: boolean } = {}) => {
    await Promise.all([loadClaude(opts), loadCodex(opts)])
  }, [loadClaude, loadCodex])

  // Coming back to the window reloads Codex, quietly (the figures stay until
  // each new one lands), at most once per FOCUS_REFRESH_MS. Codex only: its
  // views are read locally, while Claude Code's closed accounts call a
  // rate-limited endpoint, so Claude Code keeps its own cadence (the page
  // opening, Refresh, a card's "Read usage again").
  const lastFocusLoad = useRef(Date.now())
  useEffect(() => {
    const onFocus = () => {
      const t = Date.now()
      if (t - lastFocusLoad.current < FOCUS_REFRESH_MS) return
      lastFocusLoad.current = t
      void loadCodex({ quiet: true, read: false })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadCodex])

  const refreshOne = useCallback(async (profileId: string) => {
    setReadingClaude((prev) => withId(prev, profileId))
    try {
      const one = await window.electronAPI.accountUsage.fetchOne(profileId)
      if (one) {
        setUsageByProfile((prev) => ({ ...prev, [profileId]: one }))
        setFreshClaude((prev) => withId(prev, profileId))
        if (one.status === 'ok' && one.buckets.length > 0) setLastOkAt((prev) => ({ ...prev, [profileId]: one.fetchedAt }))
      }
    } catch { /* the card keeps what it had */ } finally {
      setReadingClaude((prev) => without(prev, profileId))
    }
  }, [])

  // `read`: a card's "Read usage again" only; an account the registry changed
  // shows the live, kept or last-seen figure (MP8 round 2, ADR-022 bound 7).
  const refreshCodexOne = useCallback(async (accountId: string, read: boolean) => {
    if (read) setReadingCodex((prev) => withId(prev, accountId))
    try {
      const r = await window.electronAPI.providerAccounts.usageOne(accountId, { read })
      if (r && r.ok === true && r.usage) {
        setCodexViews((prev) => ({ ...prev, [accountId]: r.usage }))
        setFreshCodex((prev) => withId(prev, accountId))
      }
    } catch { /* the card keeps what it had */ } finally {
      if (read) setReadingCodex((prev) => without(prev, accountId))
    }
  }, [])

  // The registry changed after the stream: an account added since, or one
  // whose sign-in state changed (signed back in, say), reads again, that
  // account alone. A parked account reads nothing.
  useEffect(() => {
    if (!codexOn || codexStreaming) return
    const seen = codexSeen.current
    for (const a of codexAccounts) {
      if (a.lifecycle === 'inactive') continue
      const before = seen.get(a.id)
      if (before === READ_BY_STREAM) continue
      if (before === undefined || before !== a.lastKnownAuthState) void refreshCodexOne(a.id, false)
    }
    codexSeen.current = new Map(codexAccounts.map((a) => [a.id, a.lastKnownAuthState]))
  }, [codexAccounts, codexOn, codexStreaming, refreshCodexOne])

  // Keep what the page shows for its next opening (PageMemory).
  useEffect(() => {
    memory.profiles = claudeOff ? null : profiles
    memory.usage = claudeOff ? {} : usageByProfile
    memory.auth = claudeOff ? {} : authInfo
    memory.lastOkAt = claudeOff ? {} : lastOkAt
  }, [claudeOff, profiles, usageByProfile, authInfo, lastOkAt])
  useEffect(() => { memory.views = codexOn ? codexViews : {} }, [codexOn, codexViews])

  const onSignIn = (profileId: string, name: string) => {
    reauth({ id: profileId, name }, () => void refreshOne(profileId))
    onReauthNavigate()
    onClose()
  }

  // 2.1.3-beta.20 section 5: "Sign in on <machine>" opens a sign-in tab there
  // (Claude Code's own sign-in, kept on that machine), as Sign in again opens
  // one here; a machine no saved SSH config reaches says why on the page.
  const onSignInOn = (machine: HostMachineRef, profileId: string) => {
    const r = openHostSignInTab(machine, profileId)
    if (!r.ok) { setHostProblem(r.why); return }
    setHostProblem(null)
    onReauthNavigate()
    onClose()
  }
  // Each Claude Code card's lines, one per added machine, from its last read.
  const machineLinesFor = (profileId: string): CardMachines | undefined => hostShown
    ? {
        lines: hostMachines.map((m) => ({ machine: m, line: cardMachineLine(hostByDid[m.did]?.accounts.find((a) => a.profileId === profileId), machineLabel(m)) })),
        onSignIn: (m) => onSignInOn(m, profileId),
      }
    : undefined

  // A signed-out Codex account signs in again from Settings, Accounts.
  const openAccountsSettings = () => {
    window.dispatchEvent(new CustomEvent('app:openSettings', { detail: { tab: 'accounts' } }))
  }

  const resets = useMemo(() => {
    const out: string[] = []
    for (const u of Object.values(usageByProfile)) for (const b of u.buckets ?? []) if (b.resetsAt) out.push(b.resetsAt)
    for (const v of Object.values(codexViews)) for (const b of v.buckets ?? []) if (b.resetsAt) out.push(b.resetsAt)
    return out
  }, [usageByProfile, codexViews])
  useRenderAtNextReset(resets)
  // Each card's "Updated <age>" ages while the page stays open (P4.11; it
  // kept "Updated just now" until new data or the next reset re-rendered it).
  useRenderEvery(AGE_TICK_MS)
  const now = Date.now()

  // Which providers have cards: Claude Code while it is on (its list may still
  // be resolving), Codex once it is on and has an account to show.
  const codexShown = codexOn && !codexStreamOff && codexAccounts.length > 0
  const claudeShown = !claudeOff && (profiles === null || profiles.length > 0)
  const shownProviders: ProviderId[] = [...(claudeShown ? [CLAUDE] : []), ...(codexShown ? [CODEX] : [])]
  const providerName = (id: ProviderId) => providerView(snapshot, id)?.displayName ?? PROVIDER_NAMES[id]
  const sort = resolveUsageSort(savedSort)
  const filter = resolveUsageProviderFilter(savedProvider, shownProviders)

  // Every card, in the list's own order (Claude Code's profiles, then each
  // Codex account), with the entry the grid places it by.
  const cards: Array<{ entry: UsageGridEntry; render: (best: boolean) => React.ReactNode }> = []
  if (!claudeOff) {
    for (const p of profiles ?? []) {
      const row = usageByProfile[p.id]
      const loading = readingClaude.has(p.id) || (streaming && !freshClaude.has(p.id))
      const identity = identityOf(snapshot, accountForLegacyId(snapshot, CLAUDE, p.id))
      const email = row?.email || p.accountEmail || null
      const { title } = claudeCardName(identity, email, row?.name || p.name)
      const entry = usageRowEntry(CLAUDE, p.id, title, row, { active: isAccountActive(p), auth: authInfo[p.id], now, loading })
      cards.push({
        entry,
        render: (best) => (
          <AccountCard
            key={entry.key}
            profile={p}
            row={row}
            auth={authInfo[p.id]}
            identity={identity}
            theme={theme}
            now={now}
            loading={loading}
            best={best}
            sort={sort}
            lastReadingAt={lastOkAt[p.id]}
            providerName={providerName(CLAUDE)}
            onSignIn={() => onSignIn(p.id, row?.name || p.name)}
            onReadAgain={() => void refreshOne(p.id)}
            machines={machineLinesFor(p.id)}
          />
        ),
      })
    }
  }
  if (codexShown) {
    for (const a of codexAccounts) {
      const view = codexViews[a.id]
      const loading = readingCodex.has(a.id) || (codexStreaming && !freshCodex.has(a.id))
      const name = accountDisplayName(snapshot, a)
      const entry = accountViewEntry(a, name, view, { now, loading })
      const identity = identityOf(snapshot, a)
      const provider = providerView(snapshot, a.providerId) ?? { providerId: a.providerId, displayName: PROVIDER_NAMES[a.providerId] }
      cards.push({
        entry,
        render: (best) => (
          <CodexAccountCard
            key={entry.key}
            account={a}
            view={view}
            name={name}
            email={a.external ? null : a.providerLabel?.trim() || null}
            method={a.external ? null : signInMethodLabel(a, provider)}
            colour={identity?.colourKey ? resolveIdentityColor(identity.colourKey as IdentityColorKey, theme) : null}
            now={now}
            loading={loading}
            best={best}
            sort={sort}
            providerName={provider.displayName}
            onSignInAgain={openAccountsSettings}
            onReadAgain={() => void refreshCodexOne(a.id, true)}
          />
        ),
      })
    }
  }
  const entries = cards.map((c) => c.entry)
  const cardByKey = new Map(cards.map((c) => [c.entry.key, c]))

  // Settle, then sort: the cards are placed by the entries as they stood when
  // every stream last finished (kept for the next opening too), never by the
  // readings arriving now, so nothing moves while a load runs.
  const claudeSettled = claudeOff || (profiles !== null && !streaming)
  const settled = claudeSettled && !codexStreaming
  const basisRef = useRef<UsageGridEntry[] | null>(memory.basis)
  if (settled) basisRef.current = entries
  useEffect(() => { memory.basis = basisRef.current })

  const live = filterEntries(entries, filter)
  const arrangement = arrangeCards(live, basisRef.current ? filterEntries(basisRef.current, filter) : null, sort)
  const placed = arrangement.bands.flatMap((b) => b.entries)
  const bestKey = arrangement.best?.key ?? null
  const cardOf = (e: UsageGridEntry) => cardByKey.get(e.key)?.render(e.key === bestKey) ?? null
  // Placeholder cards cover the frame or two before Claude Code's list
  // resolves the first time, so the page never flashes empty.
  const placeholders = !claudeOff && profiles === null && filterShows(filter, CLAUDE) ? 2 : 0
  const anyLoading = !settled

  const countLabel = live.length > 0 ? `${live.length} account${live.length === 1 ? '' : 's'}` : undefined
  // 2.1.3-beta.20 section 5 (frame 1): how many Claude Code accounts are not
  // signed in on a machine, once per machine (a parked account is not counted).
  const machineSignIns = hostShown && !claudeOff && filterShows(filter, CLAUDE)
    ? toSignInCount(hostMachines, hostByDid, new Set((profiles ?? []).filter((p) => isAccountActive(p)).map((p) => p.id)))
    : 0

  const actions = (
    <>
      {shownProviders.length > 1 && (
        <Segmented<UsageProviderFilter>
          label="Provider"
          options={[{ value: 'all', label: 'All' }, ...shownProviders.map((p) => ({ value: p as UsageProviderFilter, label: providerName(p) }))]}
          value={filter}
          onChange={(v) => void useSettingsStore.getState().updateSettings({ accountUsageProvider: v })}
          testId="account-usage-provider"
        />
      )}
      {shownProviders.length > 0 && (
        <Segmented<UsageSortKey>
          label="Sort"
          showLabel
          options={USAGE_SORT_KEYS.map((k) => ({ value: k, label: USAGE_SORT_LABEL[k] }))}
          value={sort}
          onChange={(v) => void useSettingsStore.getState().updateSettings({ accountUsageSort: v })}
          testId="account-usage-sort"
        />
      )}
      <button
        type="button"
        onClick={() => { void load(); void useHostAccountsStore.getState().load() }}
        className="text-xs px-2 min-h-6 rounded hover:text-text hover:bg-surface0 transition-colors focus-ring"
        style={{ color: MUTED }}
        title="Read every account again"
        data-testid="account-usage-refresh"
      >
        Refresh
      </button>
    </>
  )

  const emptyLine = live.length === 0 && placeholders === 0 && !anyLoading
    ? (loadError
        ? null
        : filter !== 'all'
          ? `No ${providerName(filter)} accounts.`
          : claudeOff && !codexShown ? null : 'No accounts found.')
    : null

  return (
    <PageFrame title="Account usage" context={countLabel} icon={peopleIcon} iconAccent="mauve" onClose={onClose} actions={actions}>
      <div className={ACCOUNT_USAGE_BODY_CLASS} data-testid="account-usage-body">
        {claudeOff && (
          <p className="text-[0.8125rem] mb-3" style={{ color: MUTED }} data-testid="account-usage-claude-off">{CLAUDE_OFF_USAGE_LINE}</p>
        )}
        {loadError && (
          <p className="text-[0.8125rem] mb-3" style={{ color: MUTED }} data-testid="account-usage-load-error">{'Couldn’t load account usage. Use Refresh to try again.'}</p>
        )}
        {hostProblem && (
          <p className="text-[0.8125rem] mb-3 text-red" role="alert" data-testid="account-usage-host-problem">{hostProblem}</p>
        )}
        {(live.length > 0 || placeholders > 0) && (
          <UsageSummary
            best={arrangement.best}
            room={roomWindow(sort)}
            placed={placed}
            reading={arrangement.bands.length === 0}
            machineSignIns={machineSignIns}
          />
        )}
        {arrangement.bands.map((band) => <Band key={band.id} band={band}>{band.entries.map(cardOf)}</Band>)}
        {(arrangement.unplaced.length > 0 || placeholders > 0) && (
          <div className={`${ACCOUNT_USAGE_GRID_CLASS} mb-4`} data-testid="account-usage-unplaced">
            {arrangement.unplaced.map(cardOf)}
            {Array.from({ length: placeholders }, (_, i) => <UsageSkeletonCard key={`sk-${i}`} />)}
          </div>
        )}
        {emptyLine && <p className="text-[0.8125rem] mb-3" style={{ color: MUTED }}>{emptyLine}</p>}
        <p className="text-[0.6875rem] leading-relaxed pt-0.5" style={{ color: MUTED }} data-testid="account-usage-foot">
          Allowances only. Token use and estimated cost are in{' '}
          {onOpenTokenomics
            ? <button type="button" onClick={onOpenTokenomics} className="text-blue hover:underline focus-ring rounded">Tokenomics</button>
            : 'Tokenomics'}.
          {!claudeOff && (<><br />{RENEWAL_LINE}</>)}
          {!claudeOff && hostShown && (<><br /><span data-testid="account-usage-foot-machines">{MACHINES_FOOT_LINE}</span></>)}
        </p>
      </div>
    </PageFrame>
  )
}

// The header's segmented choice (the mockup's): one pressed button of a group.
function Segmented<T extends string>({ label, showLabel, options, value, onChange, testId }: {
  label: string
  /** Show the label inside the group (Sort), not only to assistive technology. */
  showLabel?: boolean
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  testId: string
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5 p-0.5 rounded-[7px] border border-surface1" data-testid={testId}>
      {showLabel && <span className="text-[11px] pl-1 pr-1.5" style={{ color: MUTED }} aria-hidden="true">{label}</span>}
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => { if (!on) onChange(o.value) }}
            className={`text-[11.5px] px-2 min-h-6 rounded-[5px] transition-colors focus-ring ${on ? 'bg-surface0 text-text' : 'text-subtext0 hover:text-text'}`}
            data-testid={`${testId}-${o.value}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// The line above the bands: the account with the most room, and how many
// cards are in each state. Before the first settle it says the page is reading.
function UsageSummary({ best, room, placed, reading, machineSignIns = 0 }: {
  best: UsageGridEntry | null
  room: '5h' | 'weekly'
  placed: UsageGridEntry[]
  reading: boolean
  /** 2.1.3-beta.20 section 5 (frame 1): Claude Code accounts not signed in on
   *  an added machine, once per machine. */
  machineSignIns?: number
}) {
  const counts = countStates(placed)
  const parts: React.ReactNode[] = []
  const count = (n: number, what: string, key: string) => {
    if (n > 0) parts.push(<span key={key} data-testid={`account-usage-count-${key}`}><i className="not-italic font-semibold text-text">{n}</i> {what}</span>)
  }
  if (!reading) {
    count(counts.ready, 'ready', 'ready')
    count(counts.refreshing, 'refreshing', 'refreshing')
    count(counts.out, counts.firstBack ? (counts.out === 1 ? `out until ${formatResetTime(counts.firstBack)}` : `out, the first back at ${formatResetTime(counts.firstBack)}`) : 'out', 'out')
    count(counts.signIn, 'to sign in', 'sign-in')
    count(counts.parked, 'parked', 'parked')
    count(machineSignIns, 'to sign in on a machine', 'machine-sign-in')
  }
  const tone = best ? 'border-green/25 bg-green/[0.06]' : 'border-surface1 bg-surface0/20'
  return (
    <div className={`flex items-center gap-2.5 flex-wrap px-3 py-[9px] rounded-[10px] border mb-3.5 ${tone}`} data-testid="account-usage-summary" role="status">
      <span className={`w-2 h-2 rounded-full shrink-0 ${best ? 'bg-green' : 'bg-surface2'}`} aria-hidden="true" />
      <span className="text-[0.8125rem] text-text" data-testid="account-usage-lead">
        {reading
          ? 'Reading each account’s usage…'
          : best
            ? <>Most room now: <b className="font-semibold">{best.name}</b>{mostRoomDetail(best, room)}</>
            : 'No account has room right now.'}
      </span>
      {parts.length > 0 && (
        <span className="ml-auto flex flex-wrap gap-2.5 text-[0.71875rem] text-subtext0" data-testid="account-usage-counts">{parts}</span>
      )}
    </div>
  )
}

function Band({ band, children }: { band: UsageBand; children: React.ReactNode }) {
  return (
    <section className="mb-4" aria-label={band.title} data-testid={`account-usage-band-${band.id}`}>
      <h2 className="flex items-baseline gap-2 mb-2 text-[0.71875rem] font-semibold uppercase tracking-[0.05em] text-subtext0">
        <span data-testid="account-usage-band-title">{band.title}</span>
        <small className="normal-case tracking-normal font-normal text-[0.6875rem]" style={{ color: MUTED }} data-testid="account-usage-band-note">{band.note}</small>
        <span className="ml-auto normal-case tracking-normal font-normal text-[0.6875rem]" style={{ color: MUTED }} data-testid="account-usage-band-count">{band.entries.length}</span>
      </h2>
      <div className={ACCOUNT_USAGE_GRID_CLASS}>{children}</div>
    </section>
  )
}

// A placeholder card (plan P3) for the frame or two before Claude Code's
// account list first resolves: the card frame with its identity and meters
// replaced by a calm sweep. Reuses the statusline pending-track shimmer
// (styles.css), which stops under prefers-reduced-motion. role=status /
// aria-busy announces the load without reading empty shimmer as content.
function UsageSkeletonCard() {
  const shimmer = 'statusline-pending-track bg-surface1 rounded'
  return (
    <div
      className={`${ACCOUNT_USAGE_CARD_CLASS} border-surface0/70 bg-surface0/20`}
      role="status"
      aria-busy="true"
      aria-label="Loading account usage"
      data-testid="account-usage-skeleton"
    >
      <div className="flex items-center gap-2">
        <span className={`${shimmer} w-2.5 h-2.5 rounded-[3px] shrink-0`} />
        <span className={`${shimmer} h-3.5`} style={{ width: '11rem' }} />
      </div>
      <MetersPending />
    </div>
  )
}

// A card's meters before its first reading: two rows of shimmer. No label is
// drawn: the windows are discovered from a reading, never assumed.
function MetersPending() {
  const shimmer = 'statusline-pending-track bg-surface1 rounded'
  return (
    <div className="flex flex-col gap-2.5" role="status" aria-busy="true" aria-label="Reading usage" data-testid="account-usage-loading">
      {[0, 1].map((i) => (
        <div key={i}>
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`${shimmer} h-3`} style={{ width: '2.75rem' }} />
            <span className={`${shimmer} ml-auto h-3`} style={{ width: '4.5rem' }} />
          </div>
          <span className={`${shimmer} block h-[7px] rounded-full`} />
        </div>
      ))}
    </div>
  )
}

/** A bar's fill, from the share USED: the same steps the status line paints
 *  at, so a card never disagrees with the footer's meter for the same window. */
function fillColour(percentUsed: number): string {
  const used = Math.min(100, Math.max(0, percentUsed))
  return used >= 90 ? 'var(--color-red)' : used >= 70 ? 'var(--color-peach)' : used >= 50 ? 'var(--color-yellow)' : 'var(--color-green)'
}

// One meter (the approved mockup): "5h  91% left  resets 4:10 pm" over a bar
// of what is left. The meter being sorted on is bold; a per-model bucket
// (Fable) is small. D2: a window whose reset has passed has no current
// figure, so it says when it reset and shows no bar.
function Meter({ bucket, now, bold, small, usedUp, loading }: { bucket: UsageBucket; now: number; bold: boolean; small: boolean; usedUp: boolean; loading: boolean }) {
  const text = small ? 'text-[0.71875rem]' : 'text-[0.75rem]'
  if (bucketPastReset(bucket, now)) {
    return (
      <div className={`flex items-baseline gap-1.5 ${text}`} data-testid="account-usage-past-reset">
        <span className="text-subtext0 shrink-0" style={{ minWidth: '2.75rem' }}>{bucket.label}</span>
        <span className="ml-auto text-[0.6875rem]" style={{ color: MUTED }}>Reset {formatResetTime(bucket.resetsAt)}, no reading since</span>
      </div>
    )
  }
  const left = percentLeft(bucket)
  return (
    <div data-testid="account-usage-meter" data-bold={bold ? 'true' : undefined}>
      <div className={`flex items-baseline gap-1.5 mb-1 ${text}`}>
        <span className="text-subtext0 shrink-0" style={{ minWidth: '2.75rem' }}>{bucket.label}</span>
        <span className={`ml-auto tabular-nums ${bold ? 'text-text font-semibold' : 'text-subtext1'}`} data-testid="account-usage-left">{left}% left</span>
        {bucket.resetsAt && (
          <span className="text-[0.6875rem] shrink-0" style={{ color: MUTED }}>{usedUp ? 'back at' : 'resets'} {formatResetTime(bucket.resetsAt)}</span>
        )}
      </div>
      <span
        className={`block ${small ? 'h-[5px]' : bold ? 'h-[9px]' : 'h-[7px]'} rounded-full bg-surface1 overflow-hidden${loading ? ' statusline-pending-track' : ''}`}
        role="progressbar"
        aria-label={`${bucket.label} left`}
        aria-valuenow={left}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className="block h-full rounded-full transition-[width] duration-300" style={{ width: `${left}%`, backgroundColor: fillColour(bucket.percent) }} />
      </span>
    </div>
  )
}

// A card's meters: every bucket of its reading, in the reading's order
// (discovered, never a fixed list), then its credits. Dimmed while its
// sign-in renews or while a fresh reading is on its way (its bars sweep then).
function Meters({ buckets, now, sort, usedUp, dim, loading, credits }: {
  buckets: UsageBucket[]
  now: number
  sort: UsageSortKey
  usedUp: UsageBucket | null
  dim: boolean
  loading: boolean
  credits?: React.ReactNode
}) {
  const boldKey = mainWindow(buckets, roomWindow(sort) === '5h' ? 'session' : 'weekly')?.key
  return (
    <div
      className={`flex flex-col gap-2${dim ? ' opacity-50' : ''}`}
      data-testid={loading ? 'account-usage-loading' : 'account-usage-meters'}
      {...(loading ? { role: 'status', 'aria-busy': true, 'aria-label': 'Reading usage' } : {})}
    >
      {buckets.map((b) => (
        <Meter key={b.key} bucket={b} now={now} bold={b.key === boldKey} small={isModelBucket(b)} usedUp={usedUp?.key === b.key} loading={loading} />
      ))}
      {credits}
    </div>
  )
}

// A small rounded label on a card's heading: the plan, Primary, Default,
// Inactive (`account-usage-pill`); the state (In use, Refreshing) and Most
// room carry their own test ids and tones.
function CardPill({ children, tone = 'plain', testId = 'account-usage-pill' }: { children: React.ReactNode; tone?: 'plain' | 'plan' | 'live' | 'refreshing' | 'best'; testId?: string }) {
  const cls = tone === 'live'
    ? 'text-green border-green/35 inline-flex items-center gap-1'
    : tone === 'refreshing'
      ? 'text-blue border-blue/40 inline-flex items-center gap-[5px]'
      : tone === 'best'
        ? 'text-green border-green/50'
        : 'border-surface1'
  return (
    <span
      className={`text-[0.625rem] font-normal border rounded-full px-1.5 leading-4 shrink-0 ${cls}`}
      style={tone === 'plan' ? { color: 'var(--text-secondary)' } : tone === 'plain' ? { color: MUTED } : undefined}
      data-testid={testId}
    >
      {tone === 'live' && <span className="w-1.5 h-1.5 rounded-full bg-green" aria-hidden="true" />}
      {tone === 'refreshing' && <span className="w-[9px] h-[9px] rounded-full border-[1.5px] border-blue/30 border-t-blue animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      {children}
    </span>
  )
}

/** The pills a card's state adds: In use, or Refreshing. */
function statePill(state: UsageCardState): React.ReactNode {
  if (state === 'in-use') return <CardPill tone="live" testId="account-usage-state-pill">In use</CardPill>
  if (state === 'refreshing') return <CardPill tone="refreshing" testId="account-usage-state-pill">{'Refreshing…'}</CardPill>
  return null
}

// A card's frame, its border and fill from its state: the account with the
// most room outlined green, one to sign in again tinted red, a parked one greyed.
function CardShell({ entryKey, state, best, loading, label, testId, children }: {
  entryKey: string
  state: UsageCardState
  best: boolean
  loading: boolean
  label: string
  testId: string
  children: React.ReactNode
}) {
  const tone = state === 'sign-in'
    ? 'border-red/35 bg-red/5'
    : state === 'parked' || state === 'off'
      ? 'border-surface0/70 bg-surface0/10 opacity-60'
      : best
        ? 'border-green/55 bg-surface0/20'
        : 'border-surface0/70 bg-surface0/20'
  return (
    <article
      className={`${ACCOUNT_USAGE_CARD_CLASS} ${tone}`}
      style={best ? { boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-green) 18%, transparent)' } : undefined}
      aria-label={label}
      aria-busy={loading || undefined}
      data-testid={testId}
      data-account-key={entryKey}
      data-state={state}
      data-best={best ? 'true' : undefined}
    >
      {children}
    </article>
  )
}

// A card's heading: its chip, its name with its pills, the email or sign-in
// method under it, the provider's mark and the card's menu.
function CardHead({ chip, name, sub, pills, providerId, providerName, menu }: {
  chip: React.ReactNode
  name: string
  sub: string | null
  pills: React.ReactNode
  providerId: ProviderId
  providerName: string
  menu: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2 min-w-0">
      {chip}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* The full name or email, never truncated: accounts are distinct
              even when emails look alike, so a long one wraps. */}
          <span className={ACCOUNT_USAGE_NAME_CLASS} data-testid="account-usage-name">{name}</span>
          {pills}
        </div>
        {sub && <div className="text-[0.71875rem] break-all" style={{ color: MUTED }} data-testid="account-usage-sub">{sub}</div>}
      </div>
      <span className="shrink-0 flex mt-0.5"><ProviderMark providerId={providerId} size={14} title={providerName} /></span>
      {menu}
    </div>
  )
}

/** A card's identity chip: the identity's colour. */
function Chip({ colour }: { colour: string }) {
  return <span className="w-2.5 h-2.5 rounded-[3px] shrink-0 mt-[5px]" style={{ backgroundColor: colour }} data-testid="account-usage-chip" />
}

/** A card's foot: when its figure is from, and (Claude Code) the countdown. */
function CardFoot({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mt-auto flex items-center justify-between gap-2 text-[0.6875rem]" style={{ color: MUTED }} data-testid="account-usage-card-foot">
      {left ?? <span />}
      {right}
    </div>
  )
}

/** "Out of 5h until 6:40 pm": the used-up window by its own label (the week
 *  for the weekly one), and when it comes back if that is known. */
function outLine(bucket: UsageBucket): string {
  const what = bucket.group === 'weekly' ? 'the week' : bucket.label
  return bucket.resetsAt ? `Out of ${what} until ${formatResetTime(bucket.resetsAt)}` : `Out of ${what}`
}

/** The day a sign-in ran out: "21 Nov". */
function dayOf(ts: number): string {
  try { return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' }) } catch { return '' }
}

/** The Credits row of a card, one markup for both providers: the label on the
 *  left, the value on the right, under the bars. `muted` greys the value (an
 *  account whose credit is switched off). Only the Codex card names a test id. */
function CreditsRow({ value, muted, testId }: { value: string; muted?: boolean; testId?: string }) {
  return (
    <div className="flex items-center justify-between text-[0.8125rem] mt-1 pt-2 border-t border-surface0/60" data-testid={testId}>
      <span className="text-overlay1">Credits</span>
      <span className={`tabular-nums ${muted ? 'text-overlay1' : 'text-text'}`}>{value}</span>
    </div>
  )
}

/** A Codex account's credits as its card words them (ADR-023). Codex credits
 *  are a COUNT, not money, so this is not Claude's money text: "Unlimited", or
 *  the balance and the CLI's own word for it ("1,250 credits"), to two
 *  fraction digits; a positive balance under the smallest figure that shows
 *  reads "<0.01 credits", never "0 credits". Null is no row: no balance to
 *  show, or credits the reading says the account does not have (a state no
 *  real account has shown, so nothing is invented for it). */
export function codexCreditsText(c: AllowanceCredits): string | null {
  if (c.unlimited) return 'Unlimited'
  if (c.hasCredits && typeof c.balance === 'number' && Number.isFinite(c.balance)) {
    const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
    if (c.balance > 0 && c.balance < 0.005) return `<${fmt.format(0.01)} credits`
    return `${fmt.format(c.balance)} credits`
  }
  return null
}

function creditsText(c: NonNullable<AccountUsage['credits']>): string {
  if (!c.enabled) {
    const why = c.disabledReason === 'out_of_credits' ? 'Out of credits' : 'Off'
    return c.used > 0 ? `${why} · ${fmtMoney(c.used, c.currency)} used` : why
  }
  if (c.remaining != null) return `${fmtMoney(c.remaining, c.currency)} left`
  return `${fmtMoney(c.used, c.currency)} used`
}

/** 2.1.3-beta.20 section 5 (frame 1): a Claude Code card's lines for each
 *  added machine, and its "Sign in on <machine>". */
export interface CardMachines {
  lines: Array<{ machine: HostMachineRef; line: HostSignInLine }>
  onSignIn: (machine: HostMachineRef) => void
}

const DOT_STYLE: Record<HostLineTone, React.CSSProperties> = {
  ok: { background: 'var(--status-success)' },
  warn: { background: 'var(--status-warning)' },
  none: { background: 'transparent', border: '1.5px solid var(--text-muted)' },
}

/** One machine's row: its dot and name, its state (and a second line), and
 *  "Sign in on <machine>" where the account is not signed in there. */
function MachineRow({ name, line, onSignIn }: { name: string; line: HostSignInLine; onSignIn?: () => void }) {
  return (
    <div className={ACCOUNT_USAGE_MACHINE_ROW_CLASS} title={line.title} data-testid="account-usage-machine" data-machine={name} data-tone={line.tone}>
      <span className={ACCOUNT_USAGE_MACHINE_NAME_CLASS}>
        <span className="w-[7px] h-[7px] rounded-full shrink-0 box-border" style={DOT_STYLE[line.tone]} aria-hidden="true" />
        <span className="truncate" title={name}>{name}</span>
      </span>
      <span className={ACCOUNT_USAGE_MACHINE_STATE_CLASS} data-testid="account-usage-machine-state">
        <span className={line.muted ? 'text-overlay1' : undefined}>{line.text}</span>
        {line.sub && <small className="block text-[0.65625rem]" style={{ color: MUTED }} data-testid="account-usage-machine-sub">{line.sub}</small>}
      </span>
      {onSignIn && (
        <button type="button" className={ACCOUNT_USAGE_MACHINE_BUTTON_CLASS} title={signInOnTitle(name)} onClick={onSignIn} data-testid="account-usage-machine-signin">
          Sign in on {name}
        </button>
      )}
    </div>
  )
}

/** The card's "On machines" block: this computer first (signed in, unless
 *  the card asks to sign in again), then each added machine. Lend from this
 *  computer is not built yet, so no line says lent. */
function MachineLines({ machines, signedInHere }: { machines: CardMachines; signedInHere: boolean }) {
  const here: HostSignInLine = signedInHere ? { tone: 'ok', text: 'Signed in', muted: false } : { tone: 'none', text: 'Sign in again', muted: true }
  return (
    <div className={ACCOUNT_USAGE_MACHINES_CLASS} data-testid="account-usage-machines">
      <div className="text-[0.625rem] uppercase tracking-[0.06em] font-semibold mb-px" style={{ color: MUTED }}>On machines</div>
      <MachineRow name="This computer" line={here} />
      {machines.lines.map(({ machine, line }) => (
        <MachineRow key={machine.did} name={machineLabel(machine)} line={line} onSignIn={line.action === 'sign-in' ? () => machines.onSignIn(machine) : undefined} />
      ))}
    </div>
  )
}

/** The "Sign in again now" item's line: what it resets and what it opens. */
function signInNowDetail(days: number | null): string {
  const countdown = typeof days === 'number' && days > 0 ? `the ${days}-day forced sign-in countdown` : 'the forced sign-in countdown'
  return `Resets ${countdown}. Opens a terminal for this account.`
}

/**
 * A Claude Code account's card (the approved mockup v1). Drawn from the
 * profile before its reading arrives (its meters animate until it does), then
 * from the reading: the identity's chip, name and email, the plan from the
 * stored sign-in, Primary, and the state (In use, Refreshing, Out of 5h until,
 * Sign in again, Parked); its meters show what is LEFT; the foot says when the
 * figure is from and when a sign-in is forced. The menu holds "Read usage
 * again" and "Sign in again now". A parked account offers neither (opening a
 * login shell for an account the user parked bypasses the switcher's own
 * active-guard) and is never read.
 */
export function AccountCard({
  row,
  profile,
  auth,
  identity,
  theme,
  now = Date.now(),
  loading = false,
  best = false,
  sort = DEFAULT_USAGE_SORT,
  lastReadingAt,
  providerName = PROVIDER_NAMES[CLAUDE],
  onSignIn,
  onReadAgain,
  machines,
}: {
  /** The account's reading; absent until it arrives. */
  row?: AccountUsage
  /** The saved profile the card is drawn from before its reading. */
  profile?: AccountProfile
  auth?: ProfileAuthInfo
  /** The account's identity in the registry: its name leads the card and its
   *  colour is the chip's. Absent: the email alone, coloured from it. */
  identity?: CardIdentity
  theme: 'dark' | 'light'
  /** The time the card is drawn at (ages, passed resets, the countdown). */
  now?: number
  /** A fresh reading is on its way: the meters animate. */
  loading?: boolean
  /** The account with the most room: outlined, with the "Most room" pill. */
  best?: boolean
  sort?: UsageSortKey
  /** When it last had a reading with figures (the sign-in card's "Last reading"). */
  lastReadingAt?: number
  providerName?: string
  onSignIn: () => void
  onReadAgain?: () => void
  /** 2.1.3-beta.20 section 5 (frame 1): its lines for each added machine;
   *  absent while no machine is added (or the helper switch is off). */
  machines?: CardMachines
}) {
  const id = row?.profileId ?? profile?.id ?? ''
  const email = row?.email || profile?.accountEmail || null
  const { title, hasName } = claudeCardName(identity, email, row?.name || profile?.name || 'Account')
  const dot = resolveIdentityColor(
    identity?.colourKey ? (identity.colourKey as IdentityColorKey) : resolveAccountColourKey(email ?? undefined, undefined, undefined),
    theme,
  )
  // Parked: an undefined active is treated as active (a main process that
  // predates the field never greys a card).
  const active = profile ? isAccountActive(profile) : row?.active !== false
  const state = usageRowState(row, { active, auth, now, loading })
  const quiet = state === 'parked' || state === 'off'
  const isPrimary = row?.isPrimary ?? profile?.isPrimary ?? false
  // Computed at render; the calculation itself is pure and lives in shared/
  // so main and renderer cannot disagree about what a credential state means.
  const window_ = auth && !quiet ? describeAuthWindow(auth, now) : null
  const plan = quiet ? null : subscriptionPlanLabel(auth?.subscriptionType)
  const duplicates = auth?.duplicateOfProfileIds ?? []
  const ok = row?.status === 'ok' ? row : null
  const usedUp = ok ? usedUpWindow(ok.buckets, now) : null
  const age = (ts: number) => relAgo(ts, now)

  const items: MenuItem[] = []
  if (!quiet && onReadAgain && !loading) items.push({ key: 'read-again', label: 'Read usage again', onSelect: onReadAgain })
  if (!quiet && state !== 'sign-in') items.push({ key: 'sign-in-now', label: 'Sign in again now', detail: signInNowDetail(window_?.daysUntilForcedLogin ?? null), onSelect: onSignIn, separated: items.length > 0 })

  const pills = (
    <>
      {state === 'parked'
        ? <CardPill>Inactive</CardPill>
        : plan && <CardPill tone="plan">{plan}</CardPill>}
      {statePill(state)}
      {isPrimary && <CardPill>Primary</CardPill>}
      {best && <CardPill tone="best" testId="account-usage-best">Most room</CardPill>}
    </>
  )

  let left: React.ReactNode = null
  if (state === 'pending' || (loading && row)) {
    left = ok ? `Last reading ${age(ok.fetchedAt)} · reading again` : 'Reading usage…'
  } else if (state === 'refreshing') {
    left = ok ? `${RENEWING_LINE} · last reading ${age(ok.fetchedAt)}` : RENEWING_LINE
  } else if (state === 'out' && usedUp) {
    left = <span className="text-red" data-testid="account-usage-out">{outLine(usedUp)}</span>
  } else if (ok) {
    // An account a session uses is not fetched, so an old figure was not
    // updated since; nothing failed to refresh.
    left = ok.inSession
      ? (ok.stale ? `Last updated ${age(ok.fetchedAt)}` : 'Live from its open session')
      : ok.stale ? `Last updated ${age(ok.fetchedAt)} · couldn't refresh` : `Updated ${age(ok.fetchedAt)}`
  }

  return (
    <CardShell entryKey={`${CLAUDE}:${id}`} state={state} best={best} loading={loading && !quiet} label={title} testId="account-usage-card">
      <CardHead
        chip={<Chip colour={dot} />}
        name={title}
        sub={hasName && email ? email : null}
        pills={pills}
        providerId={CLAUDE}
        providerName={providerName}
        menu={<RowMenu items={items} label={`More actions for ${title}`} testId="account-usage-menu" itemTestId={(k) => `account-usage-menu-${k}`} width={CARD_MENU_WIDTH} />}
      />

      {state === 'parked' && <p className="text-[0.78125rem]" style={{ color: MUTED }}>{PARKED_LINE}</p>}

      {state === 'off' && <p className="text-[0.78125rem]" style={{ color: MUTED }}>Claude Code is off: nothing is read for this account.</p>}

      {state === 'sign-in' && row && (() => {
        const expiry = auth?.refreshTokenExpiresAt
        const expiredAt = typeof expiry === 'number' && Number.isFinite(expiry) && expiry > 0 && expiry <= now ? expiry : null
        const expired = row.detail === 'session expired' || expiredAt !== null
        return (
          <>
            <p className="text-[0.78125rem] text-red" data-testid="account-usage-signin-reason">
              {expired ? (expiredAt !== null ? `Sign-in expired on ${dayOf(expiredAt)}` : 'Sign-in expired') : 'Not signed in'}
            </p>
            <p className="text-[0.78125rem] text-subtext0">{expired ? EXPIRED_NOTE : MISSING_NOTE}</p>
            {machines && <MachineLines machines={machines} signedInHere={false} />}
            <div className="mt-auto flex items-center justify-between gap-2">
              <span className="text-[0.6875rem]" style={{ color: MUTED }}>{typeof lastReadingAt === 'number' ? `Last reading ${age(lastReadingAt)}` : ''}</span>
              <button
                type="button"
                onClick={onSignIn}
                className="text-[0.78125rem] font-semibold px-3 py-1.5 rounded-lg bg-blue text-crust hover:bg-blue/90 transition-colors shrink-0 focus-ring"
              >
                Sign in again
              </button>
            </div>
          </>
        )
      })()}

      {!quiet && state !== 'sign-in' && duplicates.length > 0 && (
        <div className="px-2.5 py-1.5 rounded-lg bg-red/10 border border-red/25 text-[0.75rem] text-red">
          This profile and {duplicates.length === 1 ? 'another profile' : `${duplicates.length} other profiles`} are
          signed into the SAME account. Each time one refreshes, the others&apos; sign-ins are invalidated — which is
          why they keep expiring. Sign the duplicates in as their own accounts.
        </div>
      )}

      {!quiet && state !== 'sign-in' && auth?.identityMismatch && duplicates.length === 0 && (
        <div className="px-2.5 py-1.5 rounded-lg bg-yellow/10 border border-yellow/25 text-[0.75rem] text-yellow">
          Labelled {auth.accountEmail} but signed in as {auth.oauthEmail}.
        </div>
      )}

      {!quiet && state !== 'sign-in' && (
        ok && ok.buckets.length > 0
          ? (
            <Meters
              buckets={ok.buckets}
              now={now}
              sort={sort}
              usedUp={usedUp}
              dim={state === 'refreshing' || loading}
              loading={loading}
              credits={ok.credits && <CreditsRow value={creditsText(ok.credits) + (typeof ok.creditsFetchedAt === 'number' ? ` · as of ${relAgo(ok.creditsFetchedAt, now)}` : '')} muted={!ok.credits.enabled} />}
            />
          )
          : loading
            ? <MetersPending />
            : ok
              ? <p className="text-[0.78125rem]" style={{ color: MUTED }}>No usage limits reported.</p>
              // A running session uses the account and has not reported yet:
              // the account is never fetched while a session uses it
              // (aicc_planning#378).
              : row?.status === 'waiting'
                ? <p className="text-[0.78125rem]" style={{ color: MUTED }}>Waiting for this account&apos;s session.</p>
                : row?.status === 'error' && state !== 'refreshing'
                  ? <p className="text-[0.78125rem]" style={{ color: MUTED }}>{`Couldn't load usage${row.detail ? ` (${row.detail})` : ''}.`}</p>
                  : !row
                    ? <p className="text-[0.78125rem]" style={{ color: MUTED }} data-testid="account-usage-unavailable">{UNAVAILABLE_LINE}</p>
                    : null
      )}

      {!quiet && state !== 'sign-in' && machines && <MachineLines machines={machines} signedInHere />}

      {!quiet && state !== 'sign-in' && (
        <CardFoot
          left={left}
          right={window_ && <span className={`tabular-nums shrink-0 ${TONE_TEXT[window_.tone]}`} data-testid="account-usage-countdown">{window_.label}</span>}
        />
      )}
    </CardShell>
  )
}

/** When a Codex card's figure is from: "Updated <age>" for a fresh read,
 *  "Updated <age>, from its open session" for an open session's figure, "As
 *  of <age>, from its latest session" for the last one in its history. */
function readingLine(view: ProviderAccountUsageView, now: number): string | null {
  const age = typeof view.readingAt === 'number' ? relAgo(view.readingAt, now) : ''
  if (view.source === 'last-seen') return age ? `As of ${age}, from its latest session` : 'From its latest session'
  if (view.source === 'live') return age ? `Updated ${age}, from its open session` : 'From its open session'
  return age ? `Updated ${age}` : null
}

/**
 * A Codex account's card (usage track MP4; the approved mockup v1): the
 * identity's chip (or "~" for this computer's own sign-in), the account's
 * name, its email and how it signs in, the plan and Default; its meters of
 * what is left; when the figure is from. Never a sign-in countdown: its only
 * source would be the credential file, which the app never reads. A
 * signed-out account offers "Sign in again" (in Settings, Accounts); the menu
 * holds "Read usage again".
 */
export function CodexAccountCard({
  account,
  view,
  name,
  email = null,
  method,
  colour,
  now,
  loading = false,
  best = false,
  sort = DEFAULT_USAGE_SORT,
  providerName = PROVIDER_NAMES[CODEX],
  onSignInAgain,
  onReadAgain,
}: {
  account: AccountView
  /** The account's view; absent until it arrives. */
  view?: ProviderAccountUsageView
  name: string
  /** The account's email, when the registry has one. */
  email?: string | null
  /** How it signs in ("ChatGPT sign-in", "API key"); null for none. */
  method: string | null
  /** The identity's chip colour; null for none. */
  colour: string | null
  now: number
  loading?: boolean
  best?: boolean
  sort?: UsageSortKey
  providerName?: string
  onSignInAgain: () => void
  onReadAgain?: () => void
}) {
  const state = accountViewState(account, view, { now, loading })
  const parked = state === 'parked'
  const plan = view?.planLabel || account.planLabel
  const ok = view && view.status === 'ok' && view.buckets.length > 0 ? view : null
  const usedUp = ok ? usedUpWindow(ok.buckets, now) : null
  // The balance, in Codex credits, from the same reading as the bars (ADR-023).
  // It is drawn only under the bars, so a parked, no-session or per-token card
  // (which never reaches that block) shows none.
  const credits = ok?.credits ? codexCreditsText(ok.credits) : null
  const sub = [email && email !== name ? email : null, method].filter((s): s is string => !!s).join(' · ') || null
  const items: MenuItem[] = !parked && onReadAgain && !loading ? [{ key: 'read-again', label: 'Read usage again', onSelect: onReadAgain }] : []

  const chip = account.external
    ? (
      <span
        aria-hidden="true"
        className="w-2.5 shrink-0 text-center font-bold text-[0.875rem] leading-[0.625rem] mt-[5px]"
        style={{ color: MUTED }}
        data-testid="account-usage-external"
      >
        ~
      </span>
    )
    : <Chip colour={colour ?? 'var(--text-muted)'} />

  const pills = (
    <>
      {parked ? <CardPill>Inactive</CardPill> : plan ? <CardPill tone="plan">{plan}</CardPill> : null}
      {statePill(state)}
      {!parked && account.isProviderDefault && <CardPill>Default</CardPill>}
      {best && <CardPill tone="best" testId="account-usage-best">Most room</CardPill>}
    </>
  )

  let left: React.ReactNode = null
  if (state === 'pending' || (loading && view)) left = view?.readingAt ? `Last reading ${relAgo(view.readingAt, now)} · reading again` : 'Reading usage…'
  else if (state === 'out' && usedUp) left = <span className="text-red" data-testid="account-usage-out">{outLine(usedUp)}</span>
  else if (ok) left = readingLine(ok, now)

  return (
    <CardShell entryKey={`${account.providerId}:${account.id}`} state={state} best={best} loading={loading && !parked} label={name} testId="account-usage-codex-card">
      <CardHead
        chip={chip}
        name={name}
        sub={sub}
        pills={pills}
        providerId={account.providerId}
        providerName={providerName}
        menu={<RowMenu items={items} label={`More actions for ${name}`} testId="account-usage-menu" itemTestId={(k) => `account-usage-menu-${k}`} width={CARD_MENU_WIDTH} />}
      />
      {parked ? (
        <p className="text-[0.78125rem]" style={{ color: MUTED }}>{PARKED_LINE}</p>
      ) : state === 'sign-in' ? (
        <>
          <p className="text-[0.78125rem] text-red" data-testid="account-usage-signin-reason">Signed out</p>
          <p className="text-[0.78125rem] text-subtext0">{SIGNED_OUT_NOTE}</p>
          <div className="mt-auto flex items-center justify-between gap-2">
            <span className="text-[0.6875rem]" style={{ color: MUTED }}>{typeof view?.readingAt === 'number' ? `Last reading ${relAgo(view.readingAt, now)}` : ''}</span>
            <button
              type="button"
              onClick={onSignInAgain}
              className="text-[0.78125rem] font-semibold px-3 py-1.5 rounded-lg bg-blue text-crust hover:bg-blue/90 transition-colors shrink-0 focus-ring"
            >
              Sign in again
            </button>
          </div>
        </>
      ) : (
        <>
          {ok
            ? (
              <Meters
                buckets={ok.buckets}
                now={now}
                sort={sort}
                usedUp={usedUp}
                dim={loading}
                loading={loading}
                credits={credits !== null && <CreditsRow value={credits} testId="account-usage-credits" />}
              />
            )
            : loading
              ? <MetersPending />
              : view?.status === 'no-session-yet'
                ? <p className="text-[0.78125rem]" style={{ color: MUTED }}>{NO_SESSION_YET_LINE}</p>
                : view?.status === 'per-token'
                  ? <p className="text-[0.78125rem]" style={{ color: MUTED }}>{PER_TOKEN_LINE}</p>
                  : view?.status === 'ok'
                    ? <p className="text-[0.78125rem]" style={{ color: MUTED }}>No usage limits reported.</p>
                    : <p className="text-[0.78125rem]" style={{ color: MUTED }} data-testid="account-usage-unavailable">{UNAVAILABLE_LINE}</p>}
          <CardFoot left={left} />
        </>
      )}
    </CardShell>
  )
}

function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}
