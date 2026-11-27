// @vitest-environment jsdom
//
// 2.1.3-beta.20 section 5, frame 1 of the approved mockup "Accounts across
// machines" (Claude Code rows only): a Claude Code card's "On machines" block
// says the account's sign-in on this computer and on each added Linux machine,
// with "Sign in on <machine>" where it is not signed in there. No line says
// lent (Lend from this computer is not built yet: Q7). A card with no machine
// added, or a parked one, draws no block. The page foot names the machines'
// rule while one is added.
//
// PURE: AccountCard and its machine lines from utils/hostAccounts, no IPC.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountCard, MACHINES_FOOT_LINE, type CardMachines } from '../../../src/renderer/components/AccountUsagePanel'
import { cardMachineLine } from '../../../src/renderer/utils/hostAccounts'
import type { AccountUsage } from '../../../src/shared/usage-types'
import type { HostAccountSignIn } from '../../../src/shared/host-accounts'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return { container, unmount: () => { act(() => root.unmount()); container.remove() } }
}

const row = (over: Partial<AccountUsage> = {}): AccountUsage => ({
  profileId: 'p2', email: 'p@x.io', name: 'Personal', isPrimary: false, status: 'ok', buckets: [], fetchedAt: Date.now(), ...over,
})
const ROCKY = { did: 'a'.repeat(32), name: 'Rocky (nick@rocky.lan:22)', target: 'nick@rocky.lan:22', label: 'Rocky' }
const PI = { did: 'b'.repeat(32), name: 'Pi (tester@pi.lan:22)', target: 'tester@pi.lan:22', label: 'Pi' }
const UBU = { did: 'c'.repeat(32), name: 'Ubuntu (nick@ubu.lan:22)', target: 'nick@ubu.lan:22', label: 'Ubuntu' }
const OTHER = { did: 'e'.repeat(32), name: 'Other (nick@o.lan:22)', target: 'nick@o.lan:22', label: 'Other' }
const at = (state: HostAccountSignIn['state'], identity: string | null = null): Pick<HostAccountSignIn, 'state' | 'facts'> => ({
  state, facts: identity ? { identity, plan: null, tier: null, expiresAt: 1, credentials: true } : null,
})
function machines(onSignIn = vi.fn()): CardMachines {
  return {
    lines: [
      { machine: ROCKY, line: cardMachineLine(at('not-signed-in'), 'Rocky') },
      { machine: PI, line: cardMachineLine(at('machine-own', 'p@x.io'), 'Pi') },
      { machine: UBU, line: cardMachineLine(at('signed-in-here', 'p@x.io'), 'Ubuntu') },
      { machine: OTHER, line: cardMachineLine(at('not-read'), 'Other') },
    ],
    onSignIn,
  }
}
const lines = (c: HTMLElement) => [...c.querySelectorAll('[data-testid="account-usage-machine"]')].map((r) => ({
  name: (r as HTMLElement).dataset.machine,
  tone: (r as HTMLElement).dataset.tone,
  state: r.querySelector('[data-testid="account-usage-machine-state"]')?.textContent,
  button: r.querySelector('[data-testid="account-usage-machine-signin"]')?.textContent ?? null,
}))

describe('a Claude Code card\'s "On machines" (frame 1)', () => {
  it('this computer first, then each machine\'s line per state, with Sign in on <machine> where it is not signed in', () => {
    const r = render(<AccountCard row={row()} theme="dark" onSignIn={vi.fn()} machines={machines()} />)
    const block = r.container.querySelector('[data-testid="account-usage-machines"]')
    expect(block?.textContent?.startsWith('On machines')).toBe(true)
    expect(lines(r.container)).toEqual([
      { name: 'This computer', tone: 'ok', state: 'Signed in', button: null },
      { name: 'Rocky', tone: 'none', state: 'Not signed in', button: 'Sign in on Rocky' },
      { name: 'Pi', tone: 'ok', state: 'Signed in on PiIts own sign-in, found when Pi was checked', button: null },
      { name: 'Ubuntu', tone: 'ok', state: 'Signed in on Ubuntu', button: null },
      { name: 'Other', tone: 'none', state: 'Not read yet' + 'Press Check on Other\'s card on the Machines page', button: null },
    ])
    expect((r.container.querySelector('[data-machine="Pi"]') as HTMLElement).title).toBe('Pi was already signed in as this account, so the app uses that sign-in.')
    expect((r.container.querySelector('[data-testid="account-usage-machine-signin"]') as HTMLElement).title).toBe('Opens a session on Rocky and runs Claude Code\'s own sign-in there. The sign-in is kept on Rocky.')
    expect(r.container.textContent).not.toMatch(/lent|lend/i)
    r.unmount()
  })

  it('Sign in on <machine> asks for that machine', () => {
    const onSignIn = vi.fn()
    const r = render(<AccountCard row={row()} theme="dark" onSignIn={vi.fn()} machines={machines(onSignIn)} />)
    act(() => { (r.container.querySelector('[data-testid="account-usage-machine-signin"]') as HTMLElement).click() })
    expect(onSignIn).toHaveBeenCalledWith(ROCKY)
    r.unmount()
  })

  it('a card that asks to sign in again here says so on this computer\'s line', () => {
    const r = render(<AccountCard row={row({ status: 'needs-login' })} theme="dark" onSignIn={vi.fn()} machines={machines()} />)
    expect(r.container.querySelector('[data-testid="account-usage-signin-reason"]')).not.toBeNull()
    expect(lines(r.container)[0]).toEqual({ name: 'This computer', tone: 'none', state: 'Sign in again', button: null })
    expect(lines(r.container)[1]).toMatchObject({ name: 'Rocky', button: 'Sign in on Rocky' })
    r.unmount()
  })

  it('no machine added: no block; a parked card: no block either', () => {
    const none = render(<AccountCard row={row()} theme="dark" onSignIn={vi.fn()} />)
    expect(none.container.querySelector('[data-testid="account-usage-machines"]')).toBeNull()
    none.unmount()
    const parked = render(<AccountCard row={row({ status: 'inactive', active: false })} theme="dark" onSignIn={vi.fn()} machines={machines()} />)
    expect(parked.container.querySelector('[data-testid="account-usage-machines"]')).toBeNull()
    parked.unmount()
  })

  it('the foot\'s machines line says where a sign-in is kept, and never says lent', () => {
    expect(MACHINES_FOOT_LINE).toBe('Accounts you add in Settings › Accounts are on every machine. Signed in on a machine: the sign-in is kept on that machine.')
    expect(MACHINES_FOOT_LINE).not.toMatch(/lent|lend/i)
  })
})
