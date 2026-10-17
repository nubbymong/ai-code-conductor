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
  CARRY_FORWARD_MAX_ADDED_LINE, CARRY_FORWARD_MAX_ADDED_BYTES, CARRY_FORWARD_GATE_FILES, DEV_ONLY_TOOLING, DEV_ONLY_TREES, addedBytes, addedLines,
  bindingVerdict, carryForwardProblems, changedLines, committedCarryForward, fileAt, isCarryForwardNeutralFile, isCountedPath, longAddedLines,
  toolingPackagingProblems, outOfSrcImports, SRC_OUTSIDE_IMPORTS_ALLOWED, builderConfigProblems, BUILDER_OVERRIDES_ALLOWED, linkEntryProblems, carryForwardRepoChecksRun,
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
// The working-tree copy is read only to compare it with HEAD's: the
// declaration that counts is the committed one (committedCarryForward).
const workingCarryText = existsSync(resolve(ROOT, CARRY_FORWARD_PATH)) ? readFileSync(resolve(ROOT, CARRY_FORWARD_PATH), 'utf8') : null
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
// The committed declaration, read once from HEAD's tree; a git failure is a problem, not an absence.
const committedCarry = (() => {
  try { return committedCarryForward(git, workingCarryText) } catch (e) { return { text: null, problems: [`could not read the committed declaration: ${String(e)}`] } }
})()

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
  // then each rule broken on its own. This file builds each skip, todo and
  // focus call it tests at run time, so its own text names none: the rule
  // searches the raw text of every named test file, this one included.
  const call = (who: string, how: string) => [who, how].join('.')
  const X = 'x'
  const CF = CARRY_FORWARD_PATH
  const CF_BASE = '9'.repeat(40)
  const CF_BOUND = 'd'.repeat(40)
  const CF_OD = 'docs/wp1/owner-decisions-2099-02-01.md'
  const CF_FIX = 'src/main/fix.ts'
  const CF_TEST = 'tests/unit/fix.test.ts'
  const CF_OTHER = 'tests/unit/other.test.ts'
  const CF_CASES = ['finds the folder the probe found', 'leaves a PATH that names it alone']
  const CF_ALL = [CF_FIX, 'package.json', 'package-lock.json', CF]
  const CF_NEUTRAL = [CF_OD, 'CHANGELOG.md', MANIFEST_PATH, 'CONTEXT.d/2099-02-01-fix.md']
  const cfPkg = (version: string, dep = '1.0.0') => JSON.stringify({ name: 'app', version, dependencies: { x: dep } }, null, 2)
  const cfLock = (version: string, dep = '1.0.0', resolved = dep) =>
    JSON.stringify({ name: 'app', version, lockfileVersion: 3, packages: { '': { name: 'app', version, dependencies: { x: dep } }, 'node_modules/x': { version: resolved } } }, null, 2)
  const CF_SAYS = '2.1.2 ships as a stable patch: the 2.1.1 evidence is carried forward, for'
  const tick = (ps: string[]) => ps.map((p) => `\`${p}\``).join(', ')
  const cfOdText = (extra: string[] = []) => [
    '# Owner decisions, 2099-02-01', '',
    '## CF1. Sound', '', CF_SAYS, tick([...CF_ALL, ...extra]), '',
    '## CF2. Another version', '', CF_SAYS.replace('2.1.2', '2.1.20'), tick(CF_ALL), '',
    // It names the declaration, whose path holds carry-forward, but never says the phrase.
    '## CF3. Not carried', '', '2.1.2 ships as a stable patch, for', tick(CF_ALL), '',
    '## CF4. A path left out', '', CF_SAYS, tick([CF_FIX, 'package.json', CF]), '',
    '## CF5. A path only in a code fence', '', CF_SAYS, tick(['package.json', 'package-lock.json', CF]), '', '```', CF_FIX, '```', '',
    '## CF6. A path only in a comment', '', CF_SAYS, tick(['package.json', 'package-lock.json', CF]), `<!-- ${CF_FIX} -->`, '',
    '## CF7. A tag', '', CF_SAYS.replace('2.1.2', 'v2.1.2'), tick(CF_ALL), '',
    '## CF8. A longer name', '', CF_SAYS, tick([`${CF_FIX}x`, 'tests/package.json', 'package-lock.json.bak', `${CF}.bak`]), '',
  ].join('\n')
  const CF_TEST_TEXT = [
    "import { describe, it, test } from 'vitest'", '',
    "describe.skipIf(process.platform === 'win32')('the fix', () => {",
    `  it('${CF_CASES[0]}', () => {})`,
    `  test("${CF_CASES[1]}", (ctx) => { if (!ctx) ctx.skip() })`,
    '})', '',
  ].join('\n')
  const cfEntry = (path: string, cases = [CF_CASES[0]], file = CF_TEST) => ({ path, why: `changed for the fix: ${path}`, tests: [{ file, cases: [...cases] }] })
  const cfDecl = () => ({
    schema: CARRY_FORWARD_SCHEMA, targetVersion: '2.1.2',
    base: { tag: 'v2.1.1', version: '2.1.1', commit: CF_BASE, boundHead: CF_BOUND },
    reason: 'A headless run on a Mac opened from the Dock found no claude on its PATH.',
    approval: `${CF_OD}#CF1`, adversarial: { pr: 650 },
    paths: [cfEntry(CF_FIX, CF_CASES), cfEntry('package.json'), cfEntry('package-lock.json'), cfEntry(CF)],
  })
  type CfOptions = {
    breaks?: string[]; changed?: string[]; files?: Record<string, string | null>; show?: Record<string, string | null>
    numstat?: Record<string, string>; patch?: Record<string, string[]>; gateTouched?: string[]; mergeBase?: number; shallow?: boolean; version?: string
    tree?: Array<[string, string]>
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
    const after = (args: string[]) => args.slice(args.indexOf('--') + 1)
    const calls: string[][] = []
    const git: Git = (args) => {
      calls.push(args)
      if (args[0] === 'merge-base') return { status: o.mergeBase ?? 0, stdout: '' }
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return { status: 0, stdout: `${o.shallow ? 'true' : 'false'}\n` }
      if (args[0] === 'show') {
        const v = show[args[1]]
        return typeof v === 'string' ? { status: 0, stdout: v } : { status: 128, stdout: '', stderr: `fatal: invalid object name ${args[1]}` }
      }
      if (args[0] === 'diff' && args[1] === '--numstat') return { status: 0, stdout: after(args).filter((p) => p in numstat).map((p) => `${numstat[p]}\t${p}\0`).join('') }
      if (args[0] === 'diff' && args[1] === '-U0') {
        const patch = (p: string) => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, '@@ -1,0 +1,1 @@', ...(o.patch?.[p] ?? ['a short line']).map((l) => `+${l}`)]
        return { status: 0, stdout: `${after(args).flatMap(patch).join('\n')}\n` }
      }
      if (args[0] === 'diff' && args[1] === '--name-only') return { status: 0, stdout: (o.gateTouched ?? []).filter((p) => after(args).includes(p)).map((p) => `${p}\0`).join('') }
      if (args[0] === 'ls-tree') {
        return { status: 0, stdout: (o.tree ?? CF_ALL.map((p): [string, string] => ['100644', p])).map(([m, p]) => `${m} ${m === '160000' ? 'commit' : 'blob'} ${'b'.repeat(40)}\t${p}\0`).join('') }
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    }
    const breaks = o.breaks ?? CF_ALL
    const ctx = { git, boundHead: CF_BOUND, version: o.version ?? '2.1.2', breaks, changed: o.changed ?? [...breaks, ...CF_NEUTRAL], textOf: (p: string) => (p in files ? files[p] : null) }
    const text = JSON.stringify(d)
    return { problems: carryForwardProblems(text, ctx), calls, ctx, text }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cf = (edit?: (d: any) => void, o?: CfOptions) => cfRun(edit, o).problems
  const COUNTED = [CF_FIX, 'package.json', 'package-lock.json']

  it('[host] carry-forward: a sound declaration holds, and with no declaration the binding is judged exactly as before', () => {
    const r = cfRun()
    expect(r.problems).toEqual([])
    // The size is read from boundHead for the counted declared paths: NUL-separated counts, renames unpaired, and the patch itself.
    expect(r.calls).toContainEqual(['diff', '--numstat', '--no-renames', '-z', `${CF_BOUND}..HEAD`, '--', ...COUNTED])
    expect(r.calls).toContainEqual(['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', `${CF_BOUND}..HEAD`, '--', ...COUNTED])
    expect(bindingVerdict(r.ctx.breaks, r.text, r.ctx)).toEqual({ problems: [], message: 'the carry-forward declaration does not hold (ADR-027):\n', carried: true })
    // No declaration: the rule and the message of the binding before ADR-027, and nothing else is asked.
    const none = { git: (() => { throw new Error('git must not be asked') }) as Git, boundHead: CF_BOUND, version: '2.1.2', changed: [], textOf: (): string | null => { throw new Error('no file may be read') } }
    expect(bindingVerdict([], null, none)).toEqual({ problems: [], message: 'changed after evidence collection; regenerate the affected records:\n', carried: false })
    expect(bindingVerdict(['src/x.ts'], null, none)).toEqual({ problems: ['src/x.ts'], message: 'changed after evidence collection; regenerate the affected records:\nsrc/x.ts', carried: false })
    // A declaration that is there is judged by its own rules, never read as absent.
    for (const text of ['{', '']) {
      const v = bindingVerdict([CF_FIX], text, none)
      expect(v.problems, JSON.stringify(text)).toEqual([expect.stringMatching(/^tests\/wp1\/carry-forward\.json is not valid JSON: /)])
      expect(v.carried).toBe(false)
      expect(v.message).toMatch(/^the carry-forward declaration does not hold \(ADR-027\):\ntests\/wp1\/carry-forward\.json is not valid JSON/)
    }
    // The declaration is itself one of the paths changed since boundHead.
    expect(bindingVerdict([], r.text, r.ctx).problems).toEqual([`${CF} is not among the paths changed since boundHead`, ...CF_ALL.map((p) => `${p} is declared but not changed after boundHead`)])
  })

  it('[host] carry-forward: valid JSON of its schema, for the version package.json names, the patch after a stable base of the same line', () => {
    const { ctx } = cfRun()
    const INVALID = expect.stringMatching(/^tests\/wp1\/carry-forward\.json is not valid JSON: /)
    expect(carryForwardProblems('{', ctx)).toEqual([INVALID])
    // A byte order mark, or merge conflict markers, are not JSON either, and the problem names the file.
    for (const text of [`${String.fromCharCode(0xfeff)}${JSON.stringify(cfDecl())}`, `<<<<<<< HEAD\n${JSON.stringify(cfDecl())}\n=======\n{}\n>>>>>>> beta\n`]) {
      expect(carryForwardProblems(text, ctx), text.slice(0, 12)).toEqual([INVALID])
    }
    for (const text of ['null', '[]', '"x"', '7', '{}', JSON.stringify({ ...cfDecl(), schema: 'wp1-carry-forward/2' })]) {
      expect(carryForwardProblems(text, ctx), text).toEqual([`${CARRY_FORWARD_PATH}: schema must be ${CARRY_FORWARD_SCHEMA}`])
    }
    // Stale: left in place past its release, or reused for the next one.
    for (const version of ['2.2.0', '2.1.3', '2.1.2-beta.1']) {
      expect(cf(undefined, { version }), version).toEqual([`${CARRY_FORWARD_PATH} carries forward to 2.1.2, but package.json is ${version}: it is stale, delete it`])
    }
    // A minor or a major bump (a major alone too), a skipped patch, no bump at all.
    for (const t of ['2.2.0', '3.0.0', '3.1.2', '2.1.3', '2.1.1', '2.0.2']) expect(cf((d) => { d.targetVersion = t }, { version: t }), t).toContainEqual(`${t} is not the patch after 2.1.1`)
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
    // An undeclared path, and a padded one.
    expect(cf(undefined, { breaks: [...CF_ALL, 'src/main/pty-manager.ts'] })).toEqual(['src/main/pty-manager.ts changed after boundHead and is not declared'])
    expect(cf((d) => { d.paths.push(cfEntry('src/main/index.ts')) }, { files: { [CF_OD]: cfOdText(['src/main/index.ts']) } })).toEqual(['src/main/index.ts is declared but not changed after boundHead'])
    // A neutral path cannot pad the list, even one the list of changed paths names.
    for (const p of ['docs/x.md', 'CONTEXT.d/x.md', 'README.md', MANIFEST_PATH]) {
      expect(cf((d) => { d.paths.push(cfEntry(p)) }, { breaks: [...CF_ALL, p], files: { [CF_OD]: cfOdText([p]) } }), p).toEqual([`${p} is binding-neutral; declare only paths that break the binding`])
    }
    // Only an exact repository path, each once.
    for (const p of ['src/*.ts', 'src/main/fix.ts?', 'src/[a]/x.ts', 'src/../x.ts', './src/main/fix.ts', 'src/./x.ts', 'src\\main\\fix.ts', '/src/main/fix.ts', 'src/main/fix.ts ', ':(glob)src', '', 7, null]) {
      expect(cf((d) => { d.paths.push(cfEntry(p as string)) }, { breaks: [...CF_ALL, String(p)] }), String(p)).toContainEqual(`${String(p)}: not an exact repository path`)
    }
    expect(cf((d) => { d.paths.push(cfEntry(CF_FIX)) })).toEqual(['paths lists a file twice'])
    // At most 16, the declaration included, and at least one.
    const many = (n: number) => Array.from({ length: n }, (_, i) => `src/main/f${i}.ts`)
    const withSelf = (n: number) => [...many(n - 1), CF]
    expect(cf((d) => { d.paths = withSelf(16).map((p) => cfEntry(p)) }, { breaks: withSelf(16), files: { [CF_OD]: cfOdText(many(15)) } })).toEqual([])
    expect(cf((d) => { d.paths = withSelf(17).map((p) => cfEntry(p)) }, { breaks: withSelf(17), files: { [CF_OD]: cfOdText(many(16)) } })).toEqual([`paths must list 1 to ${CARRY_FORWARD_MAX_PATHS} files`])
    for (const paths of [[], undefined, 'src/main/fix.ts', {}]) {
      expect(cf((d) => { d.paths = paths }, { breaks: [CF] }), JSON.stringify(paths)).toEqual([`paths must list 1 to ${CARRY_FORWARD_MAX_PATHS} files`, `${CF} changed after boundHead and is not declared`])
    }
  })

  it('[host] carry-forward: under a binding-neutral path only Markdown and the manifest may change, so no code hides there', () => {
    const NOT_MD = (p: string) => `${p} changed since boundHead under a binding-neutral path but is not Markdown: a carry-forward allows only Markdown and ${MANIFEST_PATH} there`
    const prose = ['README.md', 'docs/wp1/evidence/x.md', 'architecture/decisions/2099-02-01-adr-999-x.md']
    expect(cf(undefined, { changed: [...CF_ALL, ...CF_NEUTRAL, ...prose] })).toEqual([])
    // The attack: code under docs/ that a counted line imports, and other files that are not prose.
    const payload = ['docs/wp1/payload.js', 'docs/wp1/payload.d.ts', 'docs/wp1/evidence/x.json', 'CONTEXT.d/x.txt', 'docs/NOTES.MD', 'docs/x.md.js', 'docs/img.png']
    expect(bindingBreaks(payload), 'each is under a neutral prefix').toEqual([])
    expect(cf(undefined, { changed: [...CF_ALL, ...CF_NEUTRAL, ...payload] })).toEqual(payload.map(NOT_MD))
    for (const p of payload) expect(isCarryForwardNeutralFile(p), p).toBe(false)
    for (const p of [MANIFEST_PATH, ...prose, ...CF_NEUTRAL]) expect(isCarryForwardNeutralFile(p), p).toBe(true)
  })

  it('[host] carry-forward: the declaration is read only from the commit, never from the working tree, and a name in another case refuses', () => {
    const BLOB = 'b'.repeat(40)
    const DECL = '{\n  "schema": "wp1-carry-forward/1"\n}\n'
    const tree = (entries: Array<[string, string]>) => {
      const calls: string[][] = []
      const g: Git = (args) => {
        calls.push(args)
        if (args[0] === 'ls-tree') return { status: 0, stdout: entries.map(([mode, p]) => `${mode} ${mode === '160000' ? 'commit' : 'blob'} ${BLOB}\t${p}\0`).join('') }
        if (args[0] === 'show') return { status: 0, stdout: DECL }
        throw new Error(`unexpected git ${args.join(' ')}`)
      }
      return { g, calls }
    }
    const SRC: [string, string] = ['100644', CF_FIX]
    const HERE: [string, string] = ['100644', CF]
    // No declaration at HEAD and none in the working tree: none, and the binding is judged as before.
    expect(committedCarryForward(tree([SRC]).g, null)).toEqual({ text: null, problems: [] })
    // A declaration written while the suite runs (by a setup file, say) is not committed: refused.
    expect(committedCarryForward(tree([SRC]).g, DECL)).toEqual({ text: null, problems: [`${CF} is in the working tree but not committed at HEAD: the suite reads only the committed declaration`] })
    // Committed: HEAD's text, read from git; the working copy must be the same, line endings aside.
    const t = tree([SRC, HERE])
    expect(committedCarryForward(t.g, DECL.replace(/\n/g, '\r\n'))).toEqual({ text: DECL, problems: [] })
    expect(t.calls).toEqual([['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], ['show', `HEAD:${CF}`]])
    const DIFFERS = `${CF} in the working tree is not the one committed at HEAD`
    expect(committedCarryForward(tree([SRC, HERE]).g, DECL.replace('wp1', 'wp2'))).toEqual({ text: DECL, problems: [DIFFERS] })
    expect(committedCarryForward(tree([SRC, HERE]).g, null)).toEqual({ text: DECL, problems: [DIFFERS] })
    // Its path in another case (the full path, ignoring case) refuses, with or without the exact path beside it.
    for (const v of ['tests/wp1/Carry-Forward.json', 'tests/WP1/carry-forward.json', 'TESTS/WP1/CARRY-FORWARD.JSON']) {
      const VARIANT = `${v} at HEAD is ${CF} in another case: remove or rename it`
      expect(committedCarryForward(tree([SRC, ['100644', v]]).g, null).problems, v).toEqual([VARIANT])
      expect(committedCarryForward(tree([HERE, ['100644', v]]).g, DECL).problems, v).toEqual([VARIANT])
    }
    // A file of that name in another folder (an archived declaration, a fixture) is not the declaration: as with none.
    for (const other of ['docs/wp1/evidence/2.1.2/carry-forward.json', 'tests/unit/fixtures/gate/carry-forward.json', 'CARRY-FORWARD.JSON', 'tests/wp1/carry-forward.json.bak']) {
      expect(committedCarryForward(tree([SRC, ['100644', other]]).g, null), other).toEqual({ text: null, problems: [] })
      expect(committedCarryForward(tree([HERE, ['100644', other]]).g, DECL), other).toEqual({ text: DECL, problems: [] })
    }
    // Only a plain file: a link, an executable or a submodule at the path refuses.
    for (const mode of ['120000', '100755', '160000']) {
      expect(committedCarryForward(tree([[mode, CF]]).g, DECL), mode).toEqual({ text: null, problems: [`${CF} at HEAD is not a plain file (mode ${mode})`] })
    }
    // A git that cannot list the tree is an error, never an absence.
    expect(() => committedCarryForward(() => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' }), null)).toThrow(/exited 128/)
  })

  it('[host] carry-forward: once the base has the rule its gate files are frozen, and a base without it may change them once', () => {
    const at = (text: string) => ({ [`${CF_BASE}:tests/wp1/binding.ts`]: text })
    const RULE = at('export function carryForwardProblems(text: string, ctx: CarryForwardContext): string[] {')
    const FROZEN = (ps: string[]) => `the base ${CF_BASE} already has the carry-forward rule, so its gate files may not change: ${ps.join(', ')}`
    // 2.1.2: the base (v2.1.1) has no rule, so the gate files may change, this once.
    expect(cf(undefined, { gateTouched: [...CARRY_FORWARD_GATE_FILES] })).toEqual([])
    expect(cf(undefined, { show: at('export function bindingBreaks(changed: readonly string[]): string[] {'), gateTouched: ['tests/wp1/binding.ts'] })).toEqual([])
    // A later patch whose base has the rule: any gate file changed refuses, by name.
    expect(cf(undefined, { show: RULE })).toEqual([])
    expect(cf(undefined, { show: RULE, gateTouched: ['tests/wp1/binding.ts', 'vitest.config.ts', 'tests/global-setup.ts'] })).toEqual([FROZEN(['tests/wp1/binding.ts', 'vitest.config.ts', 'tests/global-setup.ts'])])
    for (const f of CARRY_FORWARD_GATE_FILES) expect(cf(undefined, { show: RULE, gateTouched: [f] }), f).toEqual([FROZEN([f])])
    // The rule is found by its export, or by the declaration path it reads.
    expect(cf(undefined, { show: at(`export const CARRY_FORWARD_PATH = '${CF}'`), gateTouched: ['scripts/release-gate.mjs'] })).toEqual([FROZEN(['scripts/release-gate.mjs'])])
    // The freeze reads exactly these files, from the base to HEAD.
    expect(cfRun(undefined, { show: RULE }).calls).toContainEqual(['diff', '--name-only', '--no-renames', '-z', `${CF_BASE}..HEAD`, '--', ...CARRY_FORWARD_GATE_FILES])
  })

  it('[host] carry-forward: each declared path names a regression test vitest collects, and case titles found in its code', () => {
    const other = (content: string, cases = [CF_CASES[0]], file = CF_OTHER) => cf((d) => { d.paths[0].tests = [{ file, cases }] }, { files: { [file]: content } })
    const NO_CASE = (c = CF_CASES[0], file = CF_OTHER) => `${CF_FIX}: ${file} has no it( or test( case titled "${c}"`
    const SKIPS = `${CF_FIX}: ${CF_OTHER} skips, todos or focuses a case unconditionally, or names such a call in its text`
    expect(cf((d) => { d.paths[0].why = 'the fix' })).toEqual([`${CF_FIX}: why must say in 10 characters or more why it changed`])
    expect(cf((d) => { d.paths[0].why = `   ${'x'.repeat(9)}   ` })).toEqual([`${CF_FIX}: why must say in 10 characters or more why it changed`])
    for (const tests of [[], undefined, 'tests/unit/fix.test.ts']) expect(cf((d) => { d.paths[0].tests = tests }), JSON.stringify(tests)).toEqual([`${CF_FIX}: names no regression test`])
    // The second entry, the second test file and the second case are held to the rules of the first.
    expect(cf((d) => { d.paths[1].why = 'short' })).toEqual(['package.json: why must say in 10 characters or more why it changed'])
    expect(cf((d) => { d.paths[0].tests.push({ file: 'tests/unit/missing.test.ts', cases: [CF_CASES[0]] }) })).toEqual([`${CF_FIX}: tests/unit/missing.test.ts is missing or empty`])
    expect(cf((d) => { d.paths[0].tests[0].cases.push('a case that is not there') })).toEqual([NO_CASE('a case that is not there', CF_TEST)])
    // A file vitest collects, there and not empty.
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
      `const re = /['"\`]/\nit('${CF_CASES[0]}', () => {})`, `const s = \`\${'x'}\`\nit('${CF_CASES[0]}', () => {})`,
      `describe.runIf(true)('x', () => { it.skipIf(false)('y', () => {}) })\nit('${CF_CASES[0]}', () => {})`,
      // The lexer's regular expression branch: a backtick in a regex, a division on the same line as a case, a / inside a character class.
      `const re = /\`/\nit('${CF_CASES[0]}', () => {})`, `const q = a / b; it('${CF_CASES[0]}', () => {})`, `const re = /[/]\`/\nit('${CF_CASES[0]}', () => {})`]) {
      expect(other(shown), shown).toEqual([])
    }
    // No unconditional skip, todo or focus anywhere in the raw text of the file: in code, in a comment, in a string, or behind a / the lexer misreads.
    expect(other(`${call('it', 'skip')}('${CF_CASES[0]}', () => {})`)).toEqual([SKIPS, NO_CASE()])
    for (const skip of [`${call('describe', 'skip')}('x', () => {})`, `${call('it', 'only')}('x', () => {})`, `${call('test', 'todo')}('x')`, `${call('suite', 'skip')}('x', () => {})`,
      `${X}it('x', () => {})`, `${X}describe('x', () => {})`, `${X}test('x', () => {})`,
      `${call(call('it', 'skip'), 'each')}([1])('x', () => {})`, `${call(call('describe', 'concurrent'), 'skip')}('x', () => {})`, `${call(call('test', 'only'), 'each')}([1])('x', () => {})`,
      `// ${call('it', 'skip')}(`, `const s = '${call('it', 'only')}('`, `const n = {} / 1; ${call('describe', 'skip')}('x', () => {`]) {
      expect(other(`${skip}\nit('${CF_CASES[0]}', () => {})`), skip).toEqual([SKIPS])
    }
    // A title is plain text: 8 characters or more, no quote, backtick, backslash or newline.
    for (const c of ["it's the fix", 'say "the fix"', 'a `tick` case', 'a back\\slash case', 'two\nlines here', 'short', 7]) {
      expect(cf((d) => { d.paths[0].tests[0].cases = [c] }), String(c)).toEqual([`${CF_FIX}: ${JSON.stringify(c)} is not a case title (8 characters or more, with no quote, backtick, backslash or newline)`])
    }
  })

  it('[host] carry-forward: package files change only their version, and counted paths carry at most 600 lines, no line over 1000 characters and at most 64 KiB added', () => {
    expect(cf(undefined, { files: { 'package.json': cfPkg('2.1.2', '2.0.0') } })).toEqual(['package.json changed more than its version since boundHead'])
    expect(cf(undefined, { files: { 'package-lock.json': cfLock('2.1.2', '1.0.0', '1.0.1') } })).toEqual(['package-lock.json changed more than its version since boundHead'])
    expect(cf(undefined, { files: { 'package-lock.json': cfLock('2.1.2', '^1.0.0') } })).toEqual(['package-lock.json changed more than its version since boundHead'])
    for (const after of [null, '{', '']) expect(cf(undefined, { files: { 'package.json': after } }), String(after)).toEqual(['package.json changed more than its version since boundHead'])
    for (const before of [null, '{']) expect(cf(undefined, { show: { [`${CF_BOUND}:package-lock.json`]: before } }), String(before)).toEqual(['package-lock.json changed more than its version since boundHead'])
    // The version-only rule compares whole documents: key order does not matter, every other field does.
    expect(cf(undefined, { files: { 'package.json': JSON.stringify({ dependencies: { x: '1.0.0' }, version: '2.1.2', name: 'app' }) } })).toEqual([])
    // Lines added and deleted in counted paths, since boundHead: 600 carry forward, 601 do not.
    const OVER = (n: number) => `${n} lines changed in counted paths since boundHead; at most ${CARRY_FORWARD_MAX_SHIPPED_LINES} carry forward`
    expect(cf(undefined, { numstat: { [CF_FIX]: '590\t4' } })).toEqual([])
    expect(cf(undefined, { numstat: { [CF_FIX]: '590\t5' } })).toEqual([OVER(601)])
    // A count git gives that cannot be read, or a binary file, is a problem, never zero.
    for (const rec of ['-\t-', 'x\t4', '3', '3\t', '-1\t2', '3.5\t1']) {
      expect(cf(undefined, { numstat: { [CF_FIX]: rec } }), rec).toEqual(['a counted declared file is binary, or git gave a line count that cannot be read'])
    }
    // Only what can ship counts: tests/, .github/ and the named release tooling do not; src/, a script that ships, resources and build do.
    const big = (p: string) => cfRun((d) => { d.paths.push(cfEntry(p)) }, { breaks: [...CF_ALL, p], numstat: { [p]: '9000\t1000' }, patch: { [p]: ['y'.repeat(5000)] }, files: { [CF_OD]: cfOdText([p]) } })
    for (const p of [CF_TEST, '.github/workflows/x.yml', ...DEV_ONLY_TOOLING]) {
      const r = big(p)
      expect(r.problems, p).toEqual([])
      expect(r.calls.filter((c) => c[0] === 'diff').some((c) => c.includes(p)), p).toBe(false)
    }
    for (const p of ['src/main/other.ts', 'scripts/resume-picker.js', 'resources/x.json', 'build/installer.nsh']) {
      expect(big(p).problems, p).toEqual([OVER(10054), `${p}: an added line of 5000 characters, over the ${CARRY_FORWARD_MAX_ADDED_LINE} a carry-forward allows`])
    }
    // No added line over 1000 characters in a counted path: the 169 KB one-line payload is refused; 1000 is not.
    const LONG = (n: number) => `${CF_FIX}: an added line of ${n} characters, over the ${CARRY_FORWARD_MAX_ADDED_LINE} a carry-forward allows`
    expect(cf(undefined, { patch: { [CF_FIX]: ['x'.repeat(1000)] } })).toEqual([])
    expect(cf(undefined, { patch: { [CF_FIX]: ['x'.repeat(1001)] } })).toEqual([LONG(1001)])
    // The fixture adds one short line to each package file: 'a short line' and its line end, twice.
    const PKG_BYTES = 2 * 13
    const BYTES = (n: number) => `${n} bytes added in counted paths since boundHead; at most ${CARRY_FORWARD_MAX_ADDED_BYTES} carry forward`
    expect(cf(undefined, { patch: { [CF_FIX]: ['short', 'x'.repeat(168930)] } })).toEqual([LONG(168930), BYTES(6 + 168931 + PKG_BYTES)])
    // At most 64 KiB added in counted paths: many lines of 999 characters, under the line count and the line length, are refused.
    const rows = (n: number, last?: number) => [...Array.from({ length: n }, () => 'p'.repeat(999)), ...(last === undefined ? [] : ['p'.repeat(last)])]
    expect(cf(undefined, { numstat: { [CF_FIX]: '590\t0' }, patch: { [CF_FIX]: rows(590) } })).toEqual([BYTES(590 * 1000 + PKG_BYTES)])
    expect(cf(undefined, { numstat: { [CF_FIX]: '66\t0' }, patch: { [CF_FIX]: rows(65, 509) } }), '65536 bytes').toEqual([])
    expect(cf(undefined, { numstat: { [CF_FIX]: '66\t0' }, patch: { [CF_FIX]: rows(65, 510) } }), '65537 bytes').toEqual([BYTES(65537)])
    // Bytes, not characters: 33 lines of 999 two-byte characters.
    expect(cf(undefined, { numstat: { [CF_FIX]: '33\t0' }, patch: { [CF_FIX]: Array.from({ length: 33 }, () => String.fromCharCode(0xe9).repeat(999)) } })).toEqual([BYTES(33 * 1999 + PKG_BYTES)])
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
    // The phrase is spaced: the declaration's own path holds carry-forward, which is not the phrase.
    expect(cf((d) => { d.approval = `${CF_OD}#CF3` })).toEqual([`section CF3 of ${CF_OD} does not say the evidence is carried forward`])
    expect(cf((d) => { d.approval = `${CF_OD}#CF4` })).toEqual([`section CF4 of ${CF_OD} does not name package-lock.json`])
    expect(cf((d) => { d.approval = `${CF_OD}#CF5` })).toEqual([`section CF5 of ${CF_OD} does not name ${CF_FIX}`])
    expect(cf((d) => { d.approval = `${CF_OD}#CF6` })).toEqual([`section CF6 of ${CF_OD} does not name ${CF_FIX}`])
    expect(cf((d) => { d.approval = `${CF_OD}#CF7` })).toEqual([])
    expect(cf((d) => { d.approval = `${CF_OD}#CF8` })).toEqual(CF_ALL.map((p) => `section CF8 of ${CF_OD} does not name ${p}`))
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
    expect(CARRY_FORWARD_MAX_SHIPPED_LINES).toBe(600)
    expect(CARRY_FORWARD_MAX_ADDED_LINE).toBe(1000)
    expect(CARRY_FORWARD_MAX_ADDED_BYTES).toBe(65536)
    expect([...DEV_ONLY_TREES]).toEqual(['tests/', '.github/'])
    expect([...DEV_ONLY_TOOLING]).toEqual(['scripts/release-gate.mjs', 'scripts/wp1/fetch-ledger-commit.mjs'])
    for (const p of ['tests/x.ts', '.github/workflows/ci.yml', ...DEV_ONLY_TOOLING]) expect(isCountedPath(p), p).toBe(false)
    for (const p of ['src/main/x.ts', 'scripts/resume-picker.js', 'scripts/wp1/other.mjs', 'scripts/release-gate.mjs.bak', 'package.json', '.githubx/y', 'testsx/y']) expect(isCountedPath(p), p).toBe(true)
    expect(bindingBreaks([CARRY_FORWARD_PATH])).toEqual([CARRY_FORWARD_PATH])
    // The neutral rules are the ones before ADR-027: the declaration widens nothing.
    expect(BINDING_NEUTRAL.map(String)).toEqual(['/^tests\\/wp1\\/traceability\\.json$/', '/^docs\\//', '/^CONTEXT\\.d\\//', '/^architecture\\/decisions\\/[^/]+\\.md$/', '/^[^/]+\\.md$/'])
    expect(String(RUNNABLE_TEST)).toBe(String(/^tests\/(unit|wp1)\/.+\.test\.tsx?$|^tests\/integration\/.+\.test\.ts$/))
    expect(String(NATIVE_TEST)).toBe(String(/\.native\.test\.tsx?$/))
    // changedLines: nothing asked for no paths; a binary entry, or one it cannot read, is null; a failed diff throws.
    expect(changedLines(() => { throw new Error('git must not be asked') }, CF_BOUND, [])).toBe(0)
    expect(changedLines(() => ({ status: 0, stdout: ['3\t4\ta.ts', '0\t9\tc.ts', ''].join('\0') }), CF_BOUND, ['a.ts', 'c.ts'])).toBe(16)
    for (const bad of ['-\t-\tb.png', 'x\t4\ta.ts', '3\t4', '3\t4\t', '3 4\ta.ts']) {
      expect(changedLines(() => ({ status: 0, stdout: ['3\t4\ta.ts', bad, ''].join('\0') }), CF_BOUND, ['a.ts']), bad).toBeNull()
    }
    expect(() => changedLines(() => ({ status: 128, stdout: '', stderr: 'fatal: bad revision' }), CF_BOUND, ['a.ts'])).toThrow(/exited 128/)
    // longAddedLines: only added lines inside a hunk, with a trailing CR not counted; nothing asked for no paths; a failed diff throws.
    const patch = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -0,0 +1,3 @@', `+++ ${'y'.repeat(20)}`, '+short', `-${'z'.repeat(50)}`,
      'diff --git a/b.ts b/b.ts', 'new file mode 100644', '--- /dev/null', '+++ b/b.ts', '@@ -0,0 +1 @@', `+${'w'.repeat(30)}\r`, ''].join('\n')
    const asked: string[][] = []
    expect(longAddedLines((a) => { asked.push(a); return { status: 0, stdout: patch } }, CF_BOUND, ['a.ts', 'b.ts'], 20)).toEqual(['a.ts: an added line of 23 characters', 'b.ts: an added line of 30 characters'])
    expect(asked).toEqual([['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', `${CF_BOUND}..HEAD`, '--', 'a.ts', 'b.ts']])
    // addedBytes: each added line's UTF-8 bytes and its line end, the CR left out.
    expect(addedBytes(addedLines(() => ({ status: 0, stdout: patch }), CF_BOUND, ['a.ts', 'b.ts']))).toBe(24 + 6 + 31)
    expect(addedBytes([{ text: String.fromCharCode(0xe9) }, { text: '' }])).toBe((2 + 1) + (0 + 1))
    expect(longAddedLines(() => { throw new Error('git must not be asked') }, CF_BOUND, [], 20)).toEqual([])
    expect(() => longAddedLines(() => ({ status: 128, stdout: '' }), CF_BOUND, ['a.ts'], 20)).toThrow(/exited 128/)
    // changedPaths reads only the named files when asked to.
    const named: string[][] = []
    expect(changedPaths((a) => { named.push(a); return { status: 0, stdout: 'x\0' } }, CF_BOUND, ['x', 'y'])).toEqual(['x'])
    expect(named).toEqual([['diff', '--name-only', '--no-renames', '-z', `${CF_BOUND}..HEAD`, '--', 'x', 'y']])
    // fileAt: a file at a commit, null when it is not there, and only for a 40-hex commit id.
    const shown: string[][] = []
    expect(fileAt((a) => { shown.push(a); return { status: 0, stdout: 'x' } }, CF_BOUND, 'package.json')).toBe('x')
    expect(shown).toEqual([['show', `${CF_BOUND}:package.json`]])
    expect(fileAt(() => ({ status: 128, stdout: '' }), CF_BOUND, 'package.json')).toBeNull()
    for (const sha of ['HEAD', '--output=x', `${CF_BOUND}:x`]) expect(() => fileAt(() => ({ status: 0, stdout: '' }), sha, 'a'), sha).toThrow(/40-hex/)
  })

  it('[host] carry-forward: tooling left out of the caps must never be packaged: a bare folder, a glob or an extra resource refuses, an exclusion does not', () => {
    const T = ['scripts/release-gate.mjs', 'scripts/wp1/fetch-ledger-commit.mjs']
    const none = new Set<string>()
    const no = () => false
    const SHIPS = (t: string, f: string) => `${t} is packaged by the build entry ${f}`
    const real = { files: ['out/**/*', 'resources/**/*', 'scripts/resume-picker.js', 'NOTICE'], extraResources: [{ from: 'build/config-template.json', to: 'config-template.json' }], asarUnpack: ['**/node_modules/x/**'] }
    expect(toolingPackagingProblems(real, T, none, no)).toEqual([])
    // An exclusion only removes files, so it cannot ship the tooling.
    expect(toolingPackagingProblems({ ...real, files: [...real.files, '!**/*.map', '!scripts/**/*'] }, T, none, no)).toEqual([])
    // A bare folder ships everything under it, and so do globs that reach the tooling.
    expect(toolingPackagingProblems({ ...real, files: [...real.files, 'scripts'] }, T, none, no)).toEqual(T.map((t) => SHIPS(t, 'scripts')))
    expect(toolingPackagingProblems({ ...real, files: [...real.files, 'scripts/wp1'] }, T, none, no)).toEqual([SHIPS(T[1], 'scripts/wp1')])
    for (const f of ['scripts/**/*', '**/*', 'scripts/*.mjs', 'scrip*', 'scripts/release-gate.mjs', 'scripts/', 'scripts/release-gate.?js']) {
      expect(toolingPackagingProblems({ ...real, files: [f] }, T, none, no), f).toContainEqual(SHIPS(T[0], f))
    }
    for (const f of ['out/**/*', 'scripts/*.js', 'scripts/resume-picker.js', 'scripts/wp1x', 'script']) expect(toolingPackagingProblems({ ...real, files: [f] }, [T[0]], none, no), f).toEqual([])
    // One * stays within a folder.
    expect(toolingPackagingProblems({ ...real, files: ['scripts/*.mjs'] }, [T[1]], none, no)).toEqual([])
    // Per platform too, and as an extra resource or an extra file.
    expect(toolingPackagingProblems({ ...real, mac: { files: ['scripts'] } }, T, none, no)).toEqual(T.map((t) => SHIPS(t, 'scripts')))
    expect(toolingPackagingProblems({ ...real, extraResources: [{ from: 'scripts', to: 's' }] }, T, none, no)).toEqual(T.map((t) => SHIPS(t, '{"from":"scripts","to":"s"}')))
    expect(toolingPackagingProblems({ ...real, extraFiles: 'scripts/wp1/fetch-ledger-commit.mjs' }, T, none, no)).toEqual([SHIPS(T[1], 'scripts/wp1/fetch-ledger-commit.mjs')])
    // What cannot be read here refuses: brace and bracket globs, a file set with a filter, a moved app root.
    for (const f of ['scripts/{a,b}.mjs', 'scripts/[r]*.mjs']) expect(toolingPackagingProblems({ ...real, files: [f] }, T, none, no), f).toEqual([`the build entry ${f} cannot be read here`])
    expect(toolingPackagingProblems({ ...real, files: [{ from: 'scripts', filter: ['**/*'] }] }, T, none, no)).toEqual(['the build entry {"from":"scripts","filter":["**/*"]} cannot be read here'])
    expect(toolingPackagingProblems({ ...real, directories: { app: 'app' } }, T, none, no)).toEqual(['build.directories.app moves the packaged root, which this check cannot read'])
    // Imported by the app's build config, or named in src/.
    expect(toolingPackagingProblems(real, T, new Set([T[0]]), no)).toEqual([`${T[0]} is imported by the app's build config`])
    expect(toolingPackagingProblems(real, T, none, (t) => t === T[1])).toEqual([`${T[1]} is named in a string under src/`])
  })

  it('[host] carry-forward: no symbolic link or submodule under src, resources or a declared path, read from the commit', () => {
    const LINK = (p: string, mode: string) => `${p} at HEAD is a ${mode === '120000' ? 'symbolic link' : 'submodule'} (mode ${mode}) under src/, resources/ or a declared path: a carry-forward allows none`
    // Elsewhere a link or a submodule is not this rule's business, and an executable file is not a link.
    expect(cf(undefined, { tree: [['100644', CF_FIX], ['100755', 'scripts/x.sh'], ['120000', 'docs/link'], ['160000', 'vendor/sub'], ['120000', '.github/workflows/x.yml']] })).toEqual([])
    // Under src/ or resources/, or at a declared path (package.json is one, outside both), each refuses.
    for (const p of ['src/main/evil.ts', 'src/renderer/assets', 'resources/x.json', CF_FIX, 'package.json']) {
      for (const mode of ['120000', '160000']) expect(cf(undefined, { tree: [['100644', 'README.md'], [mode, p]] }), `${mode} ${p}`).toEqual([LINK(p, mode)])
    }
    expect(linkEntryProblems(() => ({ status: 0, stdout: `120000 blob ${'b'.repeat(40)}\tbuild/x/y\0` }), ['build/x'])).toEqual([LINK('build/x/y', '120000')])
    // Read from the commit's tree, and a git that cannot list it is an error.
    expect(cfRun().calls).toContainEqual(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])
    expect(() => linkEntryProblems(() => ({ status: 128, stdout: '', stderr: 'fatal' }), [])).toThrow(/exited 128/)
  })

  it('[host] carry-forward: shipped code cannot hide outside src, and electron-builder reads only the config the packaging proof reads', () => {
    const at = (path: string, text: string) => ({ path, text })
    // A relative specifier that leaves src/ refuses, in every form that reaches the build, unless its target is allowed data.
    expect(outOfSrcImports([at('src/main/a.ts', "import x from './b'\nimport y from '../shared/c'\nimport z from 'node:fs'\nimport w from 'electron'")])).toEqual([])
    expect(outOfSrcImports([at('src/main/a.ts', "import x from '../../tests/x'")])).toEqual(['src/main/a.ts reaches ../../tests/x, outside src/ (tests/x)'])
    for (const spec of ["export * from '../../tests/x'", "import '../../tests/x'", "const x = await import('../../tests/x')", "const x = require('../../tests/x')",
      "const u = new URL('../../tests/x.js', import.meta.url)", "const g = import.meta.glob('../../tests/*.ts')", 'import x from "../../scripts/release-gate.mjs"',
      'import x from `../../tests/x`', "import raw from '../../tests/x.ts?raw'", "import y from '../../../package.json'"]) {
      expect(outOfSrcImports([at('src/main/a.ts', spec)]), spec).toHaveLength(1)
    }
    // A comment between the words and the quote hides nothing: a block comment (the @vite-ignore idiom), several, or a line comment.
    for (const spec of ["const x = await import(/* @vite-ignore */ '../../tests/x.js')", "const x = require(/* x */ '../../tests/x')", "const x = import(\n  // why\n  '../../tests/x.js')",
      "const x = import(/* a */ /* b */ '../../tests/x.js')", "const x = require /* x */ ('../../tests/x')", "export * from /* x */ '../../tests/x'", "import/* x */'../../tests/x'", "import'../../tests/x'",
      "const g = import.meta.glob(/* x */ ['../../tests/*.ts'])", "const u = new /* x */ URL(/* x */ '../../tests/x.js', import.meta.url)"]) {
      expect(outOfSrcImports([at('src/main/a.ts', spec)]), spec).toHaveLength(1)
    }
    // The idiom of src/main/canvas/bridge/analysis-loader.ts stays accepted: a variable, or a target inside src/ or a package; and a block comment never runs past its own end.
    for (const spec of ['const m = await import(/* @vite-ignore */ specifier)', "const m = await import(/* @vite-ignore */ './analysis.js')", "const m = await import(/* @vite-ignore */ '../../shared/x.js')",
      "const m = await import(/* @vite-ignore */ 'some-package')", "const m = [import(/* @vite-ignore */ specifier), /* a path */ '../../../../tests/y']"]) {
      expect(outOfSrcImports([at('src/main/canvas/bridge/analysis-loader.ts', spec)]), spec).toEqual([])
    }
    expect(outOfSrcImports([at('src/renderer/index.html', '<script type="module" src="../../tests/x.js"></script>')])).toHaveLength(1)
    expect(outOfSrcImports([at('src/renderer/index.html', '<script type="module" src="./main.tsx"></script>')])).toEqual([])
    // The data under resources/ the app reads is allowed, by exact path only.
    for (const t of SRC_OUTSIDE_IMPORTS_ALLOWED) expect(outOfSrcImports([at('src/main/a.ts', `import j from '../../${t}'`)]), t).toEqual([])
    expect(outOfSrcImports([at('src/main/a.ts', "import j from '../../resources/other.json'")])).toEqual(['src/main/a.ts reaches ../../resources/other.json, outside src/ (resources/other.json)'])
    expect(SRC_OUTSIDE_IMPORTS_ALLOWED.every((t) => /^resources\/[^/]+\.json$/.test(t))).toBe(true)
    // electron-builder: a config file of its own, a config named on its command, or an override of a key but the two allowed, refuses.
    const BUILDER_FILE = (p: string) => `${p} is an electron-builder config of its own, which the packaging proof does not read`
    for (const p of ['electron-builder.yml', 'electron-builder.yaml', 'electron-builder.json', 'electron-builder.json5', 'electron-builder.toml', 'electron-builder.config.js', 'electron-builder.config.ts', 'Electron-Builder.YML']) {
      expect(builderConfigProblems([p], []), p).toEqual([BUILDER_FILE(p)])
    }
    expect(builderConfigProblems(['package.json', 'docs/electron-builder.yml', 'electron.vite.config.ts'], [])).toEqual([])
    const cmd = (text: string) => builderConfigProblems([], [{ where: 'w', text }])
    for (const ok of ['npx electron-builder --mac', 'electron-vite build && electron-builder --win --config.npmRebuild=false', '$extra += "-c.win.signtoolOptions.certificateSha1=$env:SIGN_THUMBPRINT"',
      'npx vitest run --config vitest.live.config.ts', 'git -c core.autocrlf=false status', '# short -c. treats the value as a config-file path', 'bash -c "echo"',
      '    # npx electron-builder --config custom.yml -c.files=x (a comment)']) {
      expect(cmd(ok), ok).toEqual([])
    }
    for (const bad of ['npx electron-builder --config electron-builder.prod.yml', 'npx electron-builder -c custom.yml --mac', 'npx electron-builder --config=custom.yml', 'npx electron-builder -c']) {
      expect(cmd(bad), bad).toEqual(['w: electron-builder is given a config of its own, which the packaging proof does not read'])
    }
    for (const [bad, key] of [['npx electron-builder --config.files=scripts/**', 'files'], ['$extra += "-c.extends=./x.js"', 'extends'], ['npx electron-builder -c.directories.app=scripts', 'directories.app'], ['args="--config.extraResources=scripts"', 'extraResources']]) {
      expect(cmd(bad), bad).toEqual([`w: an electron-builder override of ${key}, which the packaging proof does not read`])
    }
    expect([...BUILDER_OVERRIDES_ALLOWED]).toEqual(['npmRebuild', 'win.signtoolOptions.certificateSha1'])
    // A build config that extends another one cannot be read here either.
    expect(toolingPackagingProblems({ files: ['out/**/*'], extends: './base.yml' }, ['scripts/release-gate.mjs'], new Set(), () => false)).toEqual(['build.extends pulls in a config this check cannot read'])
    expect(toolingPackagingProblems({ files: ['out/**/*'], extends: null }, ['scripts/release-gate.mjs'], new Set(), () => false)).toEqual([])
  })

  it('[host] carry-forward: the repository-level checks run only at the candidate phase with a declaration committed, so one merged back to a gate0 beta does nothing there', () => {
    const text = JSON.stringify(cfDecl())
    expect(carryForwardRepoChecksRun('candidate', text)).toBe(true)
    for (const [p, t] of [['gate0', text], ['candidate', null], ['gate0', null], ['Candidate', text], ['', text]] as Array<[string, string | null]>) {
      expect(carryForwardRepoChecksRun(p, t), `${p} ${t === null ? 'none' : 'declared'}`).toBe(false)
    }
  })

  // ADR-027: with a declaration in use, the size caps leave out only release
  // tooling this repository's packaging never ships, and the freeze covers
  // every file that decides how the suite runs. With none, or at gate0 (a
  // declaration merged back to beta), packaging and the test configs are not
  // tied to this rule, so beta and dev CI stay free.
  it('carry-forward: with a declaration in use at the candidate phase, the tooling the caps leave out is never packaged, no src file reaches outside src but allowed data, and the gate files list every vitest config and setup file', () => {
    if (!carryForwardRepoChecksRun(phase, committedCarry.text)) return
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { build?: unknown }
    // What the app's build imports from outside src/: electron-vite's config, followed through relative imports.
    const imported = new Set<string>()
    const follow = (file: string) => {
      for (const m of readFileSync(resolve(ROOT, file), 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const p = join(file, '..', m[1]).replace(/\\/g, '/')
        if (!imported.has(p) && existsSync(resolve(ROOT, p))) { imported.add(p); if (/\.[cm]?[jt]s$/.test(p)) follow(p) }
      }
    }
    follow('electron.vite.config.ts')
    const srcFiles = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', 'src'], { encoding: 'utf8' }).split('\0').filter(Boolean)
    const srcText = srcFiles.map((f) => readFileSync(resolve(ROOT, f), 'utf8'))
    const namedInSrc = (t: string) => {
      const name = t.slice(t.lastIndexOf('/') + 1).replace(/\.[cm]?js$/, '').replace(/[.-]/g, '\\$&')
      return srcText.some((s) => new RegExp(`['"][^'"\\n]*${name}(?:\\.[cm]?js)?['"]`).test(s))
    }
    for (const t of DEV_ONLY_TOOLING) expect(existsSync(resolve(ROOT, t)), `${t} is not there`).toBe(true)
    const problems = toolingPackagingProblems(pkg.build, DEV_ONLY_TOOLING, imported, namedInSrc)
    expect(problems, problems.join('\n')).toEqual([])
    // Verify the verifier on the real config: a script that ships, and one the build imports, are seen.
    expect(toolingPackagingProblems(pkg.build, ['scripts/resume-picker.js'], imported, namedInSrc)).not.toEqual([])
    expect(imported.has('scripts/build-identity.mjs')).toBe(true)
    // No src file reaches outside src/ but the allowed data, and every input electron-vite builds from is under src/.
    const srcCode = srcFiles.filter((f) => /\.(?:[cm]?[jt]sx?|html)$/.test(f))
    const reach = outOfSrcImports(srcCode.map((f) => ({ path: f, text: readFileSync(resolve(ROOT, f), 'utf8') })))
    expect(reach, reach.join('\n')).toEqual([])
    const viteConfig = readFileSync(resolve(ROOT, 'electron.vite.config.ts'), 'utf8')
    const inputs = [...viteConfig.matchAll(/input\s*:\s*\{([^}]*)\}|root\s*:\s*(resolve\([^)]*\))/g)].flatMap((m) => [...(m[1] ?? m[2]).matchAll(/resolve\(__dirname,\s*'([^']+)'\)/g)].map((x) => x[1]))
    expect(inputs.length, 'no build inputs found in electron.vite.config.ts').toBeGreaterThan(5)
    for (const i of inputs) expect(i, 'an electron-vite build input outside src/').toMatch(/^src\//)
    // electron-builder reads package.json's build field and nothing else: no config of its own, none on a command.
    const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
    const scripts = Object.entries((JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}).map(([k, v]) => ({ where: `package.json scripts.${k}`, text: v }))
    const workflows = tracked.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).map((f) => ({ where: f, text: readFileSync(resolve(ROOT, f), 'utf8') }))
    expect(workflows.length).toBeGreaterThan(1)
    const builder = builderConfigProblems(tracked, [...scripts, ...workflows])
    expect(builder, builder.join('\n')).toEqual([])
    // The freeze lists every vitest config, and every setup and global-setup file they name.
    const configs = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', 'vitest*.config.*'], { encoding: 'utf8' }).split('\0').filter(Boolean)
    expect(configs.length).toBeGreaterThan(0)
    for (const c of configs) {
      expect(CARRY_FORWARD_GATE_FILES, c).toContain(c)
      for (const m of readFileSync(resolve(ROOT, c), 'utf8').matchAll(/(?:setupFiles|globalSetup)\s*:\s*\[([^\]]*)\]/g)) {
        for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) expect(CARRY_FORWARD_GATE_FILES, `${c}: ${s[1]}`).toContain(s[1])
      }
    }
    for (const f of CARRY_FORWARD_GATE_FILES) expect(existsSync(resolve(ROOT, f)), f).toBe(true)
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
  it(`candidate phase: nothing is still planned (unavailable on a recorded owner decision: ${unavailable.join(', ') || 'none'}), every evidence record was taken at boundHead, and boundHead is an ancestor of HEAD with only neutral paths changed since (phase ${phase}: ${reason}; carry-forward: ${committedCarry.text === null ? 'none' : CARRY_FORWARD_PATH})`, () => {
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
    // The declaration is the one committed at HEAD, never a working-tree file.
    expect(committedCarry.problems, `the carry-forward declaration cannot be read from HEAD (ADR-027):\n${committedCarry.problems.join('\n')}`).toEqual([])
    const changed = changedPaths(git, bound)
    const breaks = bindingBreaks(changed)
    const textOf = (p: string) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : null)
    const binding = bindingVerdict(breaks, committedCarry.text, { git, boundHead: bound, version: pkgVersion, changed, textOf })
    expect(binding.problems, binding.message).toEqual([])
    if (binding.carried) console.info(`WP1 candidate: evidence carried forward from boundHead ${bound} by ${CARRY_FORWARD_PATH}: ${breaks.join(', ')}`)
  })
})
