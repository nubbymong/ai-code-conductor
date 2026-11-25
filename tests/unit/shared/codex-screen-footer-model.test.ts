// 2.1.3-beta.17 C8 (aicc_planning#416): the footer of Codex 0.157.1 names a
// model its own catalogue knows by the catalogue's display name, so a session
// on gpt-5.5 shows "GPT-5.5 medium . <folder>" while the app holds the model
// as "gpt-5.5". The renderer's Codex typing rule (Compact, the model pill,
// Plan mode, and the line an Alt+V image falls back to) reads the footer
// against the session's models, and read them in one case only, so it typed
// nothing ("Codex is not at its prompt, so nothing was sent."). Main's
// readers pass no model list (any model id), so they read that footer already.
//
// SCREEN is the test machine's, as beta.17's vm:C6 line recorded it on the
// published 2.1.3-beta.16 (the rows the app's own xterm showed, trailing
// spaces trimmed; its composer row's 20 placeholder cells dim, the record's
// count): Codex 0.157.1 on probe P11's stand-in model server, with no
// account, in a tab of 140 x 26, where Alt+V was refused 3 of 3. The stand-in
// answers no model list (helper/probes/p11-model-stand-in.cjs), so the
// display name is Codex's own. Rows the record does not print are blank.
// The screens with something typed are SCREEN with its composer row replaced.
//
// Not checked here:
//  - a display name that differs from its id by more than case and a space
//    for a hyphen (the last describe holds the release smoke's footer of
//    Codex 0.172.0 on GPT-6.1 Terra);
//  - a signed-in Codex (the record ran on the stand-in);
//  - the screen corpus (helper/fixtures/screens/): its recordings run on probe
//    P19's own model, which Codex shows as given, and the corpus reads them
//    with no model list, except Codex 0.172.0's on GPT-6.1 Terra, which
//    screen-corpus.test.ts case 6 reads with and without the model's id;
//  - each row's width, end and inverse cells (the record does not hold them).
import { describe, it, expect } from 'vitest'
import {
  readCodexScreen, codexComposerState, codexComposerDraft, codexComposerRows, codexCommandTyped,
  codexTextTyped, codexPastedContentShown, codexPlanModeOnScreen, type ScreenLine,
} from '../../../src/shared/codex-screen'
import {
  typeIntoCodexComposer, sendImagePathToCodex, typeWhenCodexComposerReady, codexPlanModeShown,
  StartupDoneRuns, CODEX_SUBMIT_DELAY_MS, CODEX_READY_POLL_MS, CODEX_IMAGE_LINE, type CodexComposerDeps,
} from '../../../src/renderer/lib/codexComposer'

const H = '\u2500'
const DOT = '\u00b7'
const GLYPH = '\u203a'
const FOLDER = '~\\p2w\\projects\\codex-lab'
const FOOTER = `  GPT-5.5 medium ${DOT} ${FOLDER}`

/** vm:C6's record of its ready screen (c-ready), by row number from 1. */
const RECORDED: Record<number, string> = {
  1: '\u256d' + H.repeat(63) + '\u256e',
  2: '\u2502 \u2728_\u200aUpdate available! 0.157.1 -> 0.171.0                       \u2502',
  3: '\u2502 See https://github.com/openai/codex for installation options. \u2502',
  4: '\u2502                                                               \u2502',
  5: '\u2502 See full release notes:                                       \u2502',
  6: '\u2502 https://github.com/openai/codex/releases/latest               \u2502',
  7: '\u2570' + H.repeat(63) + '\u256f',
  9: '\u256d' + H.repeat(46) + '\u256e',
  10: '\u2502 >_ OpenAI Codex (v0.157.1)                   \u2502',
  11: '\u2502                                              \u2502',
  12: '\u2502 model:     GPT-5.5 medium   /model to change \u2502',
  13: `\u2502 directory: ${FOLDER}          \u2502`,
  14: '\u2570' + H.repeat(46) + '\u256f',
  21: '                      Tip: When voice is available, use /voice to start or stop a voice conversation, or /voice settings to choose a voice.',
  23: `${GLYPH} Ask Codex to do anything`,
  25: FOOTER,
  26: '  ? for shortcuts',
}
const COMPOSER_ROW = 23
const plain = (text: string): ScreenLine => ({ text, typed: text })
const SCREEN: ScreenLine[] = Array.from({ length: 26 }, (_, k) => {
  const text = RECORDED[k + 1] ?? ''
  // The placeholder is drawn dim: only the glyph is typed.
  return k + 1 === COMPOSER_ROW ? { text, typed: GLYPH } : plain(text)
})

/** `base` (SCREEN by default) with `text` typed in its composer (not dim) and
 *  its footer as recorded under it; Codex draws no shortcuts hint under a
 *  typed text. */
const typedScreen = (text: string, base: ScreenLine[] = SCREEN): ScreenLine[] =>
  base.slice(0, 26 - 1).map((l, k) => (k + 1 === COMPOSER_ROW ? plain(`${GLYPH} ${text}`) : l))
/** SCREEN with its footer row replaced. */
const withFooter = (row: string): ScreenLine[] => SCREEN.map((l) => (l.text === FOOTER ? plain(row) : l))

/** The session's models as the app holds them (lower case), alone and in a
 *  registry-like list. */
const OWN = ['gpt-5.5']
const LISTED = ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.5', 'gpt-5.2']

describe('the footer names the session\'s model in capitals (Codex 0.157.1)', () => {
  it('the recorded screen reads ready and empty with the session\'s lower-case model', () => {
    expect(SCREEN.filter((l) => l.text !== '')).toHaveLength(17)
    for (const models of [OWN, LISTED]) {
      expect(readCodexScreen(SCREEN, models), models.join()).toEqual({ screen: 'ready', text: '' })
      expect(codexComposerState(SCREEN, models), models.join()).toBe('ready')
    }
    // Main's readers (no model list) read it as before.
    expect(readCodexScreen(SCREEN, null)).toEqual({ screen: 'ready', text: '' })
  })

  it('every reader of the footer reads it with the session\'s model', () => {
    expect(codexComposerDraft(SCREEN, OWN)).toBe('')
    expect(codexComposerRows(SCREEN, OWN)).toBe(1)
    expect(codexPlanModeOnScreen(SCREEN, OWN)).toBe(false)
    expect(codexCommandTyped(typedScreen('/compact'), '/compact', OWN)).toBe(true)
    expect(codexTextTyped(typedScreen('half a question'), 'half a question', OWN)).toBe(true)
    expect(codexComposerDraft(typedScreen('half a question'), OWN)).toBe('halfaquestion')
    expect(codexPastedContentShown(typedScreen('[Pasted Content 1843 chars]'), 1843, OWN)).toBe(true)
  })

  it('a footer naming another model, in any case, still reads nothing', () => {
    for (const row of [`  GPT-6-ASTRA medium ${DOT} ${FOLDER}`, `  gpt-6-astra medium ${DOT} ${FOLDER}`, `  GPT-5x5 medium ${DOT} ${FOLDER}`]) {
      expect(codexComposerState(withFooter(row), OWN), row).toBe('not-ready')
      expect(codexComposerDraft(withFooter(row), OWN), row).toBeNull()
    }
  })

  it("Codex's own hint lines under the composer still never read as the footer", () => {
    for (const row of [`  enter select ${DOT} esc back`, `  MCP servers ${DOT} 2 enabled`, `  Git ${DOT} main`,
      // The warning count's text in vm:C7's hold recordings (Codex 0.157.1).
      `  \u26a0 1 warning ${DOT} f2 to view`]) {
      for (const models of [OWN, null]) expect(codexComposerState(withFooter(row), models), `${row} ${String(models)}`).toBe('not-ready')
    }
  })

  it('only the model is read in either case: a level is read as Codex draws it, in lower case', () => {
    const row = `  GPT-5.5 Medium ${DOT} ${FOLDER}`
    for (const models of [OWN, null]) expect(codexComposerState(withFooter(row), models), String(models)).toBe('not-ready')
  })
})

/** The renderer's Codex rule over `base` (SCREEN by default), with the
 *  session's models as the app holds them: what it writes, the screen Codex
 *  then shows, and a clock. */
function harness(base: ScreenLine[] = SCREEN, models: readonly string[] = LISTED) {
  const writes: string[] = []
  let timers: Array<{ fn: () => void; at: number; id: number }> = []
  let now = 0
  let nextId = 1
  const state = { screen: base }
  const deps: CodexComposerDeps = {
    readScreen: () => state.screen,
    readTitle: () => 'codex-lab',
    currentRun: () => ({ createdAt: 1000, spawnToken: 7 }),
    write: (_id, d) => { writes.push(d); if (d !== '\r') state.screen = typedScreen(d, base) },
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ fn, at: now + ms, id }); return id },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id) },
    footerModels: () => models,
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
  return { writes, deps, advance }
}

describe("the renderer's callers of the session's models type into it", () => {
  it('Compact and the model pill: the command, then its Enter', () => {
    for (const command of ['/compact', '/model']) {
      const h = harness()
      const typing = typeIntoCodexComposer('s1', command, h.deps)
      expect(typing, command).toMatchObject({ typed: true })
      expect(typing.reason, command).toBeUndefined()
      h.advance(CODEX_SUBMIT_DELAY_MS)
      expect(h.writes, command).toEqual([command, '\r'])
    }
  })

  it('an Alt+V image the main process did not take: its line typed and sent, no note', () => {
    const h = harness()
    const notes: string[] = []
    const path = 'C:\\shots\\paste-1.png'
    sendImagePathToCodex('s1', path, (n) => notes.push(n), h.deps)
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(notes).toEqual([])
    expect(h.writes).toEqual([`${CODEX_IMAGE_LINE} ${path}`, '\r'])
  })

  it('Plan mode: the launch types /plan at the first ready screen, and the pill reads the footer', () => {
    const h = harness()
    const gaveUp: string[] = []
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 10 * CODEX_READY_POLL_MS, onGiveUp: (why) => gaveUp.push(why) }, h.deps)
    expect(codexPlanModeShown('s1', h.deps)).toBe(false)
    h.advance(CODEX_SUBMIT_DELAY_MS + CODEX_READY_POLL_MS)
    expect(gaveUp).toEqual([])
    expect(h.writes).toEqual(['/plan', '\r'])
  })
})

// The beta.17 release smoke (SM2), on the test machine: Codex 0.172.0, with
// GPT-6.1 Terra picked in Codex's own model picker, drew its footer as
// "GPT-6.1 Terra low . ~\p2w\projects\codex-lab": the display name holds a
// space where the id (gpt-6.1-terra, resources/codex-model-catalogue.json)
// has a hyphen. Codex was at rest with an empty prompt, and the app typed
// nothing: Compact and the model pill said "Codex is not at its prompt, so
// nothing was sent." (the renderer's rule, which reads the session's models),
// and a prompt button gave busy-timeout (main's readers, which read any model
// id, and an id held no space). TERRA is vm:C6's screen with that footer row,
// drawn with the two leading spaces Codex 0.157.1 draws (the smoke's note
// gives the row trimmed). The smoke did not record the other rows of the
// 0.172.0 screen. 2.1.3-beta.18 section 7.4 (aicc_planning#427) recorded it
// with probe P19's recorder into the screen corpus (the codex172 recordings,
// read by screen-corpus.test.ts case 6): Codex 0.172.0 draws the footer with
// the same two leading spaces, "GPT-6.1 Terra low", then the folder.
const TERRA_FOOTER = `  GPT-6.1 Terra low ${DOT} ${FOLDER}`
const TERRA = withFooter(TERRA_FOOTER)
/** The registry's Codex list, as sessionFooterModels hands it (ids). */
const WITH_TERRA = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-5.5']

describe('a display name with a space where the id has a hyphen (Codex 0.172.0, GPT-6.1 Terra)', () => {
  it('reads ready and empty with the session\'s models, and with no list (main\'s readers)', () => {
    for (const models of [WITH_TERRA, ['gpt-6.1-terra'], null]) {
      expect(readCodexScreen(TERRA, models), String(models)).toEqual({ screen: 'ready', text: '' })
      expect(codexComposerState(TERRA, models), String(models)).toBe('ready')
    }
    expect(codexCommandTyped(typedScreen('/compact', TERRA), '/compact', WITH_TERRA)).toBe(true)
    expect(codexTextTyped(typedScreen('half a question', TERRA), 'half a question', null)).toBe(true)
  })

  it('a list without that model still reads the footer as another model\'s', () => {
    expect(codexComposerState(TERRA, OWN)).toBe('not-ready')
    expect(codexComposerState(TERRA, ['gpt-6.1-sol', 'gpt-6-astra'])).toBe('not-ready')
  })

  it('a hyphen of a listed id matches a hyphen or a space, nothing else', () => {
    for (const row of [`  GPT-6.1-Terra low ${DOT} ${FOLDER}`, `  gpt-6.1-terra low ${DOT} ${FOLDER}`, `  GPT 6.1 Terra low ${DOT} ${FOLDER}`]) {
      expect(codexComposerState(withFooter(row), ['gpt-6.1-terra']), row).toBe('ready')
    }
    for (const row of [`  GPT-6.1_Terra low ${DOT} ${FOLDER}`, `  GPT-6.1Terra low ${DOT} ${FOLDER}`, `  GPT-6.1  Terra low ${DOT} ${FOLDER}`]) {
      expect(codexComposerState(withFooter(row), ['gpt-6.1-terra']), row).toBe('not-ready')
    }
  })

  it('with no list, a model of three words, or two words with no level after them, is still not the footer', () => {
    for (const row of [`  GPT 6.1 Terra low ${DOT} ${FOLDER}`, `  GPT-6.1 Terra ${DOT} ${FOLDER}`, `  GPT-6.1 Terra Low ${DOT} ${FOLDER}`]) {
      expect(codexComposerState(withFooter(row), null), row).toBe('not-ready')
    }
  })

  it('Compact and the model pill type into it: the command, then its Enter', () => {
    for (const command of ['/compact', '/model']) {
      const h = harness(TERRA, WITH_TERRA)
      const typing = typeIntoCodexComposer('s1', command, h.deps)
      expect(typing, command).toMatchObject({ typed: true })
      expect(typing.reason, command).toBeUndefined()
      h.advance(CODEX_SUBMIT_DELAY_MS)
      expect(h.writes, command).toEqual([command, '\r'])
    }
  })
})
