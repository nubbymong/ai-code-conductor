// @vitest-environment jsdom
//
// BUG 2 (#239 follow-up): the account-usage page was blind to active/inactive.
// The behavioural hole was the sign-in buttons — they opened a login shell for
// an account the user deliberately parked, bypassing the switcher's own
// active-guard. AccountCard now renders a parked card with NO sign-in and greys
// it. These tests pin exactly that: an inactive row offers neither button and
// shows the parked message; an active row still does.
//
// nubbymong/aicc_planning#445 (the approved mockup v1): "Refresh sign-in"
// moved into the card's menu as "Sign in again now", the blue button reads
// "Sign in again", and every meter says what is LEFT.
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountCard, CodexAccountCard, codexCreditsText, PARKED_LINE } from '../../../src/renderer/components/AccountUsagePanel'
import type { AccountUsage, UsageBucket } from '../../../src/shared/usage-types'
import type { AccountView, ProviderAccountUsageView } from '../../../src/shared/providers'
import { resolveIdentityColor } from '../../../src/shared/identity-colors'
import { formatResetTime } from '../../../src/renderer/utils/terminalFormatting'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return { container, unmount: () => { act(() => root.unmount()); container.remove() } }
}

const row = (over: Partial<AccountUsage>): AccountUsage => ({
  profileId: 'profile-x-1',
  email: 'x@example.com',
  name: 'Acct',
  isPrimary: false,
  status: 'ok',
  buckets: [],
  fetchedAt: 0,
  ...over,
})

function buttonTexts(c: HTMLElement): string[] {
  return Array.from(c.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '')
}

/** Opens a card's menu (it is portalled onto document.body), reads each item
 *  and closes it again; [] for a card with no menu. */
function readMenu<T>(c: HTMLElement, read: (item: Element) => T): T[] {
  const trigger = c.querySelector('[data-testid="account-usage-menu"]') as HTMLElement | null
  if (!trigger) return []
  act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const items = Array.from(document.body.querySelectorAll('[role="menuitem"]')).map(read)
  act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  return items
}
/** The menu's item labels. */
const openMenu = (c: HTMLElement) => readMenu(c, (i) => i.firstChild?.textContent?.trim() ?? '')
/** Each item's smaller line under its label ('' for none). */
const menuDetails = (c: HTMLElement) => readMenu(c, (i) => i.querySelector('span')?.textContent ?? '')

describe('AccountCard — active/inactive awareness', () => {
  it('an inactive account shows NO sign-in button and the parked message', () => {
    const onSignIn = vi.fn()
    const r = render(<AccountCard row={row({ status: 'inactive', active: false })} theme="dark" onSignIn={onSignIn} />)
    expect(buttonTexts(r.container)).toEqual([]) // no Sign in again, and no menu to sign in from
    expect(r.container.textContent).toContain('Inactive')
    expect(r.container.textContent).toMatch(/Parked/i)
    r.unmount()
  })

  it('treats active:false as inactive even if status was left ok (defensive gate)', () => {
    const r = render(<AccountCard row={row({ status: 'ok', active: false, buckets: [] })} theme="dark" onSignIn={vi.fn()} />)
    expect(buttonTexts(r.container)).toEqual([])
    expect(r.container.textContent).toMatch(/Parked/i)
    r.unmount()
  })

  it('a parked account left at needs-login shows NO blue Sign in button (defence in depth)', () => {
    // The one combo the greying gate is meant to cover but a status-only check
    // missed: an inactive account whose token has lapsed. The blue "Sign in"
    // block gates on status === 'needs-login'; without also excluding inactive it
    // would offer a live Sign in for a deliberately parked account.
    const r = render(<AccountCard row={row({ status: 'needs-login', active: false })} theme="dark" onSignIn={vi.fn()} />)
    expect(buttonTexts(r.container)).toEqual([])
    expect(r.container.textContent).toMatch(/Parked/i)
    r.unmount()
  })

  it('an active signed-out account still offers "Sign in again"', () => {
    const r = render(<AccountCard row={row({ status: 'needs-login', active: true })} theme="dark" onSignIn={vi.fn()} />)
    expect(buttonTexts(r.container)).toContain('Sign in again')
    expect(r.container.textContent).not.toMatch(/Parked/i)
    r.unmount()
  })

  it('an active signed-in account still offers "Sign in again now", in its menu', () => {
    const r = render(<AccountCard row={row({ status: 'ok', active: true, buckets: [] })} theme="dark" onSignIn={vi.fn()} />)
    expect(openMenu(r.container)).toContain('Sign in again now')
    r.unmount()
  })

  it('an undefined active field is treated as active (no migration, no greying)', () => {
    const r = render(<AccountCard row={row({ status: 'needs-login' })} theme="dark" onSignIn={vi.fn()} />)
    expect(buttonTexts(r.container)).toContain('Sign in again')
    r.unmount()
  })

  // Usage track MP3 review (D5): an account of a provider that is off offers
  // nothing to act on and no sign-in countdown: nothing of it was read.
  it('an account of a provider that is off shows no menu, no countdown and no warnings', () => {
    const auth = { profileId: 'profile-x-1', hasRefreshToken: true, refreshTokenExpiresAt: Date.now() + 3 * 86_400_000, duplicateOfProfileIds: ['profile-y-1'], identityMismatch: true, accountEmail: 'x@example.com', oauthEmail: 'y@example.com' }
    const r = render(<AccountCard row={row({ status: 'off', active: true })} auth={auth} theme="dark" onSignIn={vi.fn()} />)
    expect(buttonTexts(r.container)).toEqual([])
    expect(r.container.textContent).toContain('Claude Code is off')
    expect(r.container.textContent).not.toMatch(/days?|signed into the SAME account|Labelled/)
    r.unmount()
  })
})

// Usage track MP4 (the approved canvas, Account usage option A). Local times:
// the reset text is the app's own formatResetTime of the same instant.
const NOW = new Date(2026, 8, 27, 12, 0, 0).getTime()
const at = (h: number, m = 0, day = 27) => new Date(2026, 8, day, h, m, 0).toISOString()
const bucket = (label: string, percent: number, resetsAt: string): UsageBucket => ({ key: label, label, group: label === '5h' ? 'session' : 'weekly', percent, resetsAt, severity: 'normal' })
const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})` }
const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

describe('AccountCard: identity, D2 and ages (usage track MP4)', () => {
  afterEach(() => { vi.useRealTimers() })

  // MP4 review F5: the canvas Errors state, exactly as the component words it.
  // #445: signed in with no usable token is the Refreshing state now: the app
  // renews the sign-in by itself.
  it('an account signed in with no usable token is Refreshing; one whose read failed says so exactly', () => {
    const signedIn = render(<AccountCard row={row({ status: 'error', detail: 'signed in' })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(q(signedIn.container, 'account-usage-state-pill')?.textContent).toBe('Refreshing…')
    expect(q(signedIn.container, 'account-usage-card-foot')?.textContent).toBe('Renewing its sign-in by itself')
    expect(signedIn.container.textContent).not.toMatch(/open a session|Couldn't load/)
    signedIn.unmount()
    const limited = render(<AccountCard row={row({ status: 'error', detail: 'HTTP 429' })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(limited.container.querySelector('p')?.textContent).toBe("Couldn't load usage (HTTP 429).")
    limited.unmount()
  })

  // MP4 review F6: each bar names its bucket.
  it('each bar names the window it measures', () => {
    const r = render(<AccountCard row={row({ buckets: [bucket('5h', 34, at(15, 10)), bucket('Weekly', 58, at(9, 0, 30))] })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(Array.from(r.container.querySelectorAll('[role="progressbar"]')).map((b) => b.getAttribute('aria-label'))).toEqual(['5h left', 'Weekly left'])
    r.unmount()
  })

  it('leads with the identity name and colour, the email beside it', () => {
    const r = render(<AccountCard row={row({ email: 'work@example.com' })} identity={{ name: 'Work', colourKey: 'slate-blue' }} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(q(r.container, 'account-usage-name')?.textContent).toBe('Work')
    expect(q(r.container, 'account-usage-sub')?.textContent).toBe('work@example.com')
    expect(q(r.container, 'account-usage-chip')?.style.backgroundColor).toBe(rgb(resolveIdentityColor('slate-blue', 'dark')))
    r.unmount()
  })

  it('with no identity name (or one that is the email) it shows the email alone', () => {
    for (const identity of [undefined, { colourKey: 'pink' }, { name: 'client@example.org', colourKey: 'pink' }]) {
      const r = render(<AccountCard row={row({ email: 'client@example.org' })} identity={identity} theme="dark" onSignIn={vi.fn()} now={NOW} />)
      expect(q(r.container, 'account-usage-name')?.textContent).toBe('client@example.org')
      expect(q(r.container, 'account-usage-sub')).toBeNull()
      r.unmount()
    }
  })

  it('a window past its reset shows "Reset <time>, no reading since" and no figure; the others keep theirs (D2)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const past = at(9, 40)
    const r = render(<AccountCard row={row({ buckets: [bucket('5h', 34, past), bucket('Weekly', 58, at(9, 0, 30))] })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(r.container.textContent).toContain(`Reset ${formatResetTime(past)}, no reading since`)
    expect(r.container.textContent).not.toContain('66% left')
    expect(r.container.textContent).toContain('42% left')
    expect(r.container.querySelectorAll('[role="progressbar"]')).toHaveLength(1)
    r.unmount()
  })

  it('an age reads in hours and days, not minutes', () => {
    const r = render(<AccountCard row={row({ buckets: [bucket('Weekly', 5, at(9, 0, 30))], stale: true, fetchedAt: NOW - 5 * 3_600_000 })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(r.container.textContent).toMatch(/Last updated 5 h ago . couldn't refresh/)
    r.unmount()
    const d = render(<AccountCard row={row({ buckets: [bucket('Weekly', 5, at(9, 0, 30))], stale: true, fetchedAt: NOW - 26 * 3_600_000 })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(d.container.textContent).toMatch(/Last updated 1 day ago/)
    d.unmount()
  })
})

// aicc_planning#378: an account a running session uses is never fetched, so
// its card shows that session's figure and never says a refresh failed.
describe('AccountCard: an account a running session uses', () => {
  it('an old figure reads "Last updated <age>" and never "couldn\'t refresh"', () => {
    const r = render(<AccountCard row={row({ buckets: [bucket('Weekly', 5, at(9, 0, 30))], stale: true, inSession: true, fetchedAt: NOW - 5 * 60_000 })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(r.container.textContent).toContain('Last updated 5 min ago')
    expect(r.container.textContent).not.toMatch(/couldn't refresh/i)
    r.unmount()
  })

  // #445 (the mockup): a current figure is live from its open session, In use.
  it('a current figure reads "Live from its open session", In use', () => {
    const r = render(<AccountCard row={row({ buckets: [bucket('Weekly', 5, at(9, 0, 30))], stale: false, inSession: true, fetchedAt: NOW - 10_000 })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(r.container.textContent).toContain('Live from its open session')
    expect(q(r.container, 'account-usage-state-pill')?.textContent).toBe('In use')
    r.unmount()
  })

  it('with no figure yet it waits for the session, and says nothing failed', () => {
    const r = render(<AccountCard row={row({ status: 'waiting', inSession: true, detail: "waiting for this account's session" })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(r.container.textContent).toContain("Waiting for this account's session.")
    expect(r.container.textContent).not.toMatch(/Couldn't load|No usage limits|open a session/)
    expect(r.container.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    expect(openMenu(r.container)).toEqual(['Sign in again now'])
    expect(menuDetails(r.container)).toEqual(['Resets the forced sign-in countdown. Opens a terminal for this account.'])
    r.unmount()
  })

  it('a parked account never shows the waiting line', () => {
    const r = render(<AccountCard row={row({ status: 'waiting', active: false })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(r.container.textContent).not.toContain('Waiting for')
    r.unmount()
  })

  it('credits fetched earlier than the bars carry their own time; credits of the same reading do not', () => {
    const money = (n: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n)
    const credits = { currency: 'USD', used: 0, limit: null, remaining: 12, enabled: true }
    const r = render(<AccountCard row={row({ buckets: [bucket('5h', 20, at(15, 0))], credits, creditsFetchedAt: NOW - 3 * 3_600_000, inSession: true, fetchedAt: NOW - 5_000 })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(r.container.textContent).toContain(`${money(12)} left \u00b7 as of 3 h ago`)
    r.unmount()
    const same = render(<AccountCard row={row({ buckets: [bucket('5h', 20, at(15, 0))], credits, fetchedAt: NOW - 5_000 })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(same.container.textContent).toContain(`${money(12)} left`)
    expect(same.container.textContent).not.toContain('as of')
    same.unmount()
  })
})

const cxAccount = (over: Partial<AccountView> = {}): AccountView => ({
  id: 'acct-1', providerId: 'codex', identityId: 'identity-1', lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false,
  authMethod: 'browser', lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted',
  realmLifecycle: 'active', external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
  ...over,
})
const cxView = (over: Partial<ProviderAccountUsageView> = {}): ProviderAccountUsageView => ({
  accountId: 'acct-1', providerId: 'codex', status: 'ok', source: 'live', readingAt: NOW,
  buckets: [bucket('5h', 18, at(14, 45)), bucket('Weekly', 47, at(18, 0, 30))], planLabel: 'Plus',
  ...over,
})
function cxCard(o: { account?: Partial<AccountView>; view?: Partial<ProviderAccountUsageView>; name?: string; method?: string | null; colour?: string | null; onSignInAgain?: () => void } = {}) {
  return render(
    <CodexAccountCard
      account={cxAccount(o.account)}
      view={cxView(o.view)}
      name={o.name ?? 'Work'}
      method={o.method === undefined ? 'ChatGPT sign-in' : o.method}
      colour={o.colour === undefined ? '#3ba8d4' : o.colour}
      now={NOW}
      onSignInAgain={o.onSignInAgain ?? vi.fn()}
    />,
  )
}

describe('CodexAccountCard (usage track MP4)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('an account with an open session: name, sign-in method, plan and Default, In use, its bars of what is left, "Updated just now", and nothing to sign in', () => {
    const r = cxCard({ account: { isProviderDefault: true } })
    expect(q(r.container, 'account-usage-name')?.textContent).toBe('Work')
    expect(q(r.container, 'account-usage-sub')?.textContent).toBe('ChatGPT sign-in')
    expect(q(r.container, 'account-usage-chip')?.style.backgroundColor).toBe(rgb('#3ba8d4'))
    // The mockup's order: the plan first, then Default.
    expect(Array.from(r.container.querySelectorAll('[data-testid="account-usage-pill"]')).map((p) => p.textContent)).toEqual(['Plus', 'Default'])
    expect(q(r.container, 'account-usage-state-pill')?.textContent).toBe('In use')
    expect(r.container.textContent).toContain('82% left')
    expect(r.container.textContent).toContain('53% left')
    expect(r.container.textContent).toContain('Updated just now, from its open session')
    expect(openMenu(r.container)).toEqual([])
    expect(buttonTexts(r.container)).toEqual([])
    expect(r.container.textContent).not.toMatch(/Forced sign-in|countdown/i)
    r.unmount()
  })

  it('a closed account shows its last-seen reading "As of <age>, from its latest session"', () => {
    const r = cxCard({ view: { source: 'last-seen', readingAt: NOW - 3 * 3_600_000, planLabel: 'Pro' } })
    expect(r.container.textContent).toContain('As of 3 h ago, from its latest session')
    expect(r.container.textContent).toContain('Pro')
    r.unmount()
  })

  it('a window past its reset reads "no reading since" (D2)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const past = at(11, 40)
    const r = cxCard({ view: { source: 'last-seen', buckets: [bucket('5h', 12, past), bucket('Weekly', 41, at(18, 0, 30))] } })
    expect(r.container.textContent).toContain(`Reset ${formatResetTime(past)}, no reading since`)
    expect(r.container.textContent).not.toContain('88% left')
    expect(r.container.textContent).toContain('59% left')
    r.unmount()
  })

  it('no session yet, and an API-key account, each say so and show no bars', () => {
    const none = cxCard({ view: { status: 'no-session-yet', buckets: [], source: undefined, readingAt: undefined, planLabel: undefined } })
    expect(none.container.textContent).toContain('No session on this account yet. Its allowance shows after the first one.')
    expect(none.container.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    none.unmount()
    const key = cxCard({ account: { authMethod: 'apiKey' }, method: 'API key', view: { status: 'per-token', buckets: [], source: undefined, readingAt: undefined, planLabel: undefined } })
    expect(key.container.textContent).toContain('Billed per token, so there is no plan allowance.')
    expect(q(key.container, 'account-usage-sub')?.textContent).toBe('API key')
    key.unmount()
  })

  it('this computer\'s own sign-in shows the "~" avatar and no chip or method', () => {
    const r = cxCard({ account: { external: true, authMethod: 'external' }, name: "This computer's Codex", method: null, colour: null })
    expect(q(r.container, 'account-usage-external')?.textContent).toBe('~')
    expect(q(r.container, 'account-usage-chip')).toBeNull()
    expect(q(r.container, 'account-usage-sub')).toBeNull()
    r.unmount()
  })

  it('a parked account shows Inactive and the parked line, and no plan, bars or menu', () => {
    const r = cxCard({ account: { lifecycle: 'inactive', isProviderDefault: true }, view: { status: 'inactive', buckets: [] } })
    expect(Array.from(r.container.querySelectorAll('[data-testid="account-usage-pill"]')).map((p) => p.textContent)).toEqual(['Inactive'])
    expect(r.container.textContent).toContain(PARKED_LINE)
    expect(buttonTexts(r.container)).toEqual([])
    expect(r.container.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    r.unmount()
  })

  // #445 (the mockup's signed-out card): the reason, when it was last read and
  // the Sign in again button; no bars from a sign-in that no longer works.
  it('a signed-out account offers "Sign in again" and says when it was last read', () => {
    const onSignInAgain = vi.fn()
    const r = cxCard({ onSignInAgain, account: { lastKnownAuthState: 'signed-out' }, view: { status: 'not-signed-in', source: 'last-seen', readingAt: NOW - 2 * 3_600_000 } })
    expect(q(r.container, 'account-usage-signin-reason')?.textContent).toBe('Signed out')
    expect(r.container.textContent).toContain('Last reading 2 h ago')
    expect(r.container.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    expect(q(r.container, 'account-usage-codex-card')?.getAttribute('data-state')).toBe('sign-in')
    const signIn = Array.from(r.container.querySelectorAll('button')).find((b) => b.textContent === 'Sign in again') as HTMLElement
    act(() => { signIn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onSignInAgain).toHaveBeenCalledTimes(1)
    r.unmount()
  })
})

// P3.14 (ADR-023): the credits row. Claude's card has one (money, an ISO
// currency); a Codex card gets the same row in Codex's own unit: Codex
// credits, a count, not money (P3.1 evidence answer 7).
describe('the credits row (P3.14)', () => {
  afterEach(() => { vi.useRealTimers() })

  const count = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)
  const money = (n: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n)
  const creditsRow = (c: HTMLElement) => q(c, 'account-usage-credits')
  const withCredits = (credits: ProviderAccountUsageView['credits'], over: Partial<ProviderAccountUsageView> = {}) => ({ credits, ...over })

  describe('Codex: codexCreditsText', () => {
    it('a balance reads in Codex credits, the count the CLI itself prints', () => {
      expect(codexCreditsText({ hasCredits: true, unlimited: false, balance: 1250 })).toBe(`${count(1250)} credits`)
      expect(codexCreditsText({ hasCredits: true, unlimited: false, balance: 0.5 })).toBe(`${count(0.5)} credits`)
      expect(codexCreditsText({ hasCredits: true, unlimited: false, balance: 1250.567 })).toBe(`${count(1250.567)} credits`)
    })

    it('shows at most two fraction digits', () => {
      const text = codexCreditsText({ hasCredits: true, unlimited: false, balance: 1.23456 })!
      expect(text).toBe(`${count(1.23)} credits`)
      expect(text).not.toContain('456')
    })

    // Round 1, N2: a positive balance below the smallest figure shown is never
    // rounded down to "0 credits"; it reads "<0.01 credits". Zero stays zero.
    it('a positive balance under the smallest figure shown reads "<0.01 credits", never "0 credits"', () => {
      const small = `<${count(0.01)} credits`
      for (const balance of [0.004, 0.001, 0.0049, 1e-12]) {
        expect(codexCreditsText({ hasCredits: true, unlimited: false, balance }), String(balance)).toBe(small)
      }
      expect(codexCreditsText({ hasCredits: true, unlimited: false, balance: 0.005 })).toBe(`${count(0.01)} credits`)
      expect(codexCreditsText({ hasCredits: true, unlimited: false, balance: 0.01 })).toBe(`${count(0.01)} credits`)
      expect(codexCreditsText({ hasCredits: true, unlimited: false, balance: 0 })).toBe(`${count(0)} credits`)
      expect(codexCreditsText({ hasCredits: true, unlimited: false, balance: 0 })).not.toContain('<')
    })

    it('unlimited reads "Unlimited", whatever the balance', () => {
      expect(codexCreditsText({ hasCredits: true, unlimited: true, balance: null })).toBe('Unlimited')
      expect(codexCreditsText({ hasCredits: false, unlimited: true, balance: 5 })).toBe('Unlimited')
    })

    it('nothing to say is no text: no credits, no balance (an unobserved state is not invented)', () => {
      expect(codexCreditsText({ hasCredits: false, unlimited: false, balance: null })).toBeNull()
      expect(codexCreditsText({ hasCredits: false, unlimited: false, balance: 12 })).toBeNull()
      expect(codexCreditsText({ hasCredits: true, unlimited: false, balance: null })).toBeNull()
    })

    it('never money: no currency symbol or code', () => {
      const text = codexCreditsText({ hasCredits: true, unlimited: false, balance: 1250 })!
      expect(text).not.toMatch(/USD|GBP|EUR/)
      for (const symbol of ['$', String.fromCharCode(0xa3), String.fromCharCode(0x20ac)]) expect(text).not.toContain(symbol)
    })
  })

  describe('Codex card', () => {
    it('a balance shows as a "Credits" row under the bars, "N credits" on the right, styled as Claude\'s', () => {
      const r = cxCard({ view: withCredits({ hasCredits: true, unlimited: false, balance: 1250 }) })
      const row = creditsRow(r.container)!
      expect(row).not.toBeNull()
      const [label, value] = Array.from(row.querySelectorAll('span'))
      expect(label.textContent).toBe('Credits')
      expect(value.textContent).toBe(`${count(1250)} credits`)
      // The same classes as Claude's row.
      expect(row.className).toContain('border-t')
      expect(label.className).toContain('text-overlay1')
      expect(value.className).toContain('tabular-nums')
      expect(value.className).toContain('text-text')
      // Under the bars, in the same column.
      const bars = r.container.querySelectorAll('[role="progressbar"]')
      expect(bars.length).toBeGreaterThan(0)
      expect(row.parentElement).toBe(bars[0].closest('div.flex.flex-col'))
      r.unmount()
    })

    it('unlimited shows "Unlimited"', () => {
      const r = cxCard({ view: withCredits({ hasCredits: true, unlimited: true, balance: null }) })
      expect(creditsRow(r.container)!.textContent).toBe('CreditsUnlimited')
      r.unmount()
    })

    it('hasCredits false, or no balance, or no credits at all: no row', () => {
      for (const credits of [{ hasCredits: false, unlimited: false, balance: null }, { hasCredits: false, unlimited: false, balance: 40 }, { hasCredits: true, unlimited: false, balance: null }, undefined]) {
        const r = cxCard({ view: withCredits(credits) })
        expect(creditsRow(r.container), JSON.stringify(credits)).toBeNull()
        expect(r.container.textContent).not.toContain('Credits')
        r.unmount()
      }
    })

    it('a card with credits keeps every other part of the card: the bars, the plan and the age line', () => {
      const r = cxCard({ view: withCredits({ hasCredits: true, unlimited: false, balance: 1250 }) })
      expect(r.container.textContent).toContain('82% left')
      expect(r.container.textContent).toContain('53% left')
      expect(r.container.textContent).toContain('Plus')
      expect(r.container.textContent).toContain('Updated just now')
      r.unmount()
    })

    it('a last-seen view shows its credits above "As of ..."', () => {
      const r = cxCard({ view: withCredits({ hasCredits: true, unlimited: false, balance: 1250 }, { source: 'last-seen', readingAt: NOW - 3 * 3_600_000 }) })
      const row = creditsRow(r.container)!
      const as = q(r.container, 'account-usage-card-foot')!
      expect(as.textContent).toContain('As of 3 h ago')
      expect(row.compareDocumentPosition(as) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      r.unmount()
    })

    // #445 (the mockup's signed-out card): no bars, so no credits under them.
    it('a signed-out account shows no credits row, only "Sign in again"', () => {
      const r = cxCard({ account: { lastKnownAuthState: 'signed-out' }, view: withCredits({ hasCredits: true, unlimited: false, balance: 1250 }, { status: 'not-signed-in', source: 'last-seen', readingAt: NOW - 3_600_000 }) })
      expect(creditsRow(r.container)).toBeNull()
      expect(buttonTexts(r.container)).toContain('Sign in again')
      r.unmount()
    })

    it('no session yet, an API-key account and a parked account show no credits row, whatever the view carries', () => {
      const credits = { hasCredits: true, unlimited: false, balance: 1250 }
      const none = cxCard({ view: withCredits(credits, { status: 'no-session-yet', buckets: [], source: undefined, readingAt: undefined, planLabel: undefined }) })
      expect(creditsRow(none.container)).toBeNull()
      none.unmount()
      const key = cxCard({ account: { authMethod: 'apiKey' }, method: 'API key', view: withCredits(credits, { status: 'per-token', buckets: [], source: undefined, readingAt: undefined, planLabel: undefined }) })
      expect(creditsRow(key.container)).toBeNull()
      key.unmount()
      const parked = cxCard({ account: { lifecycle: 'inactive' }, view: withCredits(credits, { status: 'inactive', buckets: [] }) })
      expect(creditsRow(parked.container)).toBeNull()
      parked.unmount()
    })

    it('a view with credits but no bars shows no row (the bars are what it sits under)', () => {
      const r = cxCard({ view: withCredits({ hasCredits: true, unlimited: false, balance: 1250 }, { buckets: [] }) })
      expect(creditsRow(r.container)).toBeNull()
      r.unmount()
    })
  })

  describe('Claude card (the parity this row copies)', () => {
    const claudeBuckets = [bucket('5h', 34, at(15, 10)), bucket('Weekly', 58, at(18, 0, 30))]
    const claudeCard = (credits: AccountUsage['credits']) => render(<AccountCard row={row({ buckets: claudeBuckets, credits })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    const claudeRow = (c: HTMLElement) => Array.from(c.querySelectorAll('span')).find((s) => s.textContent === 'Credits')?.parentElement as HTMLElement | undefined

    it('enabled with a remaining balance reads "<money> left"', () => {
      const r = claudeCard({ currency: 'GBP', remaining: 12.5, used: 7.5, limit: 20, enabled: true })
      const rowEl = claudeRow(r.container)!
      expect(rowEl.querySelectorAll('span')[1].textContent).toBe(`${money(12.5, 'GBP')} left`)
      expect(rowEl.querySelectorAll('span')[1].className).toContain('text-text')
      r.unmount()
    })

    it('enabled with no balance reads "<money> used"', () => {
      const r = claudeCard({ currency: 'GBP', remaining: null, used: 4, limit: null, enabled: true })
      expect(claudeRow(r.container)!.querySelectorAll('span')[1].textContent).toBe(`${money(4, 'GBP')} used`)
      r.unmount()
    })

    it('disabled because out of credits reads "Out of credits", muted, with what was used', () => {
      const r = claudeCard({ currency: 'GBP', remaining: 0, used: 20, limit: 20, enabled: false, disabledReason: 'out_of_credits' })
      const value = claudeRow(r.container)!.querySelectorAll('span')[1]
      expect(value.textContent).toBe(`Out of credits ${String.fromCharCode(0xb7)} ${money(20, 'GBP')} used`)
      expect(value.className).toContain('text-overlay1')
      r.unmount()
    })

    it('disabled for any other reason reads "Off"', () => {
      const r = claudeCard({ currency: 'GBP', remaining: null, used: 0, limit: null, enabled: false })
      expect(claudeRow(r.container)!.querySelectorAll('span')[1].textContent).toBe('Off')
      r.unmount()
    })

    it('no credits, no row; and Claude\'s row is the markup it always was (no test id added)', () => {
      const none = claudeCard(undefined)
      expect(claudeRow(none.container)).toBeUndefined()
      none.unmount()
      const r = claudeCard({ currency: 'GBP', remaining: 12.5, used: 7.5, limit: 20, enabled: true })
      expect(q(r.container, 'account-usage-credits')).toBeNull()
      expect(claudeRow(r.container)!.className).toBe('flex items-center justify-between text-[0.8125rem] mt-1 pt-2 border-t border-surface0/60')
      r.unmount()
    })
  })
})

// nubbymong/aicc_planning#445 (the approved mockup v1): each card state as
// the card draws it, the meters as what is LEFT (the sorted-on one bold), the
// plan pill from the stored sign-in, Most room, the loading meters, and the
// card menu wired to the page's actions.
describe('the card states (aicc_planning#445)', () => {
  const card = (c: HTMLElement) => c.querySelector('[data-testid="account-usage-card"]') as HTMLElement
  const auth = (over: Record<string, unknown> = {}) => ({ profileId: 'profile-x-1', hasRefreshToken: true, expiresAt: NOW - 3_600_000, refreshTokenExpiresAt: NOW + 19 * 86_400_000 + 60_000, ...over })
  const okRow = (over: Partial<AccountUsage> = {}) => row({ buckets: [bucket('5h', 9, at(16, 10)), bucket('Weekly', 36, at(9, 0, 30))], fetchedAt: NOW - 2 * 60_000, ...over })

  it('Ready: meters say what is left with their reset, the 5h one bold; the foot ages and counts down', () => {
    const r = render(<AccountCard row={okRow()} auth={auth({ expiresAt: NOW + 3_600_000 })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(card(r.container).getAttribute('data-state')).toBe('ready')
    const meters = Array.from(r.container.querySelectorAll('[data-testid="account-usage-meter"]'))
    expect(meters.map((m) => m.querySelector('[data-testid="account-usage-left"]')?.textContent)).toEqual(['91% left', '64% left'])
    expect(meters[0].textContent).toContain(`resets ${formatResetTime(at(16, 10))}`)
    expect(meters.map((m) => m.getAttribute('data-bold'))).toEqual(['true', null])
    expect(Array.from(r.container.querySelectorAll('[role="progressbar"]')).map((b) => b.getAttribute('aria-valuenow'))).toEqual(['91', '64'])
    expect(q(r.container, 'account-usage-card-foot')?.textContent).toBe('Updated 2 min agoForced sign-in in 19 days')
    r.unmount()
  })

  it('sorted by weekly left, the weekly meter is the bold one', () => {
    const r = render(<AccountCard row={okRow()} theme="dark" onSignIn={vi.fn()} now={NOW} sort="weekly" />)
    expect(Array.from(r.container.querySelectorAll('[data-testid="account-usage-meter"]')).map((m) => m.getAttribute('data-bold'))).toEqual([null, 'true'])
    r.unmount()
  })

  it('a per-model meter stays, small, and is never the bold one', () => {
    const fable: UsageBucket = { key: 'weekly:Fable', label: 'Fable', group: 'weekly', percent: 22, resetsAt: at(9, 0, 30), severity: 'normal' }
    const r = render(<AccountCard row={okRow({ buckets: [fable, ...okRow().buckets] })} theme="dark" onSignIn={vi.fn()} now={NOW} sort="weekly" />)
    const meters = Array.from(r.container.querySelectorAll('[data-testid="account-usage-meter"]'))
    expect(meters.map((m) => m.firstElementChild?.firstElementChild?.textContent)).toEqual(['Fable', '5h', 'Weekly'])
    expect(meters.map((m) => m.getAttribute('data-bold'))).toEqual([null, null, 'true'])
    expect(meters[0].querySelector('[role="progressbar"]')?.className).toContain('h-[5px]')
    r.unmount()
  })

  it('the plan pill comes from the stored sign-in\'s subscription type; an unknown one shows none', () => {
    const max = render(<AccountCard row={okRow()} auth={auth({ subscriptionType: 'max' })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(Array.from(max.container.querySelectorAll('[data-testid="account-usage-pill"]')).map((p) => p.textContent)).toEqual(['Max'])
    max.unmount()
    const odd = render(<AccountCard row={okRow({ isPrimary: true })} auth={auth({ subscriptionType: 'mystery' })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(Array.from(odd.container.querySelectorAll('[data-testid="account-usage-pill"]')).map((p) => p.textContent)).toEqual(['Primary'])
    odd.unmount()
  })

  it('Refreshing: the spinner pill, the last reading dimmed, and the foot says it renews itself', () => {
    const r = render(<AccountCard row={okRow({ stale: true, fetchedAt: NOW - 3 * 3_600_000 })} auth={auth()} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(card(r.container).getAttribute('data-state')).toBe('refreshing')
    expect(q(r.container, 'account-usage-state-pill')?.textContent).toBe('Refreshing…')
    expect(q(r.container, 'account-usage-meters')?.className).toContain('opacity-50')
    expect(r.container.textContent).toContain('91% left')
    expect(q(r.container, 'account-usage-card-foot')?.textContent).toBe('Renewing its sign-in by itself · last reading 3 h agoForced sign-in in 19 days')
    r.unmount()
  })

  it('In use: the live pill and "Live from its open session"', () => {
    const r = render(<AccountCard row={okRow({ inSession: true })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(card(r.container).getAttribute('data-state')).toBe('in-use')
    expect(q(r.container, 'account-usage-state-pill')?.textContent).toBe('In use')
    expect(q(r.container, 'account-usage-card-foot')?.textContent).toBe('Live from its open session')
    r.unmount()
  })

  it('Out of 5h until <time>: the used-up meter says when it is back', () => {
    const back = at(18, 40)
    const r = render(<AccountCard row={okRow({ buckets: [bucket('5h', 100, back), bucket('Weekly', 70, at(9, 0, 30))] })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(card(r.container).getAttribute('data-state')).toBe('out')
    expect(q(r.container, 'account-usage-out')?.textContent).toBe(`Out of 5h until ${formatResetTime(back)}`)
    expect(r.container.querySelector('[data-testid="account-usage-meter"]')?.textContent).toBe(`5h0% leftback at ${formatResetTime(back)}`)
    r.unmount()
  })

  it('Out of the week: a used-up weekly window says so', () => {
    const back = at(9, 0, 30)
    const r = render(<AccountCard row={okRow({ buckets: [bucket('5h', 10, at(16)), bucket('Weekly', 100, back)] })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(q(r.container, 'account-usage-out')?.textContent).toBe(`Out of the week until ${formatResetTime(back)}`)
    r.unmount()
  })

  it('Sign in again, expired: the day it ran out, why, when it was last read, and the button', () => {
    const onSignIn = vi.fn()
    const expired = NOW - 6 * 86_400_000
    const r = render(<AccountCard row={row({ status: 'needs-login', detail: 'not signed in' })} auth={auth({ refreshTokenExpiresAt: expired })} lastReadingAt={NOW - 6 * 86_400_000} theme="dark" onSignIn={onSignIn} now={NOW} />)
    expect(card(r.container).getAttribute('data-state')).toBe('sign-in')
    expect(card(r.container).className).toContain('border-red/35')
    expect(q(r.container, 'account-usage-signin-reason')?.textContent).toBe(`Sign-in expired on ${new Date(expired).toLocaleDateString([], { day: 'numeric', month: 'short' })}`)
    expect(r.container.textContent).toContain('Its long-lived sign-in ran out, so Claude Code needs you to sign in once.')
    expect(r.container.textContent).toContain('Last reading 6 days ago')
    // Signing in is the card's own button; the menu holds no second one.
    expect(openMenu(r.container)).toEqual([])
    const button = Array.from(r.container.querySelectorAll('button')).find((b) => b.textContent === 'Sign in again') as HTMLElement
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onSignIn).toHaveBeenCalledTimes(1)
    r.unmount()
  })

  it('Sign in again with no sign-in stored says "Not signed in"', () => {
    const r = render(<AccountCard row={row({ status: 'needs-login', detail: 'not signed in' })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(q(r.container, 'account-usage-signin-reason')?.textContent).toBe('Not signed in')
    expect(r.container.textContent).toContain('This account has no sign-in stored')
    r.unmount()
  })

  it('Parked: greyed, the parked line, Inactive, and nothing to act on', () => {
    const r = render(<AccountCard row={row({ status: 'inactive', active: false })} auth={auth({ subscriptionType: 'pro' })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(card(r.container).getAttribute('data-state')).toBe('parked')
    expect(card(r.container).className).toContain('opacity-60')
    expect(r.container.textContent).toContain(PARKED_LINE)
    expect(Array.from(r.container.querySelectorAll('[data-testid="account-usage-pill"]')).map((p) => p.textContent)).toEqual(['Inactive'])
    expect(q(r.container, 'account-usage-countdown')).toBeNull()
    r.unmount()
  })

  it('the account with the most room is outlined with the "Most room" pill', () => {
    const r = render(<AccountCard row={okRow()} theme="dark" onSignIn={vi.fn()} now={NOW} best />)
    expect(card(r.container).getAttribute('data-best')).toBe('true')
    expect(card(r.container).className).toContain('border-green/55')
    expect(q(r.container, 'account-usage-best')?.textContent).toBe('Most room')
    r.unmount()
    const plain = render(<AccountCard row={okRow()} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(q(plain.container, 'account-usage-best')).toBeNull()
    plain.unmount()
  })

  it('drawn from the profile before its reading: identity at once, meters animating', () => {
    const profile = { id: 'profile-x-1', name: 'Acct', accountEmail: 'p@example.com', createdAt: 0 }
    const r = render(<AccountCard profile={profile} theme="dark" onSignIn={vi.fn()} now={NOW} loading />)
    expect(q(r.container, 'account-usage-name')?.textContent).toBe('p@example.com')
    expect(card(r.container).getAttribute('data-state')).toBe('pending')
    expect(card(r.container).getAttribute('aria-busy')).toBe('true')
    expect(q(r.container, 'account-usage-loading')).not.toBeNull()
    expect(r.container.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    expect(q(r.container, 'account-usage-card-foot')?.textContent).toBe('Reading usage…')
    r.unmount()
  })

  it('a fresh reading on its way: the last one stays, dimmed, its bars sweeping', () => {
    const r = render(<AccountCard row={okRow({ fetchedAt: NOW - 3 * 3_600_000 })} theme="dark" onSignIn={vi.fn()} now={NOW} loading />)
    const meters = q(r.container, 'account-usage-loading')!
    expect(meters.className).toContain('opacity-50')
    expect(meters.querySelector('[role="progressbar"]')?.className).toContain('statusline-pending-track')
    expect(r.container.textContent).toContain('91% left')
    expect(q(r.container, 'account-usage-card-foot')?.textContent).toBe('Last reading 3 h ago · reading again')
    r.unmount()
  })

  it('the menu: "Read usage again", then "Sign in again now" with what it resets; each calls its action', () => {
    const onSignIn = vi.fn()
    const onReadAgain = vi.fn()
    const r = render(<AccountCard row={okRow()} auth={auth({ expiresAt: NOW + 3_600_000, refreshTokenExpiresAt: NOW + 5.5 * 86_400_000 })} theme="dark" onSignIn={onSignIn} onReadAgain={onReadAgain} now={NOW} />)
    expect(q(r.container, 'account-usage-menu')?.getAttribute('aria-label')).toBe('More actions for x@example.com')
    expect(openMenu(r.container)).toEqual(['Read usage again', 'Sign in again now'])
    expect(menuDetails(r.container)).toEqual(['', 'Resets the 5-day forced sign-in countdown. Opens a terminal for this account.'])
    const pick = (key: string) => {
      act(() => { q(r.container, 'account-usage-menu')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      act(() => { (document.body.querySelector(`[data-testid="account-usage-menu-${key}"]`) as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    }
    pick('read-again')
    expect(onReadAgain).toHaveBeenCalledTimes(1)
    pick('sign-in-now')
    expect(onSignIn).toHaveBeenCalledTimes(1)
    r.unmount()
  })

  it('a Codex card\'s menu reads it again; there is no sign-in countdown to reset', () => {
    const onReadAgain = vi.fn()
    const r = render(
      <CodexAccountCard account={cxAccount()} view={cxView({ source: 'read' })} name="Work" method="ChatGPT sign-in" colour={null} now={NOW} onSignInAgain={vi.fn()} onReadAgain={onReadAgain} />,
    )
    expect(openMenu(r.container)).toEqual(['Read usage again'])
    act(() => { q(r.container, 'account-usage-menu')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    act(() => { (document.body.querySelector('[data-testid="account-usage-menu-read-again"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onReadAgain).toHaveBeenCalledTimes(1)
    r.unmount()
  })

  it('a Codex card names its email beside how it signs in, as the mockup does', () => {
    const r = render(
      <CodexAccountCard account={cxAccount()} view={cxView()} name="Codex H" email="h@example.com" method="ChatGPT sign-in" colour={null} now={NOW} onSignInAgain={vi.fn()} />,
    )
    expect(q(r.container, 'account-usage-sub')?.textContent).toBe('h@example.com · ChatGPT sign-in')
    r.unmount()
  })
})
