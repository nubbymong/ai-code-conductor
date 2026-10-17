// WP1.70 / WP1.73: bidirectional traceability between the 73 acceptance items
// and the tests/evidence that prove them. Structural rules apply in every
// phase (an `unavailable` item's rules among them, ADR-026); completeness
// rules (every item evidenced or, on a recorded owner decision, unavailable;
// every evidence record digest-bound and taken at boundHead, an ancestor of
// HEAD with nothing but neutral paths changed since, or a carry-forward
// declaration that holds (ADR-027): ./binding.ts) apply once the phase is
// DECLARED candidate (env or manifest; see ./phase.ts).
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolvePhaseDetailed } from './phase'
import {
  ITEM_STATUSES, MANIFEST_PATH, RELEASE_WP1_PHASE, SHA_RE, UNAVAILABLE_ELIGIBLE, ancestry, bindingBreaks, changedPaths, evidenceProblems, incompleteItems, staleRecords,
  suiteSteps, unavailableIds, unavailableProblems, type EvidenceRecord, type Git, type ItemStatus, type Unavailable,
  CARRY_FORWARD_PATH, CARRY_FORWARD_SCHEMA, CARRY_FORWARD_MAX_PATHS, CARRY_FORWARD_MAX_SHIPPED_LINES, BINDING_NEUTRAL, NATIVE_TEST, RUNNABLE_TEST,
  bindingVerdict, carryForwardProblems, changedLines, fileAt,
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
// The version being cut, and the carry-forward declaration (ADR-027), null
// when there is none: read once, so the candidate case judges what is here.
const pkgVersion = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const carryText = existsSync(resolve(ROOT, CARRY_FORWARD_PATH)) ? readFileSync(resolve(ROOT, CARRY_FORWARD_PATH), 'utf8') : null
const { phase, reason } = resolvePhaseDetailed(undefined, { eager: false })
const KINDS = new Set(['automated', 'manual-gate', 'packaged', 'real-cli', 'document', 'ci'])
// What vitest collects is RUNNABLE_TEST and not NATIVE_TEST (./binding.ts).
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
        expect((RUNNABLE_TEST.test(t) && !NATIVE_TEST.test(t)) || E2E.test(t), `${i.id}: ${t} is outside the vitest include globs and is not an e2e spec`).toBe(true)
      }
      if (i.kind === 'automated') expect(i.tests.some((t) => RUNNABLE_TEST.test(t) && !NATIVE_TEST.test(t)), `${i.id} is automated but lists no vitest-collected test`).toBe(true)
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

  // [host] ADR-027: a targeted stable patch carries the previous stable's WP1
  // evidence forward on a declared file list (tests/wp1/carry-forward.json),
  // which replaces only the final assertion of the candidate case. Git and
  // files are injected; nothing is read or spawned. A declaration that holds,
  // then each rule broken on its own.
  const CF_BASE = '9'.repeat(40)
  const CF_BOUND = 'd'.repeat(40)
  const CF_OD = 'docs/wp1/owner-decisions-2099-02-01.md'
  const CF_FIX = 'src/main/fix.ts'
  const CF_TEST = 'tests/unit/fix.test.ts'
  const CF_OTHER = 'tests/unit/other.test.ts'
  const CF_CASES = ['finds the folder the probe found', 'leaves a PATH that names it alone']
  const cfPkg = (version: string, dep = '1.0.0') => JSON.stringify({ name: 'app', version, dependencies: { x: dep } }, null, 2)
  const cfLock = (version: string, dep = '1.0.0', resolved = dep) =>
    JSON.stringify({ name: 'app', version, lockfileVersion: 3, packages: { '': { name: 'app', version, dependencies: { x: dep } }, 'node_modules/x': { version: resolved } } }, null, 2)
  const CF_SAYS = '2.1.2 ships as a stable patch: the 2.1.1 evidence is carried forward, for'
  const cfOdText = (extra: string[] = []) => [
    '# Owner decisions, 2099-02-01', '',
    '## CF1. Sound', '', CF_SAYS, [CF_FIX, 'package.json', 'package-lock.json', ...extra].map((p) => `\`${p}\``).join(', '), '',
    '## CF2. Another version', '', CF_SAYS.replace('2.1.2', '2.1.20'), `\`${CF_FIX}\`, \`package.json\`, \`package-lock.json\``, '',
    '## CF3. Not carried', '', '2.1.2 ships as a stable patch, for', `\`${CF_FIX}\`, \`package.json\`, \`package-lock.json\``, '',
    '## CF4. A path left out', '', CF_SAYS, `\`${CF_FIX}\`, \`package.json\``, '',
    '## CF5. A path only in a code fence', '', CF_SAYS, '`package.json`, `package-lock.json`', '', '```', CF_FIX, '```', '',
    '## CF6. A path only in a comment', '', CF_SAYS, '`package.json`, `package-lock.json`', `<!-- ${CF_FIX} -->`, '',
    '## CF7. A tag', '', CF_SAYS.replace('2.1.2', 'v2.1.2'), `\`${CF_FIX}\`, \`package.json\`, \`package-lock.json\``, '',
    '## CF8. A longer name', '', CF_SAYS, `\`${CF_FIX}x\`, \`tests/package.json\`, \`package-lock.json.bak\``, '',
  ].join('\n')
  const CF_TEST_TEXT = [
    "import { describe, it, test } from 'vitest'", '',
    "describe.skipIf(process.platform === 'win32')('the fix', () => {",
    `  it('${CF_CASES[0]}', () => {})`,
    `  test("${CF_CASES[1]}", (ctx) => { if (!ctx) ctx.skip() })`,
    '})', '',
  ].join('\n')
  const cfEntry = (path: string, cases = [CF_CASES[0]], file = CF_TEST) => ({ path, why: `changed for the fix: ${path}`, tests: [{ file, cases }] })
  const cfDecl = () => ({
    schema: CARRY_FORWARD_SCHEMA, targetVersion: '2.1.2',
    base: { tag: 'v2.1.1', version: '2.1.1', commit: CF_BASE, boundHead: CF_BOUND },
    reason: 'A headless run on a Mac opened from the Dock found no claude on its PATH.',
    approval: `${CF_OD}#CF1`, adversarial: { pr: 650 },
    paths: [cfEntry(CF_FIX, CF_CASES), cfEntry('package.json'), cfEntry('package-lock.json')],
  })
  type CfOptions = {
    breaks?: string[]; files?: Record<string, string | null>; show?: Record<string, string | null>
    numstat?: Record<string, string>; mergeBase?: number; shallow?: boolean; version?: string
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function cfRun(edit: (d: any) => void = () => {}, o: CfOptions = {}) {
    const d = cfDecl()
    edit(d)
    const files: Record<string, string | null> = { [CF_OD]: cfOdText(), [CF_TEST]: CF_TEST_TEXT, 'package.json': cfPkg('2.1.2'), 'package-lock.json': cfLock('2.1.2'), ...o.files }
    const show: Record<string, string | null> = {
      [`${CF_BASE}:package.json`]: cfPkg('2.1.1'), [`${CF_BASE}:${MANIFEST_PATH}`]: JSON.stringify({ phase: 'candidate', boundHead: CF_BOUND }),
      [`${CF_BOUND}:package.json`]: cfPkg('2.1.1'), [`${CF_BOUND}:package-lock.json`]: cfLock('2.1.1'), ...o.show,
    }
    const numstat: Record<string, string> = { [CF_FIX]: '40\t8', 'package.json': '1\t1', 'package-lock.json': '2\t2', ...o.numstat }
    const calls: string[][] = []
    const git: Git = (args) => {
      calls.push(args)
      if (args[0] === 'merge-base') return { status: o.mergeBase ?? 0, stdout: '' }
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return { status: 0, stdout: `${o.shallow ? 'true' : 'false'}\n` }
      if (args[0] === 'show') {
        const v = show[args[1]]
        return typeof v === 'string' ? { status: 0, stdout: v } : { status: 128, stdout: '', stderr: `fatal: invalid object name ${args[1]}` }
      }
      if (args[0] === 'diff' && args[1] === '--numstat') {
        return { status: 0, stdout: args.slice(args.indexOf('--') + 1).filter((p) => p in numstat).map((p) => `${numstat[p]}\t${p}\0`).join('') }
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    }
    const ctx = { git, boundHead: CF_BOUND, version: o.version ?? '2.1.2', breaks: o.breaks ?? [CF_FIX, 'package.json', 'package-lock.json'], textOf: (p: string) => (p in files ? files[p] : null) }
    const text = JSON.stringify(d)
    return { problems: carryForwardProblems(text, ctx), calls, ctx, text }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cf = (edit?: (d: any) => void, o?: CfOptions) => cfRun(edit, o).problems

  it('[host] carry-forward: a sound declaration holds, and with no declaration the binding is judged exactly as before', () => {
    const r = cfRun()
    expect(r.problems).toEqual([])
    // The size is read from boundHead for the declared paths outside tests/, NUL-separated, renames unpaired.
    expect(r.calls).toContainEqual(['diff', '--numstat', '--no-renames', '-z', `${CF_BOUND}..HEAD`, '--', CF_FIX, 'package.json', 'package-lock.json'])
    expect(bindingVerdict(r.ctx.breaks, r.text, r.ctx)).toEqual({ problems: [], message: 'the carry-forward declaration does not hold (ADR-027):\n', carried: true })
    // No declaration: the rule and the message of the binding before ADR-027, and nothing else is asked.
    const none = { git: (() => { throw new Error('git must not be asked') }) as Git, boundHead: CF_BOUND, version: '2.1.2', textOf: (): string | null => { throw new Error('no file may be read') } }
    expect(bindingVerdict([], null, none)).toEqual({ problems: [], message: 'changed after evidence collection; regenerate the affected records:\n', carried: false })
    expect(bindingVerdict(['src/x.ts'], null, none)).toEqual({ problems: ['src/x.ts'], message: 'changed after evidence collection; regenerate the affected records:\nsrc/x.ts', carried: false })
    // A declaration that is there is judged by its own rules, never read as absent.
    for (const text of ['{', '']) {
      const v = bindingVerdict([CF_FIX], text, none)
      expect(v.problems, JSON.stringify(text)).toEqual([expect.stringMatching(/^tests\/wp1\/carry-forward\.json is not valid JSON: /)])
      expect(v.carried).toBe(false)
      expect(v.message).toMatch(/^the carry-forward declaration does not hold \(ADR-027\):\ntests\/wp1\/carry-forward\.json is not valid JSON/)
    }
    expect(bindingVerdict([], r.text, r.ctx).problems).toEqual([`${CF_FIX} is declared but not changed after boundHead`, 'package.json is declared but not changed after boundHead', 'package-lock.json is declared but not changed after boundHead'])
  })

  it('[host] carry-forward: valid JSON of its schema, for the version package.json names, the patch after a stable base of the same line', () => {
    const { ctx } = cfRun()
    expect(carryForwardProblems('{', ctx)).toEqual([expect.stringMatching(/^tests\/wp1\/carry-forward\.json is not valid JSON: /)])
    for (const text of ['null', '[]', '"x"', '7', '{}', JSON.stringify({ ...cfDecl(), schema: 'wp1-carry-forward/2' })]) {
      expect(carryForwardProblems(text, ctx), text).toEqual([`${CARRY_FORWARD_PATH}: schema must be ${CARRY_FORWARD_SCHEMA}`])
    }
    // Stale: left in place past its release, or reused for the next one.
    for (const version of ['2.2.0', '2.1.3', '2.1.2-beta.1']) {
      expect(cf(undefined, { version }), version).toEqual([`${CARRY_FORWARD_PATH} carries forward to 2.1.2, but package.json is ${version}: it is stale, delete it`])
    }
    // A minor or a major bump, a skipped patch, no bump at all.
    for (const t of ['2.2.0', '3.0.0', '2.1.3', '2.1.1', '2.0.2']) expect(cf((d) => { d.targetVersion = t }, { version: t }), t).toContainEqual(`${t} is not the patch after 2.1.1`)
    expect(cf((d) => { d.base.version = '2.0.1'; d.base.tag = 'v2.0.1' })).toContainEqual('2.1.2 is not the patch after 2.0.1')
    // A prerelease, at either end.
    expect(cf((d) => { d.targetVersion = '2.1.2-rc.1' }, { version: '2.1.2-rc.1' })).toContainEqual('targetVersion and base.version must be stable x.y.z versions, not 2.1.2-rc.1 and 2.1.1')
    expect(cf((d) => { d.base.version = '2.1.1-rc.3'; d.base.tag = 'v2.1.1-rc.3' })).toContainEqual('targetVersion and base.version must be stable x.y.z versions, not 2.1.2 and 2.1.1-rc.3')
    // The tag is the base version with its v.
    for (const tag of ['2.1.1', 'v2.1.0', 'v2.1.1-beta', undefined]) expect(cf((d) => { d.base.tag = tag }), String(tag)).toEqual([`base.tag must be v2.1.1, not ${tag}`])
  })

  it('[host] carry-forward: the base is the previous stable, an ancestor of HEAD, bound to the same boundHead', () => {
    const E = 'e'.repeat(40)
    expect(cf((d) => { d.base.boundHead = E })).toEqual([`base.boundHead ${E} is not the boundHead of the manifest, ${CF_BOUND}`])
    // Not an ancestor, in a full clone; undecidable in a shallow one.
    expect(cf(undefined, { mergeBase: 1 })).toEqual([`base.commit ${CF_BASE} is not an ancestor of HEAD`])
    expect(cf(undefined, { mergeBase: 128 })).toEqual([`base.commit ${CF_BASE} is not an ancestor of HEAD`])
    expect(cf(undefined, { mergeBase: 128, shallow: true })).toEqual([`base.commit ${CF_BASE}: its ancestry is not decidable here; run node scripts/wp1/fetch-ledger-commit.mjs first`])
    // A commit id git never sees unless it is one.
    for (const commit of ['HEAD', '--upload-pack=x', '9'.repeat(39), `${CF_BASE}\n`, 42, undefined]) {
      const r = cfRun((d) => { d.base.commit = commit })
      expect(r.problems, String(commit)).toEqual(['base.commit is not a 40-hex commit id'])
      expect(r.calls.some((c) => c[0] === 'merge-base' || (c[0] === 'show' && !c[1].startsWith(CF_BOUND))), String(commit)).toBe(false)
    }
    // The base is the release whose evidence is carried: its version, and its manifest a candidate bound to this boundHead.
    for (const pkg of [cfPkg('2.1.0'), null, '{']) {
      expect(cf(undefined, { show: { [`${CF_BASE}:package.json`]: pkg } }), String(pkg)).toEqual([`package.json at ${CF_BASE} is not version 2.1.1`])
    }
    for (const man of [JSON.stringify({ phase: 'gate0', boundHead: CF_BOUND }), JSON.stringify({ phase: 'candidate', boundHead: E }), JSON.stringify({ phase: 'candidate', boundHead: null }), null, '{']) {
      expect(cf(undefined, { show: { [`${CF_BASE}:${MANIFEST_PATH}`]: man } }), String(man)).toEqual([`${MANIFEST_PATH} at ${CF_BASE} is not a candidate bound to ${CF_BOUND}`])
    }
  })

  it('[host] carry-forward: the list is exact, every changed path declared and nothing else, each an exact path that breaks the binding, at most 16', () => {
    const all = [CF_FIX, 'package.json', 'package-lock.json']
    // An undeclared path, and a padded one.
    expect(cf(undefined, { breaks: [...all, 'src/main/pty-manager.ts'] })).toEqual(['src/main/pty-manager.ts changed after boundHead and is not declared'])
    expect(cf((d) => { d.paths.push(cfEntry('src/main/index.ts')) }, { files: { [CF_OD]: cfOdText(['src/main/index.ts']) } })).toEqual(['src/main/index.ts is declared but not changed after boundHead'])
    // A neutral path cannot pad the list, even one the list of changed paths names.
    for (const p of ['docs/x.md', 'CONTEXT.d/x.md', 'README.md', MANIFEST_PATH]) {
      expect(cf((d) => { d.paths.push(cfEntry(p)) }, { breaks: [...all, p], files: { [CF_OD]: cfOdText([p]) } }), p).toEqual([`${p} is binding-neutral; declare only paths that break the binding`])
    }
    // Only an exact repository path, each once.
    for (const p of ['src/*.ts', 'src/main/fix.ts?', 'src/[a]/x.ts', 'src/../x.ts', './src/main/fix.ts', 'src/./x.ts', 'src\\main\\fix.ts', '/src/main/fix.ts', 'src/main/fix.ts ', ':(glob)src', '', 7, null]) {
      expect(cf((d) => { d.paths.push(cfEntry(p as string)) }, { breaks: [...all, String(p)] }), String(p)).toContainEqual(`${String(p)}: not an exact repository path`)
    }
    expect(cf((d) => { d.paths.push(cfEntry(CF_FIX)) })).toEqual(['paths lists a file twice'])
    // At most 16, and at least one.
    const many = (n: number) => Array.from({ length: n }, (_, i) => `src/main/f${i}.ts`)
    expect(cf((d) => { d.paths = many(16).map((p) => cfEntry(p)) }, { breaks: many(16), files: { [CF_OD]: cfOdText(many(16)) } })).toEqual([])
    expect(cf((d) => { d.paths = many(17).map((p) => cfEntry(p)) }, { breaks: many(17), files: { [CF_OD]: cfOdText(many(17)) } })).toEqual([`paths must list 1 to ${CARRY_FORWARD_MAX_PATHS} files`])
    for (const paths of [[], undefined, 'src/main/fix.ts', {}]) expect(cf((d) => { d.paths = paths }, { breaks: [] }), JSON.stringify(paths)).toEqual([`paths must list 1 to ${CARRY_FORWARD_MAX_PATHS} files`])
  })

  it('[host] carry-forward: each declared path names a regression test vitest collects, and case titles found in its code', () => {
    const other = (content: string, cases = [CF_CASES[0]], file = CF_OTHER) => cf((d) => { d.paths[0].tests = [{ file, cases }] }, { files: { [file]: content } })
    const NO_CASE = (c = CF_CASES[0], file = CF_OTHER) => `${CF_FIX}: ${file} has no it( or test( case titled "${c}"`
    const SKIPS = `${CF_FIX}: ${CF_OTHER} skips, todos or focuses a case unconditionally`
    expect(cf((d) => { d.paths[0].why = 'the fix' })).toEqual([`${CF_FIX}: why must say in 10 characters or more why it changed`])
    expect(cf((d) => { d.paths[0].why = `   ${'x'.repeat(9)}   ` })).toEqual([`${CF_FIX}: why must say in 10 characters or more why it changed`])
    for (const tests of [[], undefined, 'tests/unit/fix.test.ts']) expect(cf((d) => { d.paths[0].tests = tests }), JSON.stringify(tests)).toEqual([`${CF_FIX}: names no regression test`])
    // A file vitest collects, there and not empty.
    expect(other('', undefined, 'tests/unit/missing.test.ts').length).toBe(1)
    expect(cf((d) => { d.paths[0].tests = [{ file: 'tests/unit/missing.test.ts', cases: [CF_CASES[0]] }] })).toEqual([`${CF_FIX}: tests/unit/missing.test.ts is missing or empty`])
    expect(other(' \n\n')).toEqual([`${CF_FIX}: ${CF_OTHER} is missing or empty`])
    for (const file of ['tests/e2e/fix.spec.ts', 'tests/unit/fix.native.test.ts', 'tests/integration/fix.test.tsx', 'tests/unit/../../x.test.ts', 'tests/unit/fix.ts', CF_FIX, 'tests\\unit\\fix.test.ts']) {
      expect(other(CF_TEST_TEXT, undefined, file), file).toEqual([`${CF_FIX}: ${file} is not a test vitest collects`])
    }
    // Each case is the title of a bare it( or test( call in the code, not in a comment or a string.
    expect(cf((d) => { d.paths[0].tests[0].cases = ['a case that is not there'] })).toEqual([NO_CASE('a case that is not there', CF_TEST)])
    expect(cf((d) => { d.paths[0].tests[0].cases = [] })).toEqual([`${CF_FIX}: ${CF_TEST} names no case`])
    const real = `it('${CF_CASES[1]}', () => {})`
    for (const hidden of [`// it('${CF_CASES[0]}', () => {})`, `/* it('${CF_CASES[0]}', () => {}) */`, `const s = "it('${CF_CASES[0]}', () => {})"`,
      `const s = \`it('${CF_CASES[0]}')\``, `it.each([1])('${CF_CASES[0]}', () => {})`, `ctx.it('${CF_CASES[0]}', () => {})`, `it(\`${CF_CASES[0]} \${1}\`, () => {})`]) {
      expect(other([real, hidden, ''].join('\n')), hidden).toEqual([NO_CASE()])
    }
    for (const shown of [`it('${CF_CASES[0]}', () => {})`, `test("${CF_CASES[0]}", () => {})`, `it(\`${CF_CASES[0]}\`, () => {})`, `it (\n  '${CF_CASES[0]}', () => {})`,
      `const re = /['"\`]/\nit('${CF_CASES[0]}', () => {})`, `const s = \`\${'x'}\`\nit('${CF_CASES[0]}', () => {})`, `// it.skip(\nit('${CF_CASES[0]}', () => {})`,
      `describe.runIf(true)('x', () => { it.skipIf(false)('y', () => {}) })\nit('${CF_CASES[0]}', () => {})`]) {
      expect(other(shown), shown).toEqual([])
    }
    // No unconditional skip, todo or focus anywhere in the code of the file.
    expect(other(`it.skip('${CF_CASES[0]}', () => {})`)).toEqual([SKIPS, NO_CASE()])
    for (const skip of ["describe.skip('x', () => {})", "it.only('x', () => {})", "test.todo('x')", "xit('x', () => {})", "xdescribe('x', () => {})",
      "it.skip.each([1])('x', () => {})", "describe.concurrent.skip('x', () => {})", "test.only.each([1])('x', () => {})"]) {
      expect(other(`${skip}\nit('${CF_CASES[0]}', () => {})`), skip).toEqual([SKIPS])
    }
    // A title is plain text: 8 characters or more, no quote, backtick, backslash or newline.
    for (const c of ["it's the fix", 'say "the fix"', 'a `tick` case', 'a back\\slash case', 'two\nlines here', 'short', 7]) {
      expect(cf((d) => { d.paths[0].tests[0].cases = [c] }), String(c)).toEqual([`${CF_FIX}: ${JSON.stringify(c)} is not a case title (8 characters or more, with no quote, backtick, backslash or newline)`])
    }
  })

  it('[host] carry-forward: package files may change only their version, and at most 400 lines outside tests carry forward', () => {
    expect(cf(undefined, { files: { 'package.json': cfPkg('2.1.2', '2.0.0') } })).toEqual(['package.json changed more than its version since boundHead'])
    expect(cf(undefined, { files: { 'package-lock.json': cfLock('2.1.2', '1.0.0', '1.0.1') } })).toEqual(['package-lock.json changed more than its version since boundHead'])
    expect(cf(undefined, { files: { 'package-lock.json': cfLock('2.1.2', '^1.0.0') } })).toEqual(['package-lock.json changed more than its version since boundHead'])
    for (const after of [null, '{', '']) expect(cf(undefined, { files: { 'package.json': after } }), String(after)).toEqual(['package.json changed more than its version since boundHead'])
    for (const before of [null, '{']) expect(cf(undefined, { show: { [`${CF_BOUND}:package-lock.json`]: before } }), String(before)).toEqual(['package-lock.json changed more than its version since boundHead'])
    // The version-only rule compares whole documents: key order does not matter, every other field does.
    expect(cf(undefined, { files: { 'package.json': JSON.stringify({ dependencies: { x: '1.0.0' }, version: '2.1.2', name: 'app' }) } })).toEqual([])
    // Lines added and deleted outside tests/, since boundHead.
    expect(cf(undefined, { numstat: { [CF_FIX]: '390\t4' } })).toEqual([])
    expect(cf(undefined, { numstat: { [CF_FIX]: '390\t5' } })).toEqual([`401 lines changed outside tests/ since boundHead; at most ${CARRY_FORWARD_MAX_SHIPPED_LINES} carry forward`])
    expect(cf(undefined, { numstat: { [CF_FIX]: '-\t-' } })).toEqual(['a declared file outside tests/ is binary'])
    // Tests are not shipped: 10,000 lines under tests/ count for nothing.
    const r = cfRun((d) => { d.paths.push(cfEntry(CF_TEST)) }, { breaks: [CF_FIX, 'package.json', 'package-lock.json', CF_TEST], numstat: { [CF_TEST]: '9000\t1000' }, files: { [CF_OD]: cfOdText([CF_TEST]) } })
    expect(r.problems).toEqual([])
    expect(r.calls).toContainEqual(['diff', '--numstat', '--no-renames', '-z', `${CF_BOUND}..HEAD`, '--', CF_FIX, 'package.json', 'package-lock.json'])
  })

  it('[host] carry-forward: a reason, an owner decision that names the version, says carry forward and names every declared path, and an ADR-009 PR', () => {
    for (const reason of ['too short', `   ${'x'.repeat(39)}   `, '', undefined, 42]) expect(cf((d) => { d.reason = reason }), String(reason)).toEqual(['reason must be 40 characters or more'])
    const FORMAT = 'approval must be "docs/wp1/owner-decisions-YYYY-MM-DD.md#<ID>", the owner decision recorded in this repository'
    for (const approval of ['CF1', CF_OD, `${CF_OD}#`, `${CF_OD}#1`, `/${CF_OD}#CF1`, 'docs/wp1/../wp1/owner-decisions-2099-02-01.md#CF1', 'docs/owner-decisions-2099-02-01.md#CF1', undefined, 7]) {
      expect(cf((d) => { d.approval = approval }), String(approval)).toEqual([FORMAT])
    }
    expect(cf((d) => { d.approval = 'docs/wp1/owner-decisions-2099-02-02.md#CF1' })).toEqual(['the approval file docs/wp1/owner-decisions-2099-02-02.md is not there'])
    expect(cf((d) => { d.approval = `${CF_OD}#CF9` })).toEqual([`${CF_OD} has no "## CF9" heading`])
    expect(cf((d) => { d.approval = `${CF_OD}#CF` })).toEqual([`${CF_OD} has no "## CF" heading`])
    expect(cf((d) => { d.approval = `${CF_OD}#CF2` })).toEqual([`section CF2 of ${CF_OD} does not name 2.1.2`])
    expect(cf((d) => { d.approval = `${CF_OD}#CF3` })).toEqual([`section CF3 of ${CF_OD} does not say the evidence is carried forward`])
    expect(cf((d) => { d.approval = `${CF_OD}#CF4` })).toEqual([`section CF4 of ${CF_OD} does not name package-lock.json`])
    expect(cf((d) => { d.approval = `${CF_OD}#CF5` })).toEqual([`section CF5 of ${CF_OD} does not name ${CF_FIX}`])
    expect(cf((d) => { d.approval = `${CF_OD}#CF6` })).toEqual([`section CF6 of ${CF_OD} does not name ${CF_FIX}`])
    expect(cf((d) => { d.approval = `${CF_OD}#CF7` })).toEqual([])
    expect(cf((d) => { d.approval = `${CF_OD}#CF8` })).toEqual([`section CF8 of ${CF_OD} does not name ${CF_FIX}`, `section CF8 of ${CF_OD} does not name package.json`, `section CF8 of ${CF_OD} does not name package-lock.json`])
    // A CRLF file reads the same.
    expect(cf(undefined, { files: { [CF_OD]: cfOdText().replace(/\n/g, '\r\n') } })).toEqual([])
    // Every carry-forward names the PR whose ADR-009 pass covers it.
    for (const adversarial of [undefined, {}, { pr: 0 }, { pr: -1 }, { pr: 1.5 }, { pr: '650' }, { pr: null }, 650]) {
      expect(cf((d) => { d.adversarial = adversarial }), JSON.stringify(adversarial)).toEqual(['adversarial.pr must name the PR whose ADR-009 PASS covers this diff'])
    }
  })

  it('[host] carry-forward: its constants and git helpers are pinned, and the declaration itself is never neutral', () => {
    expect(CARRY_FORWARD_PATH).toBe('tests/wp1/carry-forward.json')
    expect(CARRY_FORWARD_SCHEMA).toBe('wp1-carry-forward/1')
    expect(CARRY_FORWARD_MAX_PATHS).toBe(16)
    expect(CARRY_FORWARD_MAX_SHIPPED_LINES).toBe(400)
    expect(bindingBreaks([CARRY_FORWARD_PATH])).toEqual([CARRY_FORWARD_PATH])
    // The neutral rules are the ones before ADR-027: the declaration widens nothing.
    expect(BINDING_NEUTRAL.map(String)).toEqual(['/^tests\\/wp1\\/traceability\\.json$/', '/^docs\\//', '/^CONTEXT\\.d\\//', '/^architecture\\/decisions\\/[^/]+\\.md$/', '/^[^/]+\\.md$/'])
    expect(String(RUNNABLE_TEST)).toBe(String(/^tests\/(unit|wp1)\/.+\.test\.tsx?$|^tests\/integration\/.+\.test\.ts$/))
    expect(String(NATIVE_TEST)).toBe(String(/\.native\.test\.tsx?$/))
    // changedLines: nothing asked for no paths; a binary entry is null; a failed diff throws.
    expect(changedLines(() => { throw new Error('git must not be asked') }, CF_BOUND, [])).toBe(0)
    expect(changedLines(() => ({ status: 0, stdout: ['3\t4\ta.ts', '0\t9\tc.ts', ''].join('\0') }), CF_BOUND, ['a.ts', 'c.ts'])).toBe(16)
    expect(changedLines(() => ({ status: 0, stdout: ['3\t4\ta.ts', '-\t-\tb.png', ''].join('\0') }), CF_BOUND, ['a.ts', 'b.png'])).toBeNull()
    expect(() => changedLines(() => ({ status: 128, stdout: '', stderr: 'fatal: bad revision' }), CF_BOUND, ['a.ts'])).toThrow(/exited 128/)
    // fileAt: a file at a commit, null when it is not there, and only for a 40-hex commit id.
    const shown: string[][] = []
    expect(fileAt((a) => { shown.push(a); return { status: 0, stdout: 'x' } }, CF_BOUND, 'package.json')).toBe('x')
    expect(shown).toEqual([['show', `${CF_BOUND}:package.json`]])
    expect(fileAt(() => ({ status: 128, stdout: '' }), CF_BOUND, 'package.json')).toBeNull()
    for (const sha of ['HEAD', '--output=x', `${CF_BOUND}:x`]) expect(() => fileAt(() => ({ status: 0, stdout: '' }), sha, 'a'), sha).toThrow(/40-hex/)
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
  it(`candidate phase: nothing is still planned (unavailable on a recorded owner decision: ${unavailable.join(', ') || 'none'}), every evidence record was taken at boundHead, and boundHead is an ancestor of HEAD with only neutral paths changed since (phase ${phase}: ${reason}; carry-forward: ${carryText === null ? 'none' : CARRY_FORWARD_PATH})`, () => {
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
    // With no declaration, nothing but neutral paths may have changed since
    // boundHead; with one, it must hold (ADR-027). Only this assertion is
    // replaced: everything above runs as before.
    const breaks = bindingBreaks(changedPaths(git, bound))
    const textOf = (p: string) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : null)
    const binding = bindingVerdict(breaks, carryText, { git, boundHead: bound, version: pkgVersion, textOf })
    expect(binding.problems, binding.message).toEqual([])
    if (binding.carried) console.info(`WP1 candidate: evidence carried forward from boundHead ${bound} by ${CARRY_FORWARD_PATH}: ${breaks.join(', ')}`)
  })
})
