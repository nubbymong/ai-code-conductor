// The screen corpus (plan 2.1.3-beta.11, section A2, aicc_planning #341; and
// plan 2.1.3-beta.12, section A2, aicc_planning #353).
//
// helper/fixtures/screens/ holds recordings of Claude Code's and Codex's real
// output, and of the system's default shell, on Windows (node-pty's bundled
// ConPTY and the one built into Windows), macOS and Linux, taken from probe
// P19's runs (ADR-030; helper/probes/p19-record.cjs). One recording per
// program, system and state: <program>-<system>-<state>.json, each from the
// session's first byte to the end of that state's own measurement by the
// probe (its same-size resize and its nudge, one row shorter and back). A
// state P19's second run records only (Codex's mid-reply of its short turn,
// and the hint rows) ends 300 ms after its mark, with no resize. The program
// is the CLI at one version: codex is Codex 0.157.1, codex170 is Codex
// 0.170.0 (VERSION below). Each recording names the CLI and its version, the
// system, the size, and holds the
// chunks as node-pty handed them over (on macOS and Linux a character split
// across two reads joins the second, as node-pty's own decoder does), with
// the resize marks, the state marks and the keys the probe typed, in order.
// Nothing in them was signed in: each CLI talked to the probe's stand-in model
// on the same machine.
//
// Beside each, <name>.rows.json: what @xterm/headless 6.0.0 shows when fed
// the recording's chunks through main's CSI clamp (clampAnsiChunk, the one the
// Watchdog's pane and the Codex pane use), at the Watchdog pane's settings
// (200 lines of scrollback): the screen as readXtermScreen returns it (text,
// typed, inverse, width, end per row) after each resize mark and after the
// last chunk, and the last 200 lines as text after the last chunk (the text
// half of the Watchdog's tail). At a resize mark the pane is resized, as the
// Watchdog's pane and the holder's screen are when the session is. The rows
// files are written by this test: run it with SCREEN_CORPUS_WRITE=1 to write
// them, and without it to compare. There is no other script.
//
// The cases:
//  1. the rows made now equal the committed rows, for every recording, so an
//     xterm.js bump that moves a row shows here first, and each rows file
//     names the @xterm/headless loaded now (a bump that moves no row still
//     fails here until the rows files are written again);
//  2. the reader of each recording's program reads the state in its name
//     (readClaudeScreen, readCodexScreen; for the shell both read no prompt);
//  3. the names come from the fixed sets, each recording has its rows file and
//     its program's version, each runs on from its first byte with no gap,
//     each known misread is a recording, each LEFT_OUT row names the fixed
//     sets, and the size caps hold (256 KiB a recording, 3 MiB for all of
//     them: a longer one needs a shorter scenario, never a cut);
//  4. no recording or rows file holds a path under a home folder other than
//     the generic ones (the test machine's own test user, GitHub's runner
//     accounts), an e-mail shape, or anything shaped like a key.
// A recording a reader misreads is a finding, not a fixture to bend: it is
// listed in KNOWN_MISREADS with its ticket and the wrong answer the reader
// gives, so a change in that answer fails case 2 too, and the reader is fixed.
//
// Not checked here:
//  - colours, bold and every attribute but dim and inverse;
//  - the cursor's shape, and where it is;
//  - timing between chunks (the `t` of each event is kept, never read);
//  - the dim-blanked copy of the tail (the Watchdog's send gate builds its own);
//  - answers to the CLI's terminal queries: the replay answers none (the
//    recording already holds what the CLI drew after the probe answered);
//  - a home path written with no drive letter and no root before it, and a
//    key of a shape not in KEY_SHAPES;
//  - the Codex pane's own settings (no scrollback, providers/codex/session-screen.ts):
//    the rows, and the readers' answers in case 2, are the Watchdog pane's (200 lines);
//  - a home path with an escape sequence inside it that is gone from the screen before a
//    snapshot (the chunks are matched as written, the rows only at the snapshots);
//  - the rows files' size (only the recordings have caps).
import { describe, it, expect, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { Terminal } from '@xterm/headless'
import { readXtermScreen, readCodexScreen, type ScreenLine } from '../../../src/shared/codex-screen'
import { readClaudeScreen } from '../../../src/shared/claude-screen'

// The clamp lives in the Watchdog's manager; these keep its imports inert.
vi.mock('../../../src/main/config-manager', () => ({ readConfig: vi.fn(() => ({})) }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/hooks/index', () => ({ getGateway: () => null }))
const { clampAnsiChunk } = await import('../../../src/main/watchdog/watchdog-manager')

const ROOT = resolve(__dirname, '../../..')
const DIR = resolve(ROOT, 'helper/fixtures/screens')
const WRITE = process.env.SCREEN_CORPUS_WRITE === '1'

/** The Watchdog pane's scrollback and tail (watchdog-manager.ts). */
const SCROLLBACK = 200
const TAIL_LINES = 200
const RECORDING_CAP = 256 * 1024
const CORPUS_CAP = 3 * 1024 * 1024
const XTERM_VERSION = (JSON.parse(readFileSync(resolve(ROOT, 'node_modules/@xterm/headless/package.json'), 'utf-8')) as { version: string }).version

// ── the fixed sets ──────────────────────────────────────────────────────────
const CLI_STATES = ['first-screen', 'ready', 'mid-reply', 'after-reply'] as const
/** Codex's hint rows (P19's second run, each from a launch of its own, record
 *  only): a draft typed while a turn runs (the queue hint), the shortcuts key
 *  rebound, the agents form of the hint row, and a warning drawn on it. */
const HINT_STATES = ['queue-hint', 'rebound-hint', 'agents-hint', 'warning-hint'] as const
const CODEX_STATES = [...CLI_STATES, ...HINT_STATES] as const
const STATES: Record<string, readonly string[]> = { claude: CLI_STATES, codex: CODEX_STATES, codex170: CODEX_STATES, shell: ['after-output'] }
const PROGRAMS = Object.keys(STATES)
const SYSTEMS = ['windows-bundled', 'windows-system', 'macos', 'linux'] as const
/** The ConPTY each system's recordings ran under (null: not Windows). */
const CONPTY: Record<string, string | null> = { 'windows-bundled': 'bundled', 'windows-system': 'system', macos: null, linux: null }
const CLI_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', codex170: 'Codex', shell: 'default shell' }
/** The version every recording of a program is of (null: the shell). */
const VERSION: Record<string, string | null> = { claude: '2.1.328', codex: '0.157.1', codex170: '0.170.0', shell: null }

/** What each reader must read for a state. "working" is the readers' busy.
 *  Claude Code's first screen with no account is its theme picker, drawn
 *  where the prompt box would be, so its reader reads no prompt (a picker
 *  takes the prompt's place: claude-screen.ts); Codex's is its sign-in
 *  choice, which its reader knows by "Press enter to continue". The queue
 *  hint shows while a turn runs, with a draft in the composer: busy. The
 *  other hint rows are on an empty ready composer. */
const CODEX_EXPECTED: Record<string, string> = {
  'first-screen': 'blocked', ready: 'ready', 'mid-reply': 'busy', 'after-reply': 'ready',
  'queue-hint': 'busy', 'rebound-hint': 'ready', 'agents-hint': 'ready', 'warning-hint': 'ready',
}
const EXPECTED: Record<string, Record<string, string>> = {
  claude: { 'first-screen': 'no-prompt', ready: 'ready', 'mid-reply': 'busy', 'after-reply': 'ready' },
  codex: CODEX_EXPECTED,
  codex170: CODEX_EXPECTED,
  shell: { 'after-output': 'no-prompt' },
}
/** The states whose prompt holds nothing when they are read. */
const EMPTY_PROMPT = ['ready', 'after-reply', 'rebound-hint', 'agents-hint', 'warning-hint']

/** What the corpus does not hold, and why: a program's state on the systems
 *  named. The fragments CONTEXT.d/2026-11-19-screen-corpus.md and
 *  CONTEXT.d/2026-11-20-probe-p19-second-run.md say what would bring them in.
 *  Where P19's second run recorded more than the 3 MiB cap holds, the plan's
 *  order of keeping (2.1.3-beta.12, A2) chose: Codex 0.170.0's ready,
 *  mid-reply and after-reply on every system; then each hint row reached, on
 *  one Windows system and one other; then Codex 0.157.1's mid-reply and
 *  after-reply on as many systems as fit. */
interface LeftOut { program: string; state: string; systems: readonly string[]; why: string }
const HINT_ELSEWHERE = 'kept on one Windows system (the bundled ConPTY, which the app gives Codex sessions) and one other (macOS) by the order of keeping; P19\'s second run recorded the same row here too'
const LEFT_OUT: LeftOut[] = [
  { program: 'codex', state: 'agents-hint', systems: SYSTEMS, why: 'not reached: Codex 0.157.1 does not draw the agents form of the hint row (P19\'s second run waited 60 s on every system; the screen showed the ready composer with "? for shortcuts")' },
  { program: 'codex', state: 'after-reply', systems: ['linux'], why: 'over the 3 MiB corpus cap: last in the order of keeping (243,915 bytes; 173,132 were left)' },
  { program: 'codex170', state: 'first-screen', systems: SYSTEMS, why: 'not in the plan\'s order of keeping, so not added (P19\'s second run recorded it: the sign-in choice, as Codex 0.157.1\'s; the four are 56,262 bytes, and 173,132 bytes of the 3 MiB cap were left)' },
  ...['queue-hint', 'rebound-hint', 'warning-hint'].map((state) => ({ program: 'codex', state, systems: ['windows-system', 'linux'], why: HINT_ELSEWHERE })),
  ...HINT_STATES.map((state) => ({ program: 'codex170', state, systems: ['windows-system', 'linux'], why: HINT_ELSEWHERE })),
]
const leftOutFor = (n: { program: string; system: string; state: string }, rows: readonly LeftOut[] = LEFT_OUT): LeftOut | undefined =>
  rows.find((l) => l.program === n.program && l.state === n.state && l.systems.includes(n.system))
/** The LEFT_OUT rows that name a program, a state or a system outside the fixed sets. */
const strayLeftOut = (rows: readonly LeftOut[]): string[] =>
  rows.filter((l) => !STATES[l.program]?.includes(l.state) || l.systems.length === 0 || l.systems.some((s) => !(SYSTEMS as readonly string[]).includes(s))).map((l) => `${l.program} ${l.state} on ${l.systems.join(', ')}`)

/** A recording a reader misreads: its name, the ticket that fixes the
 *  reader, and the answer the reader gives on it now. Each stays listed until
 *  its reader is fixed; the test then fails until the line is removed, and
 *  fails too if the reader starts to give another wrong answer.
 *  The four codex-*-ready recordings of Codex 0.157.1 were listed until
 *  Codex's reader learned the "? for shortcuts" row drawn under the footer
 *  at its ready composer (aicc_planning#349, in 2.1.3-beta.10). The 33
 *  recordings P19's second run added all read unrecognised until the reader
 *  learned each other row recorded there (aicc_planning#357, in
 *  2.1.3-beta.12, tests/unit/shared/codex-screen-hint-rows.test.ts); these
 *  are left:
 *  - where the thread title and the working folder do not fit in 120 columns,
 *    Codex 0.170.0's footer wraps onto a second row (its macOS and Windows
 *    screens after the prompt is sent; their temporary folders are longer than
 *    Linux's), and a wrapped footer still reads unrecognised, whatever row is
 *    under it;
 *  - no mid-reply screen holds an "esc to interrupt" row, the reader's only
 *    sign of busy: Codex drew its working row once, after Enter, and not while
 *    the reply streamed. Each ends in the same rows as its after-reply screen,
 *    so it reads ready. */
interface Misread { ticket: string; reads: string }
const WRAPPED_FOOTER: Misread = { ticket: 'aicc_planning#357', reads: 'unrecognised' }
const STREAMING: Misread = { ticket: 'aicc_planning#357', reads: 'ready' }
const KNOWN_MISREADS: Record<string, Misread> = Object.fromEntries([
  // Codex 0.170.0 after a prompt on macOS and Windows: the footer wraps.
  ...[
    'codex170-windows-bundled-mid-reply', 'codex170-windows-system-mid-reply', 'codex170-macos-mid-reply',
    'codex170-windows-bundled-after-reply', 'codex170-windows-system-after-reply', 'codex170-macos-after-reply',
    'codex170-windows-bundled-queue-hint', 'codex170-macos-queue-hint',
  ].map((name) => [name, WRAPPED_FOOTER]),
  // A reply streaming, with a footer of one row: nothing on screen says busy.
  ...[
    'codex170-linux-mid-reply',
    'codex-windows-bundled-mid-reply', 'codex-windows-system-mid-reply', 'codex-macos-mid-reply', 'codex-linux-mid-reply',
  ].map((name) => [name, STREAMING]),
])

const NAMES = PROGRAMS.flatMap((p) => SYSTEMS.flatMap((s) => STATES[p].map((st) => ({ name: `${p}-${s}-${st}`, program: p, system: s, state: st }))))
const NAME_BY = new Map(NAMES.map((n) => [n.name, n]))

// ── the files ───────────────────────────────────────────────────────────────
interface ChunkEvent { o: number; t: number; text: string }
interface OtherEvent { o: number; t: number; ev: 'resize' | 'mark' | 'keys'; cols?: number; rows?: number; state?: string; keys?: string }
type RecEvent = ChunkEvent | OtherEvent
interface Recording {
  program: string; cli: string; version: string | null; system: string; os: string; machine: string; conpty: string | null
  state: string; cols: number; rows: number; source: string; events: RecEvent[]
}
interface Screen { after: 'resize' | 'last chunk'; event: number; cols: number; rows: number; buffer: string; lines: ScreenLine[] }
interface Made { screens: Screen[]; tail: string[] }

const listDir = (): string[] => (existsSync(DIR) ? readdirSync(DIR).sort() : [])
const RECORDINGS = listDir().filter((f) => f.endsWith('.json') && !f.endsWith('.rows.json')).map((f) => f.slice(0, -'.json'.length))
/** A file's size as the repository holds it (a Windows checkout may write CRLF). */
const sizeOf = (f: string): number => Buffer.byteLength(readFileSync(resolve(DIR, f), 'utf-8').replace(/\r\n/g, '\n'))
const readRecording = (name: string): Recording => JSON.parse(readFileSync(resolve(DIR, `${name}.json`), 'utf-8')) as Recording
const isChunk = (e: RecEvent): e is ChunkEvent => typeof (e as ChunkEvent).text === 'string'

// ── the replay ──────────────────────────────────────────────────────────────
function screenOf(term: Terminal, after: Screen['after'], event: number): Screen {
  return { after, event, cols: term.cols, rows: term.rows, buffer: term.buffer.active.type, lines: readXtermScreen(term) }
}

/** The last TAIL_LINES lines, scrollback and screen, as text, trailing blank
 *  lines dropped: the text half of the Watchdog's tail (readPanePair). */
function tailOf(term: Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = Math.max(0, buf.length - TAIL_LINES); i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

/** Feeds a recording to a pane as main feeds the Watchdog's: each chunk
 *  through the clamp, the pane resized at each resize mark. */
async function replay(rec: Recording): Promise<Made> {
  const term = new Terminal({ cols: rec.cols, rows: rec.rows, scrollback: SCROLLBACK, allowProposedApi: true })
  const clamp = { residual: '' }
  const flush = (): Promise<void> => new Promise((done) => term.write('', done))
  const screens: Screen[] = []
  try {
    for (const [i, e] of rec.events.entries()) {
      if (isChunk(e)) {
        term.write(clampAnsiChunk(e.text, clamp))
      } else if (e.ev === 'resize') {
        await flush()
        term.resize(e.cols as number, e.rows as number)
        screens.push(screenOf(term, 'resize', i))
      }
    }
    await flush()
    screens.push(screenOf(term, 'last chunk', rec.events.length - 1))
    return { screens, tail: tailOf(term) }
  } finally {
    term.dispose()
  }
}

const made = new Map<string, Promise<Made>>()
const rowsOf = (name: string): Promise<Made> => {
  if (!made.has(name)) made.set(name, replay(readRecording(name)))
  return made.get(name) as Promise<Made>
}

/** A rows file, one row or line of text a line, so a diff shows the row. */
function rowsFileText(name: string, m: Made): string {
  const j = JSON.stringify
  const out = ['{']
  out.push(`  "_doc": ${j('The rows @xterm/headless gives for the recording beside it, fed through main\'s CSI clamp at the Watchdog pane\'s settings. Written by tests/unit/shared/screen-corpus.test.ts with SCREEN_CORPUS_WRITE=1, and compared by it otherwise.')},`)
  out.push(`  "recording": ${j(`${name}.json`)},`)
  out.push(`  "xterm": ${j(XTERM_VERSION)},`)
  out.push(`  "scrollback": ${SCROLLBACK},`)
  out.push(`  "tailLines": ${TAIL_LINES},`)
  out.push('  "screens": [')
  m.screens.forEach((s, i) => {
    const { lines, ...head } = s
    out.push(`    {${Object.entries(head).map(([k, v]) => `${j(k)}: ${j(v)}`).join(', ')}, "lines": [`)
    lines.forEach((l, k) => out.push(`      ${j(l)}${k < lines.length - 1 ? ',' : ''}`))
    out.push(`    ]}${i < m.screens.length - 1 ? ',' : ''}`)
  })
  out.push('  ],')
  out.push('  "tail": [')
  m.tail.forEach((l, k) => out.push(`    ${j(l)}${k < m.tail.length - 1 ? ',' : ''}`))
  out.push('  ]')
  out.push('}')
  return `${out.join('\n')}\n`
}

/** A committed rows file: the rows, and the @xterm/headless that made them. */
interface RowsFile extends Made { xterm: unknown }
const readRows = (name: string): RowsFile => {
  const r = JSON.parse(readFileSync(resolve(DIR, `${name}.rows.json`), 'utf-8')) as RowsFile
  return { xterm: r.xterm, screens: r.screens, tail: r.tail }
}

// ── the checks, as functions, so the planted cases below run the same code ──
/** Where two sets of rows differ: "screen 2 row 7" and the like. */
function rowDifferences(want: Made, got: Made): string[] {
  const out: string[] = []
  if (want.screens.length !== got.screens.length) out.push(`${got.screens.length} screens, ${want.screens.length} committed`)
  for (let i = 0; i < Math.min(want.screens.length, got.screens.length); i++) {
    const a = want.screens[i]
    const b = got.screens[i]
    const { lines: al, ...ah } = a
    const { lines: bl, ...bh } = b
    if (JSON.stringify(ah) !== JSON.stringify(bh)) out.push(`screen ${i}: ${JSON.stringify(bh)}, committed ${JSON.stringify(ah)}`)
    for (let r = 0; r < Math.max(al.length, bl.length); r++) {
      if (JSON.stringify(al[r]) !== JSON.stringify(bl[r])) out.push(`screen ${i} (${a.after}, event ${a.event}) row ${r}: ${JSON.stringify(bl[r])}, committed ${JSON.stringify(al[r])}`)
    }
  }
  if (JSON.stringify(want.tail) !== JSON.stringify(got.tail)) out.push(`the tail differs (${got.tail.length} lines, ${want.tail.length} committed)`)
  return out
}

/** Whether a rows file names the @xterm/headless loaded now, so its "xterm"
 *  field cannot go stale after a bump that moves no row. */
function xtermProblem(name: string, committed: unknown, loaded: string = XTERM_VERSION): string | null {
  return committed === loaded ? null : `${name}.rows.json was made by @xterm/headless ${JSON.stringify(committed)}, ${loaded} is loaded: rewrite it with SCREEN_CORPUS_WRITE=1`
}

/** What the program's reader reads on a screen; for the shell, both readers. */
function readerAnswer(program: string, lines: ScreenLine[]): { screen: string; text: string } {
  if (program === 'claude') return readClaudeScreen(lines)
  if (program === 'codex' || program === 'codex170') return readCodexScreen(lines)
  const claude = readClaudeScreen(lines)
  const codex = readCodexScreen(lines)
  return claude.screen === codex.screen ? claude : { screen: `${claude.screen} (Claude Code's reader), ${codex.screen} (Codex's)`, text: '' }
}

/** Whether the reader's answer is the state in the recording's name. */
function readsAsNamed(name: string, lines: ScreenLine[]): string | null {
  const n = NAME_BY.get(name)
  if (!n) return `${name} is not a corpus name`
  const want = EXPECTED[n.program][n.state]
  const got = readerAnswer(n.program, lines)
  if (got.screen !== want) return `${name}: read ${got.screen}, its name says ${n.state} (${want})`
  if (EMPTY_PROMPT.includes(n.state) && got.text !== '') return `${name}: the prompt holds ${JSON.stringify(got.text)}, not nothing`
  return null
}

/** Case 2's verdict on readsAsNamed's answer: null when the recording reads
 *  the state in its name, or, for a known misread, when it gives exactly the
 *  wrong answer listed for it. */
function misreadProblem(name: string, problem: string | null, misreads: Record<string, Misread> = KNOWN_MISREADS): string | null {
  const known = misreads[name]
  if (!known) return problem
  if (problem === null) return `${name} is listed as a known misread (${known.ticket}) but reads right: remove it from KNOWN_MISREADS`
  if (!problem.includes(`: read ${known.reads},`)) return `${name} is listed as a known misread (${known.ticket}) that reads ${known.reads}, but now: ${problem}`
  return null
}

/** The KNOWN_MISREADS names that are no recording (renamed or removed). */
const unlistedMisreads = (misreads: Record<string, Misread>, recordings: readonly string[]): string[] =>
  Object.keys(misreads).filter((n) => !recordings.includes(n))

/** The home folders a recording may name: the test machine's test user and
 *  GitHub's runner accounts. */
const GENERIC_HOMES = ['user', 'runneradmin', 'runner']
/** A home folder: C:\Users\<name> (either slash), /Users/<name>, /home/<name>. */
const HOME_RE = /(?:\b[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)([^\\/\s"'<>|:*?\x00-\x1f]+)/gi
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
/** Shapes of keys and tokens: the providers' API keys, GitHub's tokens, an AWS
 *  key id, Slack's tokens, a private key block, a JSON web token. */
const KEY_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/,
]

/** Every string a parsed file holds, keys and values. */
function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); stringsOf(x, out) }
  return out
}

/** What in these texts is personal or secret. */
function privateFinds(texts: string[]): string[] {
  const out: string[] = []
  for (const t of texts) {
    for (const m of t.matchAll(HOME_RE)) if (!GENERIC_HOMES.includes(m[1].toLowerCase())) out.push(`a home folder: ${JSON.stringify(m[0])}`)
    for (const m of t.matchAll(EMAIL_RE)) out.push(`an e-mail shape: ${JSON.stringify(m[0])}`)
    for (const re of KEY_SHAPES) { const m = re.exec(t); if (m) out.push(`a key shape: ${JSON.stringify(m[0].slice(0, 12))}...`) }
  }
  return out
}

/** What a recording's structure gets wrong for its name. */
function structureProblems(name: string, rec: Recording): string[] {
  const n = NAME_BY.get(name)
  if (!n) return [`${name} is not <program>-<system>-<state> from the fixed sets`]
  const out: string[] = []
  const want = { program: n.program, system: n.system, state: n.state, cli: CLI_NAME[n.program], conpty: CONPTY[n.system] }
  const fields = rec as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(want)) if (fields[k] !== v) out.push(`${k} is ${JSON.stringify(fields[k])}, its name says ${JSON.stringify(v)}`)
  if (rec.version !== VERSION[n.program]) out.push(`version ${JSON.stringify(rec.version)}, its program's is ${JSON.stringify(VERSION[n.program])}`)
  if (!Number.isInteger(rec.cols) || !Number.isInteger(rec.rows) || rec.cols < 2 || rec.rows < 2) out.push(`size ${rec.cols}x${rec.rows}`)
  if (!Array.isArray(rec.events) || rec.events.length === 0) return [...out, 'no events']
  // From the session's first byte, nothing cut: each event's offset is the
  // bytes of the chunks before it.
  let offset = 0
  for (const [i, e] of rec.events.entries()) {
    if (e.o !== offset) { out.push(`event ${i} is at byte ${e.o}, after ${offset} bytes of chunks`); break }
    if (isChunk(e)) offset += Buffer.byteLength(e.text, 'utf-8')
    else if (!['resize', 'mark', 'keys'].includes(e.ev)) out.push(`event ${i} is a ${JSON.stringify(e.ev)}`)
  }
  const marks = rec.events.filter((e): e is OtherEvent => !isChunk(e) && e.ev === 'mark')
  if (marks.length === 0 || marks[marks.length - 1].state !== n.state) out.push(`its last state mark is ${JSON.stringify(marks[marks.length - 1]?.state)}, not ${n.state}`)
  return out
}

// ── the cases ───────────────────────────────────────────────────────────────
describe('the screen corpus (helper/fixtures/screens)', () => {
  it('holds recordings (a vacuous pass is no pass)', () => {
    expect(RECORDINGS.length).toBeGreaterThan(0)
  })

  describe('1. the rows xterm.js gives now are the committed rows', () => {
    it.each(RECORDINGS)('%s', async (name) => {
      const got = await rowsOf(name)
      if (WRITE) writeFileSync(resolve(DIR, `${name}.rows.json`), rowsFileText(name, got))
      expect(existsSync(resolve(DIR, `${name}.rows.json`)), `${name}.rows.json`).toBe(true)
      const committed = readRows(name)
      expect({ rows: rowDifferences(committed, got), xterm: xtermProblem(name, committed.xterm) }).toEqual({ rows: [], xterm: null })
    }, 30_000)
  })

  describe('2. each reader reads the state in the recording\'s name', () => {
    it.each(RECORDINGS)('%s', async (name) => {
      const { screens } = await rowsOf(name)
      expect(misreadProblem(name, readsAsNamed(name, screens[screens.length - 1].lines))).toBeNull()
    }, 30_000)
  })

  describe('3. the names, the structure and the size caps', () => {
    it('every file is a recording or its rows file, by a name from the fixed sets, and each recording has its rows file', () => {
      const files = listDir()
      const bad = files.filter((f) => {
        const base = f.endsWith('.rows.json') ? f.slice(0, -'.rows.json'.length) : f.endsWith('.json') ? f.slice(0, -'.json'.length) : null
        return base === null || !NAME_BY.has(base)
      })
      expect(bad).toEqual([])
      expect(files.filter((f) => f.endsWith('.rows.json')).map((f) => f.slice(0, -'.rows.json'.length))).toEqual(RECORDINGS)
    })

    it('every program, system and state is in the corpus or in LEFT_OUT, never both, and LEFT_OUT names the fixed sets', () => {
      const missing = NAMES.filter((n) => !RECORDINGS.includes(n.name) && !leftOutFor(n)).map((n) => n.name)
      const both = NAMES.filter((n) => RECORDINGS.includes(n.name) && leftOutFor(n)).map((n) => n.name)
      expect({ missing, both, stray: strayLeftOut(LEFT_OUT) }).toEqual({ missing: [], both: [], stray: [] })
    })

    it('every known misread is a recording', () => {
      expect(unlistedMisreads(KNOWN_MISREADS, RECORDINGS)).toEqual([])
    })

    it.each(RECORDINGS)('%s: its fields are its name\'s, and it runs on from its first byte', (name) => {
      expect(structureProblems(name, readRecording(name))).toEqual([])
    })

    it('each recording is at most 256 KiB, and all of them at most 3 MiB', () => {
      const sizes = RECORDINGS.map((name) => ({ name, size: sizeOf(`${name}.json`) }))
      expect(sizes.filter((s) => s.size > RECORDING_CAP)).toEqual([])
      expect(sizes.reduce((a, s) => a + s.size, 0)).toBeLessThanOrEqual(CORPUS_CAP)
    })
  })

  describe('4. nothing personal: no home folder but the generic ones, no e-mail, no key', () => {
    it.each(RECORDINGS)('%s', (name) => {
      const rec = readRecording(name)
      // The chunks joined too, so a path split across two chunks is seen.
      const joined = rec.events.filter(isChunk).map((e) => e.text).join('')
      const texts = [...stringsOf(rec), joined, ...(existsSync(resolve(DIR, `${name}.rows.json`)) ? stringsOf(JSON.parse(readFileSync(resolve(DIR, `${name}.rows.json`), 'utf-8'))) : [])]
      expect(privateFinds(texts)).toEqual([])
    })
  })

  describe('the checks catch what they are for (planted)', () => {
    it('case 1: one cell changed in a committed screen is a difference', async () => {
      const name = RECORDINGS[0]
      const got = await rowsOf(name)
      const planted: Made = JSON.parse(JSON.stringify(got)) as Made
      const line = planted.screens[planted.screens.length - 1].lines[0]
      line.text = `${line.text}x`
      expect(rowDifferences(planted, got)).toHaveLength(1)
      expect(rowDifferences(got, got)).toEqual([])
    })

    it('case 2: a recording under another state\'s name is caught', async () => {
      const ready = RECORDINGS.find((n) => n.startsWith('claude-') && n.endsWith('-ready')) as string
      const { screens } = await rowsOf(ready)
      const last = screens[screens.length - 1].lines
      expect(readsAsNamed(ready, last)).toBeNull()
      expect(readsAsNamed(ready.replace(/-ready$/, '-mid-reply'), last)).not.toBeNull()
    })

    it('case 1: a rows file made by another @xterm/headless is caught', () => {
      expect(xtermProblem('x', XTERM_VERSION)).toBeNull()
      expect(xtermProblem('x', '5.5.0')).not.toBeNull()
      expect(xtermProblem('x', undefined)).not.toBeNull()
    })

    it('case 2: a known misread is held to the wrong answer it lists', async () => {
      // A Claude Code ready screen under the mid-reply name: readsAsNamed's own
      // answer, "<name>: read ready, its name says mid-reply (busy)".
      const ready = RECORDINGS.find((n) => n.startsWith('claude-') && n.endsWith('-ready')) as string
      const { screens } = await rowsOf(ready)
      const renamed = ready.replace(/-ready$/, '-mid-reply')
      const problem = readsAsNamed(renamed, screens[screens.length - 1].lines)
      const listed = (reads: string): Record<string, Misread> => ({ [renamed]: { ticket: 'T', reads } })
      expect(misreadProblem(renamed, problem, listed('ready'))).toBeNull()
      expect(misreadProblem(renamed, problem, listed('no-prompt'))).not.toBeNull()
      expect(misreadProblem(renamed, null, listed('ready'))).not.toBeNull()
      expect(misreadProblem(renamed, problem, {})).toBe(problem)
      expect(misreadProblem(ready, null, {})).toBeNull()
    })

    it('case 3: a known misread that is no recording is caught', () => {
      const listed = (name: string): Record<string, Misread> => ({ [name]: { ticket: 'T', reads: 'unrecognised' } })
      expect(unlistedMisreads(listed(RECORDINGS[0]), RECORDINGS)).toEqual([])
      expect(unlistedMisreads(listed('codex-linux-gone'), RECORDINGS)).toEqual(['codex-linux-gone'])
    })

    it('case 3: a recording of another version than its program\'s is caught', () => {
      const name = RECORDINGS.find((n) => n.startsWith('codex170-')) as string
      const rec = readRecording(name)
      expect(structureProblems(name, rec)).toEqual([])
      expect(structureProblems(name, { ...rec, version: '0.157.1' })).toEqual(['version "0.157.1", its program\'s is "0.170.0"'])
    })

    it('case 3: a LEFT_OUT row holds only on its systems, and one outside the fixed sets is caught', () => {
      const row: LeftOut = { program: 'codex', state: 'after-reply', systems: ['linux'], why: 'x' }
      expect(leftOutFor({ program: 'codex', system: 'linux', state: 'after-reply' }, [row])).toBe(row)
      expect(leftOutFor({ program: 'codex', system: 'macos', state: 'after-reply' }, [row])).toBeUndefined()
      expect(strayLeftOut([row])).toEqual([])
      expect(strayLeftOut([{ ...row, state: 'gone' }])).toHaveLength(1)
      expect(strayLeftOut([{ ...row, program: 'codex171' }])).toHaveLength(1)
      expect(strayLeftOut([{ ...row, systems: ['windows'] }])).toHaveLength(1)
      expect(strayLeftOut([{ ...row, systems: [] }])).toHaveLength(1)
    })

    it('case 4: a home folder, an e-mail shape and a key shape are found; the generic homes are not', () => {
      expect(privateFinds(['PS C:\\Users\\User\\work>', '/home/runner/work', '/Users/runner/x', 'C:/Users/runneradmin/a'])).toEqual([])
      expect(privateFinds(['PS C:\\Users\\someone\\work>'])).toHaveLength(1)
      expect(privateFinds(['cd /home/someone/src'])).toHaveLength(1)
      expect(privateFinds(['/Users/someone/Library'])).toHaveLength(1)
      expect(privateFinds([['someone', 'example.org'].join('@')])).toHaveLength(1)
      expect(privateFinds([`key ${['sk', 'x'.repeat(24)].join('-')}`])).toHaveLength(1)
    })
  })
})
