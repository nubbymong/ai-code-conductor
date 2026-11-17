/**
 * [host] The fake Claude CLI's performance-harness switch
 * (scripts/readme-shots/stage/fake-claude.js and fake-mode.js): with no
 * `mode` in its fake-stage.json (the README pipeline) it behaves exactly as
 * before the harness (status every 2 s, first frame on the first tick, the
 * file read once); with a mode, an idle CLI rests at its prompt, a switch to
 * busy is picked up from the file, a half-written file keeps the last mode,
 * and the file is read again only when it changed; a copy's status names
 * its own transcript, any other conversation keeps its own.
 *
 * The script runs here inside a function with stand-ins for require, fs,
 * process and the timers: nothing is started, read from or written to disk
 * (content.js and fake-mode.js are the real modules).
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import path from 'path'

const STAGE_DIR = path.resolve(__dirname, '..', '..', '..', 'scripts', 'readme-shots', 'stage')
const SRC = readFileSync(path.join(STAGE_DIR, 'fake-claude.js'), 'utf8')
const real = createRequire(path.join(STAGE_DIR, 'fake-claude.js'))
const CONTENT = real('./content.js')
const MODE = real('./fake-mode.js') as { modeReader: (file: string, initial?: string, fsx?: unknown) => () => string }
const PROMO = '6d3f2a41-8c9e-4b17-9f52-0a1b2c3d4e5f'

type Fake = {
  out: () => string
  intervals: Array<{ ms: number; fn: () => void }>
  reads: () => number
  stats: () => number
  writes: Array<{ file: string; text: string }>
  setStage: (text: string | null) => void
  settle: () => Promise<void>
}

/** Run fake-claude.js with stand-ins; `stage` is fake-stage.json's text (null: no file). */
function runFake(stage: string | null, { resume = PROMO, env = {} as Record<string, string> } = {}): Fake {
  const out: string[] = []
  const intervals: Array<{ ms: number; fn: () => void }> = []
  const timeouts: Array<() => void> = []
  const writes: Array<{ file: string; text: string }> = []
  let stageText = stage
  let mtime = 1
  let reads = 0
  let stats = 0
  const isStage = (p: string) => path.basename(p) === 'fake-stage.json'
  const fsStub = {
    readFileSync: (p: string) => { if (!isStage(p) || stageText === null) throw new Error('ENOENT ' + p); reads++; return stageText },
    statSync: (p: string) => { stats++; if (!isStage(p) || stageText === null) throw new Error('ENOENT ' + p); return { mtimeMs: mtime, size: stageText.length } },
    mkdirSync: () => undefined,
    writeFileSync: (file: string, text: string) => { writes.push({ file, text }) },
    renameSync: () => undefined,
  }
  const req = (id: string) => {
    if (id === 'fs') return fsStub
    if (id === 'path') return path
    if (id.endsWith('content.js')) return CONTENT
    if (id.endsWith('fake-mode.js')) return { modeReader: (file: string, initial: string) => MODE.modeReader(file, initial, fsStub) }
    throw new Error('unexpected require ' + id)
  }
  const proc = {
    argv: ['node', path.join(STAGE_DIR, 'fake-claude.js'), '--resume', resume],
    env,
    stdout: { columns: 120, write: (s: string) => { out.push(s); return true } },
    stdin: { isTTY: false, setRawMode: () => undefined, resume: () => undefined, on: () => undefined },
    exit: (c: number) => { throw new Error('exit ' + c) },
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const script = new Function('require', 'process', 'setTimeout', 'setInterval', '__dirname', SRC)
  script(req, proc, (cb: () => void) => { timeouts.push(cb) }, (fn: () => void, ms: number) => { intervals.push({ fn, ms }) }, STAGE_DIR)
  return {
    out: () => out.join(''),
    intervals,
    reads: () => reads,
    stats: () => stats,
    writes,
    setStage: (text) => { stageText = text; mtime++ },
    // Runs the scenario's sleeps one by one until nothing is waiting.
    settle: async () => {
      for (let i = 0; i < 200_000; i++) {
        await new Promise((r) => setImmediate(r))
        const next = timeouts.shift()
        if (!next) return
        next()
      }
      throw new Error('the scenario never finished')
    },
  }
}
const tick = (f: Fake, ms: number) => { for (const i of f.intervals) if (i.ms === ms) i.fn() }
const WORKING = 'esc to interrupt'
const PROMPT = 'accept edits on'

describe('the README pipeline: no mode in fake-stage.json', () => {
  it('writes its status on a plain 2 s timer, reads the file once, and draws its first frame on the first tick', async () => {
    const f = runFake(JSON.stringify({ statusDir: '', home: '' }))
    await f.settle()
    expect(f.intervals.map((i) => i.ms)).toEqual([2000, 120])
    expect(f.intervals[0].fn.name).toBe('writeStatus')
    expect(f.out()).not.toContain(WORKING)
    tick(f, 120)
    expect(f.out()).toContain(WORKING)
    tick(f, 2000)
    // Never looked at again, and no mode module loaded.
    expect([f.reads(), f.stats()]).toEqual([1, 0])
  })
})

describe('the harness: a mode in fake-stage.json', () => {
  it('draws an idle CLI resting at its prompt at once, and nothing more while idle', async () => {
    const f = runFake(JSON.stringify({ statusDir: '', home: '', mode: 'idle' }))
    await f.settle()
    expect(f.out()).toContain(PROMPT)
    expect(f.out()).not.toContain(WORKING)
    const before = f.out().length
    for (let i = 0; i < 5; i++) tick(f, 120)
    expect(f.out().length).toBe(before)
  })

  it('picks a switch to busy up from the file, and reads the file only when it changed', async () => {
    const f = runFake(JSON.stringify({ statusDir: '', home: '', mode: 'idle' }))
    await f.settle()
    tick(f, 2000)
    tick(f, 2000)
    const reads = f.reads()
    f.setStage(JSON.stringify({ statusDir: '', home: '', mode: 'busy' }))
    tick(f, 2000)
    expect(f.reads()).toBe(reads + 1)
    tick(f, 120)
    expect(f.out()).toContain(WORKING)
    tick(f, 2000)
    expect(f.reads()).toBe(reads + 1)
  })

  it('keeps its mode when the file is caught half written', async () => {
    const f = runFake(JSON.stringify({ statusDir: '', home: '', mode: 'idle' }))
    await f.settle()
    const before = f.out().length
    f.setStage('{"statusDir": "", "home": "", "mo')
    tick(f, 2000)
    tick(f, 120)
    expect(f.out().length).toBe(before)
    // Once the write completes it is read again.
    f.setStage(JSON.stringify({ statusDir: '', home: '', mode: 'busy' }))
    tick(f, 2000)
    tick(f, 120)
    expect(f.out()).toContain(WORKING)
  })
})

describe('the status a copy writes', () => {
  const COPY = '0f4c2b1a-1111-4222-8333-444455556666'
  const OTHER = '0f4c2b1a-9999-4888-8777-666655554444'
  const statusOf = async (resume: string) => {
    const f = runFake(JSON.stringify({ statusDir: 'S', home: 'H', mode: 'busy', copies: { [COPY]: PROMO } }), { resume, env: { CLAUDE_MULTI_SESSION_ID: 'abc' } })
    await f.settle()
    return JSON.parse(f.writes[0].text) as { transcriptPath: string }
  }

  it("names the copy's own transcript", async () => {
    expect((await statusOf(COPY)).transcriptPath).toMatch(new RegExp(`${COPY}\\.jsonl$`))
  })

  it('leaves the transcript of a conversation that is not a copy as content.js has it', async () => {
    // Not a copy and not seeded: drawn as the promo session, whose own transcript it names.
    expect((await statusOf(OTHER)).transcriptPath).toMatch(new RegExp(`${PROMO}\\.jsonl$`))
  })
})

describe('the mode reader', () => {
  const file = 'C:\\x\\fake-stage.json'
  const fsOf = (state: { text: string | null; mtime: number }, counts: { read: number }) => ({
    statSync: () => { if (state.text === null) throw new Error('ENOENT'); return { mtimeMs: state.mtime, size: state.text.length } },
    readFileSync: () => { counts.read++; if (state.text === null) throw new Error('ENOENT'); return state.text },
  })

  it('starts from the mode it is given and keeps it while the file is missing', () => {
    const counts = { read: 0 }
    const read = MODE.modeReader(file, 'idle', fsOf({ text: null, mtime: 1 }, counts))
    expect(read()).toBe('idle')
    expect(MODE.modeReader(file, 'nonsense', fsOf({ text: null, mtime: 1 }, counts))()).toBe('busy')
  })

  it('reads again only when the time or size changed, and ignores a mode it does not know', () => {
    const counts = { read: 0 }
    const state = { text: JSON.stringify({ mode: 'busy' }) as string | null, mtime: 1 }
    const read = MODE.modeReader(file, 'idle', fsOf(state, counts))
    expect([read(), read(), read()]).toEqual(['busy', 'busy', 'busy'])
    expect(counts.read).toBe(1)
    state.text = JSON.stringify({ mode: 'sleepy' }); state.mtime = 2
    expect(read()).toBe('busy')
    state.text = '{"mode": "id'; state.mtime = 3
    expect(read()).toBe('busy')
    expect(read()).toBe('busy')
    expect(counts.read).toBe(4) // the half-written file is tried again
  })
})
