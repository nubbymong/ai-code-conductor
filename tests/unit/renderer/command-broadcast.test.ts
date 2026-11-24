/**
 * #399 (2.1.3-beta.16, plan section B4): the rules a broadcast press keeps,
 * in src/renderer/lib/commandBroadcast.ts, on their own (no React, no store).
 *
 * The owner's answers (chat, 2026-11-23): every open agent tab, SSH and
 * background tabs included, never a terminal-only tab, Ask Conductor or an
 * ended session (Q2); each session's own prompt path decides and the pressed
 * tab shows one count (Q3); only a simple prompt can go to every session:
 * Global, no arguments, no remembered Ctrl+click arguments, no secret (Q4).
 * aicc_planning#413 (2.1.3-beta.17, plan section C2): every broadcast press
 * asks, All or the sessions picked; the chooser's list (broadcastChoices) and
 * the sessions its answer reaches at the press (liveBroadcastPick).
 * The CommandBar's own wiring is in commandbar-broadcast.test.tsx.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  broadcastTargets, isBroadcastTarget, broadcastBlocker, isBroadcastButton,
  tallyBroadcast, broadcastNote, broadcastPrompt, broadcastChoices, liveBroadcastPick,
  type BroadcastSession, type BroadcastChoiceSession,
} from '../../../src/renderer/lib/commandBroadcast'
import type { PromptButtonResult } from '../../../src/shared/types'

const agent = (id: string, over: Partial<BroadcastSession> = {}): BroadcastSession => ({ id, sessionType: 'local', ...over } as BroadcastSession)

describe('who a broadcast reaches (#399 Q2)', () => {
  const SESSIONS: BroadcastSession[] = [
    agent('local'),
    agent('ssh', { sessionType: 'ssh', sshConfig: { host: 'build-box', port: 22, username: 'u', remotePath: '/' } }),
    agent('background'),
    agent('shell', { shellOnly: true }),
    agent('ask', { kind: 'ask' }),
    agent('ended', { ptyExited: true }),
    agent('never', { neverStarted: true }),
  ]

  it('every open agent tab, local, SSH and in the background, in tab order', () => {
    expect(broadcastTargets(SESSIONS)).toEqual(['local', 'ssh', 'background'])
  })

  it.each([
    ['a terminal-only tab', 'shell'],
    ['Ask Conductor', 'ask'],
    ['a tab whose process ended', 'ended'],
    ['a tab whose last launch started nothing', 'never'],
  ])('never %s', (_name, id) => {
    expect(isBroadcastTarget(SESSIONS.find((s) => s.id === id)!)).toBe(false)
  })

  it('each session once, even when the list holds it twice', () => {
    expect(broadcastTargets([agent('a'), agent('b'), agent('a')])).toEqual(['a', 'b'])
  })
})

describe('which buttons can go to every session (#399 Q4: simple prompts only)', () => {
  const SIMPLE = { scope: 'global' as const, kind: 'prompt' as const, target: 'claude' as const }

  it('a Global prompt with no arguments can', () => {
    expect(broadcastBlocker(SIMPLE)).toBeNull()
  })

  it('an old Global record with no stored kind reads as a prompt, as the bar reads it', () => {
    expect(broadcastBlocker({ scope: 'global' })).toBeNull()
  })

  it.each([
    ['a shell line', { ...SIMPLE, kind: 'shell' as const, target: 'partner' as const }, 'Only a prompt can go to every open session.'],
    ['a page', { ...SIMPLE, kind: 'page' as const }, 'Only a prompt can go to every open session.'],
    ['an old record aimed at the partner shell', { scope: 'global' as const, target: 'partner' as const }, 'Only a prompt can go to every open session.'],
    ['an old record with a secret (a shell line)', { scope: 'global' as const, hasSecretArg: true }, 'Only a prompt can go to every open session.'],
    ['a Session button', { ...SIMPLE, scope: 'config' as const }, 'Only a Global button can go to every open session.'],
    ['a prompt with arguments', { ...SIMPLE, defaultArgs: ['--verbose'] }, 'Only a prompt with no arguments can go to every open session.'],
    ['a prompt with remembered Ctrl+click arguments', { ...SIMPLE, lastCustomArgs: ['--fast'] }, 'Only a prompt with no arguments can go to every open session.'],
    ['a prompt marked as carrying a secret', { ...SIMPLE, hasSecretArg: true }, 'Only a prompt with no arguments can go to every open session.'],
  ])('%s cannot, and the reason says why in one line', (_name, cmd, reason) => {
    expect(broadcastBlocker(cmd)).toBe(reason)
  })

  it('a plain press broadcasts only with the option on AND a simple prompt', () => {
    expect(isBroadcastButton({ ...SIMPLE, broadcast: true })).toBe(true)
    expect(isBroadcastButton(SIMPLE)).toBe(false)
    expect(isBroadcastButton({ ...SIMPLE, broadcast: true, defaultArgs: ['x'] })).toBe(false)
    expect(isBroadcastButton({ ...SIMPLE, broadcast: true, scope: 'config' })).toBe(false)
  })
})

describe('each session\'s own path decides, and one note counts it (#399 Q3)', () => {
  it('sends the same text to each session once, through main\'s prompt path, dropping its tmux belief first', async () => {
    const order: string[] = []
    const submit = vi.fn(async ({ sessionId }: { sessionId: string; text: string }) => { order.push(`send ${sessionId}`); return { outcome: 'sent' } as PromptButtonResult })
    const before = vi.fn((id: string) => { order.push(`before ${id}`) })
    const t = await broadcastPrompt('review the diff', ['a', 'b', 'a'], submit, before)
    expect(submit.mock.calls.map((c) => c[0])).toEqual([
      { sessionId: 'a', text: 'review the diff' },
      { sessionId: 'b', text: 'review the diff' },
    ])
    expect(order).toEqual(['before a', 'send a', 'before b', 'send b'])
    expect(t).toEqual({ total: 2, sent: 2, typed: 0, busyOrEnded: 0, refused: 0, repeats: 0 })
  })

  it('a bridge that rejects or throws for one session counts that session as gone and still reaches the rest', async () => {
    const submit = vi.fn(({ sessionId }: { sessionId: string; text: string }) => {
      if (sessionId === 'throws') throw new Error('no handler')
      if (sessionId === 'rejects') return Promise.reject(new Error('gone'))
      return Promise.resolve({ outcome: 'sent' } as PromptButtonResult)
    })
    const t = await broadcastPrompt('x', ['ok', 'throws', 'rejects'], submit)
    expect(submit).toHaveBeenCalledTimes(3)
    expect(t).toMatchObject({ total: 3, sent: 1, busyOrEnded: 2 })
  })

  it('counts every kind of answer', () => {
    const t = tallyBroadcast([
      { outcome: 'sent' },
      { outcome: 'typed' },
      { outcome: 'typed', reason: 'refused-text' },
      { outcome: 'dropped' },
      { outcome: 'not-sent', reason: 'busy-timeout' },
      { outcome: 'not-sent', reason: 'prompt-on-screen' },
      { outcome: 'not-sent', reason: 'session-gone' },
      { outcome: 'not-sent', reason: 'too-tall' },
      { outcome: 'not-sent', reason: 'refused-text' },
      undefined as unknown as PromptButtonResult,
    ])
    expect(t).toEqual({ total: 10, sent: 1, typed: 2, busyOrEnded: 4, refused: 2, repeats: 1 })
  })

  it.each([
    ['the owner\'s example', { total: 7, sent: 5, typed: 0, busyOrEnded: 2, refused: 0, repeats: 0 }, 'Sent to 5 of 7 sessions (2 busy or ended).'],
    ['all sent', { total: 3, sent: 3, typed: 0, busyOrEnded: 0, refused: 0, repeats: 0 }, 'Sent to 3 of 3 sessions.'],
    ['one session', { total: 1, sent: 1, typed: 0, busyOrEnded: 0, refused: 0, repeats: 0 }, 'Sent to 1 of 1 session.'],
    ['Type it only', { total: 2, sent: 0, typed: 2, busyOrEnded: 0, refused: 0, repeats: 0 }, 'Typed into 2 of 2 sessions.'],
    ['sent and typed', { total: 4, sent: 2, typed: 1, busyOrEnded: 0, refused: 1, repeats: 0 }, 'Sent to 2 and typed into 1 of 4 sessions (1 could not take it).'],
    ['a repeat among others', { total: 3, sent: 2, typed: 0, busyOrEnded: 0, refused: 0, repeats: 1 }, 'Sent to 2 of 3 sessions (1 already sent).'],
    ['no session open', { total: 0, sent: 0, typed: 0, busyOrEnded: 0, refused: 0, repeats: 0 }, 'No open agent session to send to.'],
  ])('the note: %s', (_name, t, words) => {
    expect(broadcastNote(t)).toBe(words)
  })

  it('a press every session dropped as a repeat says nothing, as a single press does', () => {
    expect(broadcastNote({ total: 2, sent: 0, typed: 0, busyOrEnded: 0, refused: 0, repeats: 2 })).toBeNull()
  })
})

describe('the chooser\'s list and the sessions its answer reaches (#413)', () => {
  const SSH = { host: 'build-box', port: 22, username: 'u', remotePath: '/' }
  const SESSIONS: BroadcastChoiceSession[] = [
    { ...agent('a'), label: 'alpha' },
    { ...agent('b', { sessionType: 'ssh', sshConfig: SSH }), label: 'beta' },
    { ...agent('c', { provider: 'codex' }), label: 'gamma-config', customName: '  gamma work  ' },
    { ...agent('shell', { shellOnly: true }), label: 'shell' },
    { ...agent('ask', { kind: 'ask' }), label: 'Ask' },
    { ...agent('ended', { ptyExited: true }), label: 'ended' },
  ]
  const ALL = ['a', 'b', 'c', 'shell', 'ask', 'ended']

  it('lists each listed agent tab in tab order: its name as the tab strip shows it, its agent, the host of an SSH tab', () => {
    expect(broadcastChoices(SESSIONS, ['c', 'b', 'a'])).toEqual([
      { id: 'a', name: 'alpha', agent: 'Claude Code', machine: null },
      { id: 'b', name: 'beta', agent: 'Claude Code', machine: 'build-box' },
      { id: 'c', name: 'gamma work', agent: 'Codex', machine: null },
    ])
  })

  it('never lists a terminal-only tab, Ask Conductor or an ended tab, even when asked to', () => {
    expect(broadcastChoices(SESSIONS, ALL).map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('drops a listed tab that has ended since, and adds no tab that was not listed', () => {
    const later = [...SESSIONS.map((s) => (s.id === 'b' ? { ...s, ptyExited: true } : s)), { ...agent('d'), label: 'delta' }]
    expect(broadcastChoices(later, ['a', 'b', 'c']).map((c) => c.id)).toEqual(['a', 'c'])
  })

  it('the answer reaches the picked tabs a broadcast still reaches at the press, in tab order, each once', () => {
    expect(liveBroadcastPick(SESSIONS, ['c', 'a', 'c'])).toEqual(['a', 'c'])
    expect(liveBroadcastPick(SESSIONS, ['shell', 'ask', 'ended', 'nobody'])).toEqual([])
    const later = SESSIONS.map((s) => (s.id === 'c' ? { ...s, ptyExited: true } : s))
    expect(liveBroadcastPick(later, ['a', 'c'])).toEqual(['a'])
  })
})
