// WP1.70 / WP1.73: bidirectional traceability between the 73 acceptance items
// and the tests/evidence that prove them. Structural rules apply in every
// phase (an `unavailable` item's rules among them, ADR-026); completeness
// rules (every item evidenced or, on a recorded owner decision, unavailable;
// every evidence record digest-bound and taken at boundHead, an ancestor of
// HEAD with nothing but neutral paths changed since: ./binding.ts) apply once
// the phase is DECLARED candidate (env or manifest; see ./phase.ts).
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolvePhaseDetailed } from './phase'
import {
  ITEM_STATUSES, MANIFEST_PATH, RELEASE_WP1_PHASE, SHA_RE, UNAVAILABLE_ELIGIBLE, ancestry, bindingBreaks, changedPaths, evidenceProblems, incompleteItems, staleRecords,
  suiteSteps, unavailableIds, unavailableProblems, type EvidenceRecord, type Git, type ItemStatus, type Unavailable,
} from './binding'
import { DEEPEN_STEPS, deepenUntilDecidable, invocation, readBoundHead } from '../../scripts/wp1/fetch-ledger-commit.mjs'

const ROOT = resolve(__dirname, '..', '..')
type Item = {
  id: string; title: string; kind: string; tests: string[]; evidence: string[]; status: ItemStatus
  reason?: string; currentTests?: string[]; baseCoverage?: string
  evidenceRecords?: EvidenceRecord[]; unavailable?: Unavailable
}
const manifest = JSON.parse(readFileSync(resolve(ROOT, MANIFEST_PATH), 'utf8')) as {
  schema: string; phase: 'gate0' | 'candidate'; boundHead: string | null; designDigest: string; items: Item[]
}
const ledger = JSON.parse(readFileSync(resolve(__dirname, 'legacy-codex-ledger.json'), 'utf8')) as {
  entries: Array<{ path: string; category: string; disposition: string; evidence: string }>
}
const { phase, reason } = resolvePhaseDetailed(undefined, { eager: false })
const KINDS = new Set(['automated', 'manual-gate', 'packaged', 'real-cli', 'document', 'ci'])
// Exactly what vitest.config.ts collects (tests/integration has no .tsx glob;
// *.native.test.* is excluded from the system-Node run).
const RUNNABLE = /^tests\/(unit|wp1)\/.+\.test\.tsx?$|^tests\/integration\/.+\.test\.ts$/
const NATIVE = /\.native\.test\.tsx?$/
const E2E = /^tests\/e2e\/.+\.spec\.ts$/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}
const nonEmpty = (p: string) => existsSync(resolve(ROOT, p)) && statSync(resolve(ROOT, p)).size > 0
const sha256 = (p: string) => createHash('sha256').update(readFileSync(resolve(ROOT, p))).digest('hex')
const byId = new Map(manifest.items.map((i) => [i.id, i]))
// The candidate check's git, in this repository. The [host] cases below pass
// their own Git instead and spawn nothing.
const git: Git = (args) => {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// A linear history of `total` commits, HEAD first, holding boundHead at index
// `at` (Infinity: not in HEAD's history) with `depth` commits present. It
// answers the calls deepenUntilDecidable makes as git does: `--depth=N` sets
// the depth to N (so it can shorten it), `--unshallow` fetches everything.
const HEAD_SHA = 'c'.repeat(40)
function fakeRepo(o: { total: number; at: number; depth: number; cutOff?: boolean; mergeBase?: number | null; failFetch?: boolean; stuck?: boolean }) {
  let depth = o.depth
  const calls: string[][] = []
  const g: Git = (args) => {
    calls.push(args)
    if (args[0] === 'merge-base') return { status: o.mergeBase !== undefined ? o.mergeBase : o.at < depth ? 0 : o.cutOff ? 1 : 128, stdout: '' }
    if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return { status: 0, stdout: depth < o.total ? 'true\n' : 'false\n' }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${HEAD_SHA}\n` }
    if (args[0] === 'rev-list') return { status: 0, stdout: `${depth}\n` }
    if (args[0] === 'fetch') {
      if (o.failFetch) return { status: 128, stdout: '', stderr: 'fatal: could not read from remote repository' }
      if (!o.stuck) depth = args[2] === '--unshallow' ? o.total : Math.min(o.total, Number(args[2].slice('--depth='.length)))
      return { status: 0, stdout: '' }
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  }
  return { git: g, fetches: () => calls.filter((c) => c[0] === 'fetch') }
}

describe('WP1 traceability manifest', () => {
  it('has exactly WP1.1 .. WP1.73, unique and contiguous, and is bound to the reviewed design digest', () => {
    const ids = manifest.items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(Array.from({ length: 73 }, (_, i) => `WP1.${i + 1}`))
    expect(manifest.designDigest).toBe('e4d5b99a562952694be034ed8e71db6da379d8cb15bb24df6c2ca3f02cd83140')
  })

  it('every item names at least one test or evidence record, a known kind and status, a reason when not automated, and its base coverage', () => {
    for (const i of manifest.items) {
      expect(KINDS.has(i.kind), `${i.id} kind ${i.kind}`).toBe(true)
      // A mistyped status ('Evidenced') fails PR CI at gate0, not 25 minutes into the stable run.
      expect(ITEM_STATUSES as readonly string[], `${i.id} status ${String(i.status)}`).toContain(i.status)
      expect(i.tests.length + i.evidence.length, `${i.id} has no test or evidence link`).toBeGreaterThan(0)
      if (i.kind !== 'automated') expect((i.reason ?? '').length, `${i.id} (${i.kind}) needs a reason why automation is not safe or possible`).toBeGreaterThanOrEqual(10)
      expect(Array.isArray(i.currentTests), `${i.id} must state currentTests (empty when the base has none)`).toBe(true)
      if (i.currentTests!.length === 0) expect((i.baseCoverage ?? '').length, `${i.id} has no currentTests and no baseCoverage reason`).toBeGreaterThanOrEqual(4)
    }
  })

  it('every listed test path is one vitest collects or an e2e spec; an automated item has at least one collected test', () => {
    for (const i of manifest.items) {
      for (const t of i.tests) {
        expect((RUNNABLE.test(t) && !NATIVE.test(t)) || E2E.test(t), `${i.id}: ${t} is outside the vitest include globs and is not an e2e spec`).toBe(true)
      }
      if (i.kind === 'automated') expect(i.tests.some((t) => RUNNABLE.test(t) && !NATIVE.test(t)), `${i.id} is automated but lists no vitest-collected test`).toBe(true)
      for (const t of i.currentTests ?? []) expect(nonEmpty(t), `${i.id}: currentTests ${t} missing on disk`).toBe(true)
    }
  })

  it('a documentation file the ledger schedules for a rewrite is listed as evidence by every WP1 item its entry cites', () => {
    for (const e of ledger.entries.filter((x) => x.category === 'DOCS' && x.disposition !== 'retain')) {
      for (const id of e.evidence.match(/WP1\.\d+/g) ?? []) {
        const item = byId.get(id)
        expect(item, `${e.path} cites unknown ${id}`).toBeDefined()
        expect(item!.evidence, `${id} does not list ${e.path} (cited by its ledger entry)`).toContain(e.path)
      }
    }
  })

  // An unavailable item is held to all of this too (ADR-026): it records a
  // gap inside the bound evidence, never in place of it. The rules are
  // ./binding.ts evidenceProblems, proven on injected files below.
  it('evidenced and unavailable items point at non-empty files that name the item, with digest-bound evidence records', () => {
    const problems = evidenceProblems(manifest.items, { nonEmpty, text: (p) => readFileSync(resolve(ROOT, p), 'utf8'), sha256 })
    expect(problems, problems.join('\n')).toEqual([])
  })

  // A record pins its file by the sha256 of its bytes, so the file must be the
  // same bytes on every runner. Unpinned, Windows checks a text file out CRLF
  // and Linux and macOS LF, and one leg of the stable run goes red. A working
  // copy's line endings say nothing about the runners, so the rule is held by
  // ATTRIBUTE (as tests/unit/scripts/mjs-eol.test.ts does), for every tracked
  // file and for one not written yet.
  it('every file under docs/wp1/evidence is checked out LF on every runner, so its record has one sha256', () => {
    const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', 'docs/wp1/evidence'], { encoding: 'utf8' }).split('\0').filter(Boolean)
    expect(tracked.length, 'no tracked file under docs/wp1/evidence: the check would be vacuous').toBeGreaterThan(0)
    const paths = [...tracked, 'docs/wp1/evidence/not-written-yet.md']
    // `check-attr -z` prints path, attribute, value, each NUL-terminated.
    const fields = execFileSync('git', ['-C', ROOT, 'check-attr', '-z', 'text', 'eol', '--', ...paths], { encoding: 'utf8' }).split('\0')
    const unpinned: string[] = []
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const want = fields[i + 1] === 'eol' ? 'lf' : 'set'
      if (fields[i + 2] !== want) unpinned.push(`${fields[i]}: ${fields[i + 1]} ${fields[i + 2]}`)
    }
    expect(fields.length, 'git check-attr answered nothing').toBeGreaterThan(paths.length * 2 * 3 - 1)
    expect(unpinned, `these would be checked out CRLF on Windows, so their record's sha256 matches one runner only:\n${unpinned.join('\n')}`).toEqual([])
  })

  // [host] The same rules on injected files (nothing is read): an item
  // recorded unavailable answers for every test and evidence record an
  // evidenced one does; a planned one is not checked yet.
  it('[host] an unavailable item is held to every evidence rule of an evidenced one; a planned item to none yet', () => {
    const X = 'a'.repeat(40)
    const T = 'tests/wp1/fake-keyring.test.ts'
    const E = 'docs/wp1/evidence/keyring-smoke.md'
    const text: Record<string, string> = { [T]: '// WP1.11 / WP1.72', 'tests/wp1/other.test.ts': '// WP1.110', 'tests/unit/x.test.ts': '// names nothing', [E]: `Taken at ${X}.`, 'README.md': 'x' }
    const files = { nonEmpty: (p: string) => (text[p] ?? '').length > 0, text: (p: string) => text[p], sha256: (p: string) => `sha256 of ${p}` }
    const rec = { artifact: E, sha256: `sha256 of ${E}`, head: X, actor: 'agent', at: '2026-10-13T11:00:00Z', commands: ['npx vitest run'] }
    const item = (over: Record<string, unknown>) => ({ id: 'WP1.11', tests: [T], evidence: [E], evidenceRecords: [rec], ...over })
    for (const status of ['evidenced', 'unavailable']) {
      const one = (over: Record<string, unknown>) => evidenceProblems([item({ status, ...over })], files)
      expect(one({}), status).toEqual([])
      expect(one({ tests: [T, 'tests/unit/x.test.ts'], evidence: [E, 'README.md'] }), status).toEqual([])
      expect(one({ tests: ['tests/wp1/missing.test.ts'] }), status).toEqual(['WP1.11: missing or empty tests/wp1/missing.test.ts'])
      expect(one({ tests: ['tests/wp1/other.test.ts'] }), status).toEqual(['tests/wp1/other.test.ts does not name WP1.11'])
      expect(one({ evidence: ['docs/wp1/evidence/missing.md'] }), status).toEqual(['WP1.11: missing or empty docs/wp1/evidence/missing.md'])
      expect(one({ evidenceRecords: undefined }), status).toEqual([`WP1.11: no evidence record for ${E}`])
      expect(one({ evidenceRecords: [{ ...rec, artifact: 'docs/wp1/evidence/other.md' }] }), status).toEqual([`WP1.11: no evidence record for ${E}`])
      expect(one({ evidenceRecords: [{ ...rec, sha256: 'stale' }] }), status).toEqual([`WP1.11: the record for ${E} has sha256 stale, the file has sha256 of ${E}`])
      expect(one({ evidenceRecords: [{ ...rec, head: 'HEAD' }] }), status).toEqual([`WP1.11: the record for ${E} names no 40-hex head it was taken at`])
      expect(one({ evidenceRecords: [{ ...rec, actor: '' }] }), status).toEqual([`WP1.11: the record for ${E} names no actor`])
      expect(one({ evidenceRecords: [{ ...rec, at: 'today' }] }), status).toEqual([`WP1.11: the record for ${E} has no valid time`])
      expect(one({ evidenceRecords: [{ ...rec, commands: [] }] }), status).toEqual([`WP1.11: the record for ${E} lists no commands`])
    }
    expect(evidenceProblems([item({ status: 'planned', tests: ['tests/wp1/missing.test.ts'], evidenceRecords: undefined })], files)).toEqual([])
  })

  it('every WP1 test file is named by at least one item (no dangling tests)', () => {
    const named = new Set(manifest.items.flatMap((i) => i.tests))
    for (const f of walk(resolve(__dirname))) {
      const rel = f.replace(/\\/g, '/').slice(ROOT.replace(/\\/g, '/').length + 1)
      expect(named.has(rel), `${rel} is not named by any WP1.* item`).toBe(true)
      expect(/WP1\.\d+/.test(readFileSync(f, 'utf8')), `${rel} names no WP1.* requirement`).toBe(true)
    }
  })

  // Existence is enforced for an evidenced item's tests and evidence, and for
  // every item's currentTests (above). A PLANNED item may name a test or
  // record that is not written yet, but never one that exists under another
  // folder: five items once named tests/wp1/accounts-surface.test.tsx while
  // the surface test lived in tests/unit/renderer/.
  it('a cited path that does not exist is a planned file, never a wrong pointer to one that exists elsewhere', () => {
    const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').map((s) => s.trim()).filter(Boolean)
    const byName = new Map<string, string[]>()
    for (const p of tracked) {
      const name = p.slice(p.lastIndexOf('/') + 1)
      byName.set(name, [...(byName.get(name) ?? []), p])
    }
    const wrongPointers = (items: Array<Pick<Item, 'id' | 'tests' | 'evidence'>>) => items.flatMap((i) => [...i.tests, ...i.evidence]
      .filter((p) => !existsSync(resolve(ROOT, p)))
      .flatMap((p) => {
        const elsewhere = byName.get(p.slice(p.lastIndexOf('/') + 1))
        return elsewhere ? [`${i.id}: ${p} does not exist, but ${elsewhere.join(', ')} does`] : []
      }))
    const wrong = wrongPointers(manifest.items)
    expect(wrong, wrong.join('\n')).toEqual([])
    // Verify the verifier: the old pointer is caught; a planned file that
    // exists nowhere, and an existing one, are not.
    expect(wrongPointers([{ id: 'WP1.39', tests: ['tests/wp1/accounts-surface.test.tsx'], evidence: [] }])).toHaveLength(1)
    expect(wrongPointers([{ id: 'WP1.72', tests: ['tests/wp1/fake-keyring.test.ts'], evidence: ['docs/wp1/evidence/keyring-smoke.md'] }])).toEqual([])
    expect(wrongPointers([{ id: 'WP1.39', tests: ['tests/unit/renderer/accounts-surface.test.tsx'], evidence: [] }])).toEqual([])
  })

  // [host] The candidate check's filter, on injected changed-file lists (no
  // git is spawned): the commit that records a binding edits only neutral
  // paths, so it passes (P4.10), while any other path breaks the binding,
  // including kinds the old src/scripts/tests scope missed.
  it('[host] the binding survives only neutral paths, its own manifest and the documentation; anything else breaks it', () => {
    const bindingCommit = ['tests/wp1/traceability.json', 'docs/wp1/evidence/real-cli-matrix.md', 'docs/wp1/evidence/keyring-smoke.md',
      'docs/wp2/parity-checklist.md', 'docs/wp2/completion-plan.md', 'CONTEXT.d/2026-10-03-wp2-pr4.md', 'architecture/decisions/2026-10-03-adr-099-x.md',
      'README.md', 'CHANGELOG.md']
    expect(bindingBreaks(bindingCommit)).toEqual([])
    for (const p of ['tests/wp1/traceability.test.ts', 'tests/wp1/binding.ts', 'tests/wp1/legacy-codex-ledger.json', 'tests/wp1/fake-cli/oracle.json',
      'tests/wp1/phase.ts', 'tests/unit/main/x.test.ts', 'tests/e2e/x.spec.ts', 'src/main/index.ts', 'scripts/release.js',
      'scripts/wp1/fetch-ledger-commit.mjs', 'package.json', 'package-lock.json', 'resources/model-registry.json', 'build/installer.nsh',
      'electron.vite.config.ts', 'vitest.config.ts', 'tsconfig.json', '.github/workflows/ci.yml', 'NOTICE', 'newdir/x.ts']) {
      expect(bindingBreaks([...bindingCommit, p]), p).toEqual([p])
    }
    // Near misses of a neutral path still break.
    for (const p of ['tests/wp1/traceability.json.bak', 'tests/wp1/fake-cli/traceability.json', 'tests/traceability.json', 'src/traceability.json',
      'src/docs/a.ts', 'docs.ts', 'src/renderer/help.md', 'tests/wp1/notes.md', '.github/pull_request_template.md',
      'architecture/decisions/x.json', 'CONTEXT.d.ts']) {
      expect(bindingBreaks([p]), p).toEqual([p])
    }
  })

  // [host] The candidate check reads git through one call, here a fake (no
  // git is spawned): the diff's argv and NUL parsing, and the ancestry
  // verdict, under which a shallow clone can only prove "ancestor".
  it('[host] the candidate check\'s git wiring: the diff argv and its NUL-separated list, and the ancestry verdict per exit code and shallowness', () => {
    const B = 'b'.repeat(40)
    const calls: string[][] = []
    const diff: Git = (args) => { calls.push(args); return { status: 0, stdout: 'docs/a.md\0src/x.ts\0' } }
    expect(bindingBreaks(changedPaths(diff, B))).toEqual(['src/x.ts'])
    expect(calls).toEqual([['diff', '--name-only', '--no-renames', '-z', `${B}..HEAD`]])
    expect(() => changedPaths(() => ({ status: 128, stdout: '', stderr: 'fatal: bad revision' }), B)).toThrow(/exited 128/)
    const repo = (mergeBase: number | null, shallow: string): Git => (args) =>
      args[0] === 'merge-base' ? { status: mergeBase, stdout: '' } : { status: 0, stdout: `${shallow}\n` }
    expect(ancestry(repo(0, 'true'), B)).toBe('ancestor')
    expect(ancestry(repo(1, 'true'), B)).toBe('undecidable')
    expect(ancestry(repo(128, 'true'), B)).toBe('undecidable')
    expect(ancestry(repo(1, 'false'), B)).toBe('not-ancestor')
    expect(ancestry(repo(128, 'false'), B)).toBe('not-ancestor')
    expect(ancestry(repo(null, 'false'), B)).toBe('undecidable')
    expect(ancestry(repo(1, 'garbage'), B)).toBe('undecidable')
    expect(() => ancestry(repo(0, 'false'), '--upload-pack=x')).toThrow(/40-hex/)
  })

  // [host] The binding cannot certify itself: the manifest that declares
  // boundHead is neutral, so every evidence record names the head it was
  // taken at, its artifact says so, and every one must be boundHead.
  it('[host] staleRecords: an honest binding passes; moving boundHead, or a record\'s head, past the evidence fails', () => {
    const X = 'a'.repeat(40)
    const D = 'd'.repeat(40)
    const rcm = 'docs/wp1/evidence/real-cli-matrix.md'
    const ks = 'docs/wp1/evidence/keyring-smoke.md'
    const texts: Record<string, string> = { [rcm]: `Taken at ${X} on 0.155.1.`, [ks]: `head ${X}` }
    const textOf = (a: string) => texts[a] ?? ''
    const items = [{ id: 'WP1.2', evidenceRecords: [{ artifact: rcm, head: X }] }, { id: 'WP1.11', evidenceRecords: [{ artifact: ks, head: X }] }, { id: 'WP1.1' }]
    expect(staleRecords(items, X, textOf)).toEqual([])
    // The rebind reflex: boundHead moved to D past a source change, the evidence untouched.
    expect(staleRecords(items, D, textOf)).toEqual([
      `WP1.2: ${rcm} was taken at ${X}, not at boundHead ${D}`,
      `WP1.11: ${ks} was taken at ${X}, not at boundHead ${D}`,
    ])
    // Each record's head moved too, while its artifact still names X.
    const moved = items.map((i) => ({ ...i, evidenceRecords: i.evidenceRecords?.map((r) => ({ ...r, head: D })) }))
    expect(staleRecords(moved, D, textOf)).toEqual([
      `WP1.2: ${rcm} does not name the head ${D} its record claims`,
      `WP1.11: ${ks} does not name the head ${D} its record claims`,
    ])
    expect(staleRecords([{ id: 'WP1.10', evidenceRecords: [{ artifact: rcm, head: '' }] }], X, textOf)).toEqual([`WP1.10: ${rcm} was taken at (no head), not at boundHead ${X}`])
    // A head a reader cannot see, only inside an HTML comment, is not named;
    // in a fenced block a reader sees it (a command's output names it).
    const hiddenHead = (a: string) => (a === rcm ? `Taken on 0.155.1. <!-- ${X} -->` : textOf(a))
    expect(staleRecords([items[0]], X, hiddenHead)).toEqual([`WP1.2: ${rcm} does not name the head ${X} its record claims`])
    const fencedHead = (a: string) => (a === rcm ? ['Taken on 0.155.1:', '', '```', '$ git rev-parse HEAD', X, '```', ''].join('\n') : textOf(a))
    expect(staleRecords([items[0]], X, fencedHead)).toEqual([])
  })

  // [host] scripts/wp1/fetch-ledger-commit.mjs makes boundHead's ancestry
  // decidable in CI's depth-1 checkouts before the suite runs (a fake repo;
  // nothing is spawned or fetched): bounded steps asked for from the depth
  // already here, then one full fetch; never in a full clone; a failure is an
  // error, never a silent "not an ancestor".
  it('[host] the binding fetch deepens a shallow checkout in bounded steps until the ancestry is decidable, and fails loudly when it cannot be', () => {
    const B = 'b'.repeat(40)
    const fetch = (flag: string) => ['fetch', '--no-tags', flag, 'origin', HEAD_SHA]
    expect(DEEPEN_STEPS).toEqual([64, 512])
    let r = fakeRepo({ total: 3000, at: 3, depth: 1 })
    expect(deepenUntilDecidable(r.git, B)).toEqual({ verdict: 'ancestor', fetches: [fetch('--depth=65')] })
    r = fakeRepo({ total: 3000, at: 3, depth: 1, cutOff: true })
    expect(deepenUntilDecidable(r.git, B).verdict).toBe('ancestor')
    r = fakeRepo({ total: 3000, at: 300, depth: 1 })
    expect(deepenUntilDecidable(r.git, B)).toEqual({ verdict: 'ancestor', fetches: [fetch('--depth=65'), fetch('--depth=577')] })
    // Each step is asked for from the depth already here, so it never shortens it.
    r = fakeRepo({ total: 3000, at: 150, depth: 100 })
    expect(deepenUntilDecidable(r.git, B)).toEqual({ verdict: 'ancestor', fetches: [fetch('--depth=164')] })
    r = fakeRepo({ total: 3000, at: 2000, depth: 1 })
    expect(deepenUntilDecidable(r.git, B)).toEqual({ verdict: 'ancestor', fetches: [fetch('--depth=65'), fetch('--depth=577'), fetch('--unshallow')] })
    // Not in HEAD's history: decided only once the history is complete, after three fetches at most.
    r = fakeRepo({ total: 3000, at: Infinity, depth: 1 })
    expect(deepenUntilDecidable(r.git, B)).toEqual({ verdict: 'not-ancestor', fetches: [fetch('--depth=65'), fetch('--depth=577'), fetch('--unshallow')] })
    // A full clone is answered as it is and never fetched into (--depth would make it shallow).
    r = fakeRepo({ total: 3000, at: Infinity, depth: 3000, cutOff: true })
    expect(deepenUntilDecidable(r.git, B)).toEqual({ verdict: 'not-ancestor', fetches: [] })
    r = fakeRepo({ total: 3000, at: 3, depth: 3000, mergeBase: null })
    expect(deepenUntilDecidable(r.git, B)).toMatchObject({ verdict: 'undecidable', fetches: [], error: expect.stringMatching(/not shallow/) })
    // A failed fetch, and a remote that never deepens, are errors.
    r = fakeRepo({ total: 3000, at: 3, depth: 1, failFetch: true })
    expect(deepenUntilDecidable(r.git, B)).toMatchObject({ verdict: 'undecidable', fetches: [fetch('--depth=65')], error: expect.stringMatching(/exited 128: fatal: could not read/) })
    r = fakeRepo({ total: 3000, at: 3, depth: 1, stuck: true })
    expect(deepenUntilDecidable(r.git, B)).toMatchObject({ verdict: 'undecidable', error: expect.stringMatching(/full history/) })
    expect(r.fetches()).toHaveLength(3)
  })

  // [host] The boundHead comes from a file a PR can edit and reaches git's
  // argv, so the script takes only a 40-hex commit id.
  it('[host] the binding fetch reads boundHead only as a 40-hex commit id', () => {
    const B = 'b'.repeat(40)
    expect(readBoundHead('{"boundHead":null}')).toEqual({ none: true })
    expect(readBoundHead('{}')).toEqual({ none: true })
    expect(readBoundHead(JSON.stringify({ boundHead: B }))).toEqual({ sha: B })
    for (const bad of ['--upload-pack=touch x', 'HEAD', 'abc123', 'B'.repeat(40), `${B}\n`, `${B}0`, 123, ['x']]) {
      expect(readBoundHead(JSON.stringify({ boundHead: bad })), String(bad)).toEqual({ error: 'tests/wp1/traceability.json boundHead is not a 40-hex commit id' })
    }
  })

  // [host] The script runs when node is asked to run it, through whatever path
  // CI used (a linked or junctioned checkout included), and never exits 0
  // having done nothing (PR 4 re-review): a started file with its name that
  // is not it is an error. Real paths are injected; nothing is resolved.
  it('[host] the binding fetch runs by its real path, and refuses to guess when started under its name from elsewhere', () => {
    const self = '/real/ws/scripts/wp1/fetch-ledger-commit.mjs'
    const links: Record<string, string> = { '/link/ws/scripts/wp1/fetch-ledger-commit.mjs': self }
    const real = (p: string) => {
      const n = p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
      if (n === self || n.startsWith('/elsewhere/') || n.startsWith('/repo/')) return n
      if (links[n]) return links[n]
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    }
    expect(invocation(self, self, real)).toEqual({ as: 'main' })
    expect(invocation(self, '/link/ws/scripts/wp1/fetch-ledger-commit.mjs', real)).toEqual({ as: 'main' })
    expect(invocation(self, undefined, real)).toEqual({ as: 'imported' })
    expect(invocation(self, '/repo/node_modules/vitest/vitest.mjs', real)).toEqual({ as: 'imported' })
    for (const other of ['/elsewhere/fetch-ledger-commit.mjs', '/gone/scripts/wp1/fetch-ledger-commit.mjs']) {
      expect(invocation(self, other, real), other).toMatchObject({ as: 'unknown', error: expect.stringMatching(/does not resolve to this script/) })
    }
  })

  // [host] suiteSteps reads a workflow's steps that run the suite, with the
  // WP1_PHASE each one's own env gives it (injected text; nothing spawned).
  it('[host] suiteSteps finds every step that runs the suite, with the WP1_PHASE its own env gives it', () => {
    const yml = [
      'jobs:',
      '  a:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - os: x',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '      # npx vitest run (a comment never counts)',
      '      - name: Rebuild',
      '        run: node -e "1"',
      '      - name: Run tests',
      '        env:',
      `          WP1_PHASE: ${RELEASE_WP1_PHASE}`,
      '        run: npx vitest run',
      '  b:',
      '    steps:',
      '      - name: Native',
      '        run: |',
      '          npm run test:unit:native',
      '      - run: npx vitest run --config x',
      '        env:',
      "          WP1_PHASE: 'candidate'",
      '      - name: Build',
      '        run: npm run build',
    ].join('\n')
    const want = [
      { job: 'a', name: 'Run tests', phase: RELEASE_WP1_PHASE },
      { job: 'b', name: 'Native', phase: null },
      { job: 'b', name: '(unnamed)', phase: 'candidate' },
    ]
    expect(suiteSteps(yml)).toEqual(want)
    expect(suiteSteps(yml.replace(/\n/g, '\r\n'))).toEqual(want)
    expect(suiteSteps(yml.replace(`          WP1_PHASE: ${RELEASE_WP1_PHASE}\n`, ''))[0]).toEqual({ job: 'a', name: 'Run tests', phase: null })
  })

  // [host] The candidate check cannot be switched off by a neutral manifest
  // edit where it must run (PR 4, P4.10 review): `phase` is a field of the
  // manifest, a neutral path, so the stable release declares the candidate
  // phase in the environment of every step that runs the suite, and
  // ./phase.ts lets the environment only raise the phase.
  it('[host] a stable release runs the candidate check whatever the manifest declares', () => {
    const steps = suiteSteps(readFileSync(resolve(ROOT, '.github/workflows/release.yml'), 'utf8'))
    expect(steps.map((s) => s.job)).toEqual(expect.arrayContaining(['build-windows', 'build-linux']))
    for (const s of steps) expect(s.phase, `release.yml ${s.job}, "${s.name}"`).toBe(RELEASE_WP1_PHASE)
    const saved = process.env.WP1_PHASE
    try {
      process.env.WP1_PHASE = 'candidate'
      expect(resolvePhaseDetailed(undefined, { eager: false })).toEqual({ phase: 'candidate', reason: 'WP1_PHASE=candidate in the environment' })
      process.env.WP1_PHASE = ''
      expect(resolvePhaseDetailed(undefined, { eager: false }).reason).not.toMatch(/environment/)
    } finally {
      if (saved === undefined) delete process.env.WP1_PHASE
      else process.env.WP1_PHASE = saved
    }
  })

  // [host] ADR-026: 'unavailable' records a part of an item's evidence that
  // cannot be taken (a second identity, or a consent the owner does not give),
  // on the owner's decision recorded in this repository. Files are injected;
  // nothing is read or spawned. A record that passes, then each rule broken
  // on its own.
  const OD = 'docs/wp1/owner-decisions-2099-01-01.md'
  const KS = 'docs/wp1/evidence/keyring-smoke.md'
  const OD_TEXT = [
    '# Owner decisions, 2099-01-01', '',
    '## Q2. Something else', '', 'WP1.63 and WP1.20 are decided here, not under Q3.', '',
    '## Q3. Consents', '', 'The second identity is consented for the Windows test VM only, so the macOS and Linux parts of WP1.11 are unavailable.', '',
    '## Q4. Later', '', 'WP1.2 and WP1.64: the disposable identity is Unavailable.', '',
    '## Q5. Evidenced', '', 'WP1.11 was evidenced in full.', '',
    '```', '## Q6. In a code fence', '', 'WP1.11 is unavailable.', '```', '',
    '<!--', '## Q7. In a comment', '', 'WP1.11 is unavailable.', '-->', '',
    '```', '~~~', '## Q8. Still in the code fence: a ~~~ line does not close a ``` fence', '', 'WP1.11 is unavailable.', '```', '',
  ].join('\n')
  function unavailableFixture(over: Record<string, unknown> = {}, record: Record<string, unknown> = {}) {
    const unavailable = { reason: 'the second identity is consented for the Windows test VM only', decision: `${OD}#Q3`, ...record }
    const files: Record<string, string> = {
      [OD]: OD_TEXT,
      [KS]: `Taken at ${'a'.repeat(40)}. The macOS and Linux second-identity parts were not taken (${String(unavailable.decision)}).`,
    }
    const item = { id: 'WP1.11', kind: 'real-cli', status: 'unavailable', tests: ['tests/wp1/fake-keyring.test.ts'], evidence: [KS], unavailable, ...over }
    return { item, files, textOf: (p: string) => (p in files ? files[p] : null) }
  }
  const problemsOf = (over: Record<string, unknown> = {}, record: Record<string, unknown> = {}) => {
    const f = unavailableFixture(over, record)
    return unavailableProblems([f.item], f.textOf)
  }

  it('[host] \'unavailable\' is open to eight named real-cli and packaged items only: never an automated, ci or document item, nor WP1.71', () => {
    expect([...UNAVAILABLE_ELIGIBLE]).toEqual(['WP1.2', 'WP1.10', 'WP1.11', 'WP1.20', 'WP1.32', 'WP1.63', 'WP1.64', 'WP1.72'])
    for (const id of UNAVAILABLE_ELIGIBLE) expect(['real-cli', 'packaged'], `${id} kind`).toContain(byId.get(id)?.kind)
    for (const i of manifest.items) if (['automated', 'ci', 'document'].includes(i.kind)) expect(UNAVAILABLE_ELIGIBLE, i.id).not.toContain(i.id)
    expect(UNAVAILABLE_ELIGIBLE).not.toContain('WP1.71')
    // Every manifest item, given an otherwise sound record: the eight pass,
    // every other one is refused by its id, whatever its kind.
    const decision = `${OD}#Q3`
    const files: Record<string, string> = { [OD]: `## Q3. All\n\n${manifest.items.map((i) => i.id).join(' ')} unavailable\n`, [KS]: `not taken: ${decision}` }
    for (const i of manifest.items) {
      const problems = unavailableProblems(
        [{ ...i, status: 'unavailable', evidence: [KS], unavailable: { reason: 'cannot be taken on this host, by owner decision', decision } }],
        (p) => files[p] ?? null,
      )
      if (UNAVAILABLE_ELIGIBLE.includes(i.id)) expect(problems, i.id).toEqual([])
      else expect(problems, i.id).toEqual([`${i.id} (${i.kind}) may not be unavailable: only ${UNAVAILABLE_ELIGIBLE.join(', ')} may (ADR-026)`])
    }
    // A listed item whose kind was edited to another kind is refused as well.
    expect(problemsOf({ kind: 'automated' })).toEqual(['WP1.11: an unavailable item must be real-cli or packaged, not automated'])
  })

  it('[host] an \'unavailable\' item gives a reason of 20 characters or more and an owner decision recorded in docs/wp1 whose section names it, and its evidence record cites that decision', () => {
    expect(problemsOf()).toEqual([])
    // The reason: 20 characters or more, the spaces around it not counted.
    const REASON = 'WP1.11: an unavailable item needs a reason of at least 20 characters: what could not be taken, and why'
    expect(problemsOf({}, { reason: 'x'.repeat(20) })).toEqual([])
    for (const reason of ['x'.repeat(19), `  ${'x'.repeat(19)}  `, '', undefined, 42]) expect(problemsOf({}, { reason }), String(reason)).toEqual([REASON])
    // The decision: a dated owner-decisions record under docs/wp1, and the ID its section heading starts with.
    const FORMAT = 'WP1.11: an unavailable item needs decision "docs/wp1/owner-decisions-YYYY-MM-DD.md#<ID>", the owner decision recorded in this repository'
    for (const decision of ['aicc_planning#286', OD, `${OD}#`, `${OD}#Q3.`, `${OD}#3`, `/${OD}#Q3`, `./${OD}#Q3`, 'docs/wp1/../wp1/owner-decisions-2099-01-01.md#Q3',
      'docs/owner-decisions-2099-01-01.md#Q3', 'docs/wp1/evidence/owner-decisions-2099-01-01.md#Q3', 'docs/wp1/owner-decisions-2099-1-1.md#Q3', undefined, 7]) {
      expect(problemsOf({}, { decision }), String(decision)).toEqual([FORMAT])
    }
    expect(problemsOf({ unavailable: undefined })).toEqual([REASON, FORMAT])
    expect(problemsOf({ unavailable: 'not taken' })).toEqual([REASON, FORMAT])
    // The decision file must be there, with a "## <ID>" heading whose own section names the item.
    expect(problemsOf({}, { decision: 'docs/wp1/owner-decisions-2099-01-02.md#Q3' })).toEqual(['WP1.11: the decision file docs/wp1/owner-decisions-2099-01-02.md is not there'])
    expect(problemsOf({}, { decision: `${OD}#Q9` })).toEqual([`WP1.11: ${OD} has no "## Q9" heading`])
    expect(problemsOf({}, { decision: `${OD}#Q` })).toEqual([`WP1.11: ${OD} has no "## Q" heading`])
    expect(problemsOf({}, { decision: `${OD}#Q2` })).toEqual([`WP1.11: section Q2 of ${OD} does not name WP1.11`])
    // WP1.20 is not WP1.2, and WP1.2 named in Q4 does not count for Q2.
    expect(problemsOf({ id: 'WP1.2' }, { decision: `${OD}#Q2` })).toEqual([`WP1.2: section Q2 of ${OD} does not name WP1.2`])
    expect(problemsOf({ id: 'WP1.2' }, { decision: `${OD}#Q4` })).toEqual([])
    expect(problemsOf({ id: 'WP1.64' }, { decision: `${OD}#Q4` })).toEqual([])
    // The section says what is unavailable, and a heading in a code fence or an HTML comment is no section.
    expect(problemsOf({}, { decision: `${OD}#Q5` })).toEqual([`WP1.11: section Q5 of ${OD} does not say what is unavailable`])
    expect(problemsOf({}, { decision: `${OD}#Q6` })).toEqual([`WP1.11: ${OD} has no "## Q6" heading`])
    expect(problemsOf({}, { decision: `${OD}#Q7` })).toEqual([`WP1.11: ${OD} has no "## Q7" heading`])
    expect(problemsOf({}, { decision: `${OD}#Q8` })).toEqual([`WP1.11: ${OD} has no "## Q8" heading`])
    // A CRLF file reads the same.
    const crlf = unavailableFixture()
    crlf.files[OD] = OD_TEXT.replace(/\n/g, '\r\n')
    expect(unavailableProblems([crlf.item], crlf.textOf)).toEqual([])
    // Its evidence: a docs/wp1/evidence record, one of which cites the decision.
    const RECORD = 'WP1.11: an unavailable item needs a docs/wp1/evidence/ record, which says what was not taken'
    expect(problemsOf({ evidence: [] })).toEqual([RECORD])
    expect(problemsOf({ evidence: ['tests/wp1/legacy-codex-ledger.json', 'docs/wp1/baseline-2026-09-19.md'] })).toEqual([RECORD])
    const silent = unavailableFixture()
    silent.files[KS] = `Taken at ${'a'.repeat(40)}. The macOS and Linux parts were not taken.`
    expect(unavailableProblems([silent.item], silent.textOf)).toEqual([`WP1.11: none of its evidence records (${KS}) cites ${OD}#Q3: say there what was not taken, and cite the decision`])
    // The reference whole: citing Q30 (or Q3-b) is not citing Q3; Q3 then a full stop or a bracket is.
    for (const cited of [`${OD}#Q30`, `${OD}#Q3-b`, `${OD}#Q3a`]) {
      const other = unavailableFixture()
      other.files[KS] = `Taken at ${'a'.repeat(40)}. The macOS and Linux parts were not taken (${cited}).`
      expect(unavailableProblems([other.item], other.textOf), cited).toEqual([`WP1.11: none of its evidence records (${KS}) cites ${OD}#Q3: say there what was not taken, and cite the decision`])
    }
    for (const cited of [`${OD}#Q3.`, `[Q3](${OD}#Q3)`, `${OD}#Q3`]) {
      const whole = unavailableFixture()
      whole.files[KS] = `Taken at ${'a'.repeat(40)}. Not taken: ${cited}`
      expect(unavailableProblems([whole.item], whole.textOf), cited).toEqual([])
    }
    // Q3 then an underscore or a sub-number is another reference, not Q3.
    for (const cited of [`${OD}#Q3_x`, `${OD}#Q3.2`]) {
      const other = unavailableFixture()
      other.files[KS] = `Taken at ${'a'.repeat(40)}. The macOS and Linux parts were not taken (${cited}).`
      expect(unavailableProblems([other.item], other.textOf), cited).toEqual([`WP1.11: none of its evidence records (${KS}) cites ${OD}#Q3: say there what was not taken, and cite the decision`])
    }
    // A citation a reader of the record cannot see does not count: inside an
    // HTML comment, or after one that is never closed.
    for (const hidden of [`<!-- ${OD}#Q3 -->`, `<!-- not taken: ${OD}#Q3`]) {
      const h = unavailableFixture()
      h.files[KS] = `Taken at ${'a'.repeat(40)}. The macOS and Linux parts were not taken. ${hidden}`
      expect(unavailableProblems([h.item], h.textOf), hidden).toEqual([`WP1.11: none of its evidence records (${KS}) cites ${OD}#Q3: say there what was not taken, and cite the decision`])
    }
    expect(problemsOf({ evidence: ['docs/wp1/evidence/missing.md'] })).toEqual([`WP1.11: none of its evidence records (docs/wp1/evidence/missing.md) cites ${OD}#Q3: say there what was not taken, and cite the decision`])
    expect(problemsOf({ evidence: ['docs/wp1/evidence/missing.md', KS] })).toEqual([])
    // An unavailable record on an item that is not unavailable is refused, so
    // a status flipped back never leaves a stale gap on record.
    for (const status of ['evidenced', 'planned']) {
      expect(problemsOf({ status }), status).toEqual([`WP1.11: carries an unavailable record, but its status is ${status}: remove the record, or set the status to unavailable`])
    }
    expect(unavailableProblems([{ id: 'WP1.11', kind: 'real-cli', status: 'evidenced', evidence: [KS] }], () => null)).toEqual([])
    expect(unavailableProblems([{ id: 'WP1.3', kind: 'automated', status: 'planned', evidence: [] }], () => null)).toEqual([])
  })

  it('[host] the candidate check counts \'evidenced\' and \'unavailable\' as recorded, and still refuses \'planned\' and any other status', () => {
    expect([...ITEM_STATUSES]).toEqual(['planned', 'evidenced', 'unavailable'])
    const items = [
      { id: 'WP1.1', status: 'evidenced' }, { id: 'WP1.11', status: 'unavailable' }, { id: 'WP1.3', status: 'planned' },
      { id: 'WP1.4', status: 'Evidenced' }, { id: 'WP1.5', status: 'unavailable ' }, { id: 'WP1.6', status: 'waived' }, { id: 'WP1.7' },
      // Not on the list: refused by the candidate check itself, not only by the eligibility case.
      { id: 'WP1.8', status: 'unavailable' }, { id: 'WP1.71', status: 'unavailable' },
    ]
    expect(incompleteItems(items)).toEqual(['WP1.3', 'WP1.4', 'WP1.5', 'WP1.6', 'WP1.7', 'WP1.8', 'WP1.71'])
    for (const id of UNAVAILABLE_ELIGIBLE) expect(incompleteItems([{ id, status: 'unavailable' }]), id).toEqual([])
    expect(unavailableIds(items)).toEqual(['WP1.11', 'WP1.8', 'WP1.71'])
    // An unavailable item's evidence is bound like any other: taken at boundHead.
    const X = 'a'.repeat(40)
    const D = 'd'.repeat(40)
    expect(staleRecords([{ id: 'WP1.11', evidenceRecords: [{ artifact: KS, head: X }] }], D, () => `head ${X}`)).toEqual([`WP1.11: ${KS} was taken at ${X}, not at boundHead ${D}`])
    // The other readers of the manifest read only their own field.
    expect(readBoundHead(JSON.stringify({ boundHead: D, items: [{ id: 'WP1.11', status: 'unavailable' }] }))).toEqual({ sha: D })
  })

  it('every \'unavailable\' item in the manifest keeps the rules of ADR-026, in every phase', () => {
    const problems = unavailableProblems(manifest.items, (p) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : null))
    expect(problems, problems.join('\n')).toEqual([])
  })

  // At the candidate phase the case prints the unavailable items on stdout,
  // which vitest's default reporter shows for a passing case too (it shows a
  // passing case's title only when the case is slow), so the stable run's log
  // lists them at go. The title names them as well, for a failing run.
  const unavailable = unavailableIds(manifest.items)
  it(`candidate phase: nothing is still planned (unavailable on a recorded owner decision: ${unavailable.join(', ') || 'none'}), every evidence record was taken at boundHead, and boundHead is an ancestor of HEAD with only neutral paths changed since (phase ${phase}: ${reason})`, () => {
    if (phase !== 'candidate') return
    console.info(`WP1 candidate: unavailable on a recorded owner decision: ${unavailable.join(', ') || 'none'}`)
    const planned = incompleteItems(manifest.items)
    expect(planned, `items neither evidenced nor unavailable at candidate phase: ${planned.join(', ')}`).toEqual([])
    expect(manifest.boundHead).toMatch(SHA_RE)
    const bound = manifest.boundHead!
    const stale = staleRecords(manifest.items, bound, (a) => readFileSync(resolve(ROOT, a), 'utf8'))
    expect(stale, `evidence not taken at boundHead; retake it there, or bind to the head it was taken at:\n${stale.join('\n')}`).toEqual([])
    const verdict = ancestry(git, bound)
    expect(verdict, `shallow clone: the history between boundHead ${bound} and HEAD is not here; run node scripts/wp1/fetch-ledger-commit.mjs first`).not.toBe('undecidable')
    expect(verdict, `boundHead ${bound} is not an ancestor of HEAD`).toBe('ancestor')
    const breaks = bindingBreaks(changedPaths(git, bound))
    expect(breaks, `changed after evidence collection; regenerate the affected records:\n${breaks.join('\n')}`).toEqual([])
  })
})
