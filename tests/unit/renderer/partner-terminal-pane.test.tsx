// @vitest-environment jsdom
/**
 * #86: the partner terminal of an SSH session opened a shell on THIS PC, and
 * its strip did not say which machine. A user on an SSH tab took it for the
 * host and ran the host's commands here.
 *
 * Now the partner runs where the session runs, and the strip names it:
 *   - a local session's partner: a plain shell on this PC, in the session's
 *     folder, with no ssh block ("a plain shell on this PC");
 *   - an SSH session's partner: a plain shell on the session's own host, its
 *     ssh block the session's own as a plain connection (no post-connect
 *     command, no container runtime, persistence off); main takes it to the
 *     config's remote folder there ("a plain shell on user@host").
 * And main recognises exactly what the pane sends as the session's partner
 * (the same rule, renderer side): isPartnerSshOf(what the session's own pane
 * sends, what the partner pane sends) holds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const views = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }))
vi.mock('../../../src/renderer/components/TerminalView', () => ({
  default: (p: Record<string, unknown>) => { views.props.push(p); return null },
}))

const { default: PartnerTerminalPane } = await import('../../../src/renderer/components/PartnerTerminalPane')
const { isPartnerSshOf } = await import('../../../src/shared/multi-spawn-rule')

const SSH = {
  host: 'build-box', port: 2222, username: 'nick', remotePath: '~/proj',
  postCommand: 'sudo docker exec -it app bash', runtime: { type: 'container' as const, container: 'app' },
  dockerContainer: 'app', detachable: true, hasPassword: true, remoteOs: 'unix' as const,
}
const local = { configId: 'cfg-local', createdAt: 7, sessionType: 'local' as const, workingDirectory: 'C:\\work\\app' }
const ssh = { configId: 'cfg-ssh', createdAt: 9, sessionType: 'ssh' as const, workingDirectory: '~/proj', sshConfig: SSH }

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  views.props.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(session: Record<string, unknown>, onBack = vi.fn()) {
  act(() => {
    root.render(<PartnerTerminalPane session={session as never} ptyId="s1-partner" agentName="Claude" isActive onBack={onBack} />)
  })
  const note = container.querySelector('[data-testid="partner-strip-note"]')?.textContent ?? ''
  return { note, view: views.props[views.props.length - 1], onBack }
}

describe('the partner of a local session', () => {
  it('is a plain shell on this PC, in the session\'s folder, and the strip says so', () => {
    const { note, view } = render(local)
    expect(note).toBe('Partner terminal: a plain shell on this PC, not Claude')
    expect(view).toMatchObject({ sessionId: 's1-partner', configId: 'cfg-local', cwd: 'C:\\work\\app', shellOnly: true, isActive: true })
    expect(view.ssh).toBeUndefined()
  })
})

describe('the partner of an SSH session (#86)', () => {
  it('connects to the session\'s own host as a plain connection, and the strip names user@host', () => {
    const { note, view } = render(ssh)
    expect(note).toBe('Partner terminal: a plain shell on nick@build-box, not Claude')
    expect(note).not.toContain('this PC')
    expect(view).toMatchObject({ sessionId: 's1-partner', configId: 'cfg-ssh', shellOnly: true })
    expect(view.cwd).toBeUndefined() // a remote folder this PC cannot resolve: main takes it there on the host
    expect(view.ssh).toEqual({ host: 'build-box', port: 2222, username: 'nick', remotePath: '~/proj', hasPassword: true, remoteOs: 'unix', detachable: false })
  })

  it('is what main recognises as the session\'s partner (the same rule, renderer side)', () => {
    const { view } = render(ssh)
    // What each pane's TerminalView sends: its ssh prop plus the reconnect flag
    // it adds from the tab's own history (a partner has none).
    const sessionSends = { ...SSH, reconnect: true }
    const partnerSends = { ...(view.ssh as object), reconnect: false }
    expect(isPartnerSshOf(sessionSends, partnerSends)).toBe(true)
  })

  it('an SSH tab with no ssh block gets what it always got: a shell on this PC, at home, and the strip says this PC', () => {
    const { note, view } = render({ ...ssh, sshConfig: undefined })
    expect(note).toBe('Partner terminal: a plain shell on this PC, not Claude')
    expect(view.ssh).toBeUndefined()
    expect(view.cwd).toBeUndefined()
  })

  it('the machine is shown as the user\'s text made safe: no control or bidi characters reach the strip', () => {
    const { note } = render({ ...ssh, sshConfig: { ...SSH, host: 'odd' + String.fromCharCode(0x202e) + 'xob', username: 'nick' + String.fromCharCode(27) + '[2J' } })
    expect(note).not.toMatch(new RegExp('[\\x00-\\x1f' + String.fromCharCode(0x202e) + ']'))
    expect(note).toContain('@odd')
  })
})

describe('the strip', () => {
  it('names the tab\'s own assistant and carries the way back', () => {
    const onBack = vi.fn()
    act(() => {
      root.render(<PartnerTerminalPane session={local as never} ptyId="s1-partner" agentName="Helper" isActive={false} onBack={onBack} />)
    })
    const strip = container.querySelector('[data-ux-id="partner-identity-strip"]')!
    expect(strip.textContent).toContain('not Helper')
    const back = strip.querySelector('button')!
    expect(back.textContent).toContain('Back to Helper')
    expect(back.getAttribute('title')).toBe('Back to the Helper terminal')
    act(() => { back.click() })
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(views.props[views.props.length - 1].isActive).toBe(false)
  })

  it('keeps the floating GitHub button\'s corner clear: the note wraps (anywhere, for a long user@host), the way back never shrinks', () => {
    render(ssh)
    const strip = container.querySelector('[data-ux-id="partner-identity-strip"]') as HTMLElement
    expect(strip.className.split(/\s+/).filter((c) => /^(px|pl|pr)-/.test(c))).toEqual(['pl-3', 'pr-12'])
    const note = container.querySelector('[data-testid="partner-strip-note"]') as HTMLElement
    expect(note.className.split(/\s+/)).toContain('min-w-0')
    expect(note.style.overflowWrap).toBe('anywhere')
    expect(strip.querySelector('button')!.className.split(/\s+/)).toEqual(expect.arrayContaining(['ml-auto', 'shrink-0', 'whitespace-nowrap']))
  })

  // The session record is replaced on every statusline tick; a new ssh block
  // each render would make the partner's terminal drop and take again its
  // subscriptions keyed on it.
  it('the ssh block it hands its terminal keeps its identity while the session\'s block is the same', () => {
    const first = render(ssh).view.ssh
    const again = render({ ...ssh, contextPercent: 41 }).view.ssh // a statusline tick: a new record, the same block
    expect(again).toBe(first)
    const moved = render({ ...ssh, sshConfig: { ...SSH, host: 'new-box' } }).view.ssh
    expect(moved).not.toBe(first)
    expect((moved as { host: string }).host).toBe('new-box')
  })
})
