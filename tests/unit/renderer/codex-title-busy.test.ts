// 2.1.3-beta.13 B2 (aicc_planning#370): the renderer's Codex commands read the
// terminal's window title with its screen. TerminalView keeps the last title
// its terminal's output set, for the run that set it (keepTerminalTitle),
// beside its screen reader in the registry. While a reply streams Codex draws
// no busy row, only a braille spinner at the start of its title; the app's
// Codex commands then say it is busy and type nothing. Codex also spins the
// title for a moment as it starts (1 to 27 ms in the corpus, mostly before its
// footer is drawn), so a busy reading by the title alone never marks the run
// past its start-up, and the Plan mode wait waits through it.
//
// Not checked here:
//  - TerminalView's own hunk, which hands keepTerminalTitle's reader to the
//    registry (tests/unit/renderer/terminalview-hidden-output.test.tsx);
//  - main's readers (tests/unit/main/codex-title-busy.test.ts) and the rule
//    itself (tests/unit/shared/codex-screen-title.test.ts).
import { describe, it, expect, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { registerScreenReader, readSessionScreen, readSessionTitle, keepTerminalTitle } from '../../../src/renderer/components/terminal/screenRegistry'
import { markSpawned, clearSpawned } from '../../../src/renderer/ptyTracker'
import {
  typeIntoCodexComposer, typeWhenCodexComposerReady, codexComposerText, BUSY_NOW, CODEX_SUBMIT_DELAY_MS, CODEX_READY_POLL_MS,
  StartupDoneRuns, defaultCodexComposerDeps, type CodexComposerDeps, type ScreenLine,
} from '../../../src/renderer/lib/codexComposer'
import * as S from './codex-composer-screens'

const SPIN = `${String.fromCharCode(0x2839)} work`
const BACKSPACE = String.fromCharCode(0x7f)

describe('the registry holds a terminal\'s title reader beside its screen reader', () => {
  it('answers the registered title; a newer registration replaces it, whatever the older one\'s unregister does', () => {
    const offA = registerScreenReader('tb1', () => [], () => 'a')
    expect(readSessionTitle('tb1')).toBe('a')
    const offB = registerScreenReader('tb1', () => [{ text: 'b', typed: 'b' }])
    expect(readSessionTitle('tb1')).toBeNull()
    offA()
    expect(readSessionScreen('tb1')).toEqual([{ text: 'b', typed: 'b' }])
    offB()
    expect(readSessionScreen('tb1')).toBeNull()
  })

  it('no terminal, or a reader that throws: no title, and no throw', () => {
    expect(readSessionTitle('tb-none')).toBeNull()
    const off = registerScreenReader('tb2', () => [], () => { throw new Error('disposed') })
    expect(readSessionTitle('tb2')).toBeNull()
    off()
  })
})

describe('keepTerminalTitle: the last title, for the run that set it', () => {
  it('follows the terminal\'s output, and answers nothing once another spawn replaced the run or the run ended', async () => {
    const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true })
    const write = (data: string): Promise<void> => new Promise((done) => term.write(data, done))
    try {
      markSpawned('tb3')
      const read = keepTerminalTitle('tb3', term)
      expect(read()).toBeNull()
      await write(`\x1b]0;${SPIN}\x07`)
      expect(read()).toBe(SPIN)
      await write('\x1b]0;work\x07')
      expect(read()).toBe('work')
      markSpawned('tb3')
      expect(read()).toBeNull()
      await write(`\x1b]0;${SPIN}\x07`)
      expect(read()).toBe(SPIN)
      clearSpawned('tb3')
      expect(read()).toBeNull()
    } finally {
      term.dispose()
      clearSpawned('tb3')
    }
  })

  it('a terminal with no title events keeps none', () => {
    markSpawned('tb4')
    expect(keepTerminalTitle('tb4', {})()).toBeNull()
    clearSpawned('tb4')
  })
})

/** A fake run and screen for the typing helpers, with a window title. */
function harness(screen: ScreenLine[], title: string | null) {
  const writes: string[] = []
  let timers: Array<{ fn: () => void; at: number; id: number }> = []
  let now = 0
  let nextId = 1
  const state = { screen, title }
  const deps: CodexComposerDeps = {
    readScreen: () => state.screen,
    readTitle: () => state.title,
    currentRun: () => ({ createdAt: 1000, spawnToken: 7 }),
    write: (_id, d) => { writes.push(d); if (d !== '\r' && !/^\x7f+$/.test(d)) state.screen = typedInto(state.screen, d) },
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ fn, at: now + ms, id }); return id },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id) },
    pending: new Set<string>(),
    startupDone: new StartupDoneRuns(),
  }
  const advance = (ms: number): void => {
    const until = now + ms
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers = timers.filter((t) => t !== due)
      now = due.at
      due.fn()
    }
    now = until
  }
  return { writes, deps, state, advance }
}

/** The screen after `text` is typed into the composer (its popup, no footer). */
function typedInto(screen: ScreenLine[], text: string): ScreenLine[] {
  let i = -1
  screen.forEach((l, k) => { if (/^[›»] /.test(l.text)) i = k })
  const line = `› ${codexComposerText(screen)}${text}`
  return [...screen.slice(0, i), { text: line, typed: line }, { text: '', typed: '' }, { text: `  ${text}  a command`, typed: `  ${text}  a command` }]
}

describe('a Codex command while the title spins', () => {
  it('says Codex is busy and types nothing; the title alone does not mark the run past its start-up', () => {
    const h = harness(S.READY, SPIN)
    const r = typeIntoCodexComposer('s1', '/compact', h.deps)
    expect({ typed: r.typed, reason: r.reason }).toEqual({ typed: false, reason: BUSY_NOW })
    h.advance(CODEX_SUBMIT_DELAY_MS * 3)
    expect(h.writes).toEqual([])
    expect(h.deps.startupDone?.size).toBe(0)
    h.state.title = 'work'
    expect(typeIntoCodexComposer('s1', '/compact', h.deps).typed).toBe(true)
  })

  it('the app\'s own deps read the registered title: busy, nothing typed', () => {
    const off = registerScreenReader('tb5', () => S.READY, () => SPIN)
    const writes: string[] = []
    try {
      const r = typeIntoCodexComposer('tb5', '/compact', {
        ...defaultCodexComposerDeps,
        currentRun: () => ({ createdAt: 1, spawnToken: 1 }),
        write: (_id, d) => { writes.push(d) },
        footerModels: () => null,
        pending: new Set<string>(),
        startupDone: new StartupDoneRuns(),
      })
      expect(r.reason).toBe(BUSY_NOW)
      expect(writes).toEqual([])
    } finally {
      off()
    }
  })

  it('a busy row as well: busy, and the run is past its start-up', () => {
    const h = harness(S.WORKING_NOW, SPIN)
    expect(typeIntoCodexComposer('s1', '/compact', h.deps).reason).toBe(BUSY_NOW)
    expect(h.deps.startupDone?.size).toBe(1)
  })

  it('the title starts spinning before the Enter: the Enter is withheld and what was typed is erased', () => {
    const h = harness(S.READY, 'work')
    const settled = vi.fn()
    expect(typeIntoCodexComposer('s1', '/compact', h.deps, { onSettled: settled }).typed).toBe(true)
    h.state.title = SPIN
    h.advance(CODEX_SUBMIT_DELAY_MS + CODEX_READY_POLL_MS)
    expect(h.writes).toEqual(['/compact', BACKSPACE.repeat('/compact'.length)])
    expect(settled).toHaveBeenCalledWith(false, { reason: 'unreadable', erased: true })
  })
})

describe('the Plan mode wait and the title', () => {
  it('waits through a title that spins (Codex starting), types /plan once it stops, and never gives up over it', () => {
    const h = harness(S.READY, SPIN)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 10_000, onGiveUp }, h.deps)
    h.advance(CODEX_READY_POLL_MS * 4)
    expect(h.writes).toEqual([])
    h.state.title = 'work'
    h.advance(CODEX_READY_POLL_MS)
    expect(h.writes).toEqual(['/plan'])
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(h.writes).toEqual(['/plan', '\r'])
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  it('a busy row still ends it: a turn ran first', () => {
    const h = harness(S.WORKING_NOW, SPIN)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 10_000, onGiveUp }, h.deps)
    h.advance(CODEX_READY_POLL_MS)
    expect(onGiveUp).toHaveBeenCalledWith('interrupted')
    expect(h.writes).toEqual([])
  })
})
