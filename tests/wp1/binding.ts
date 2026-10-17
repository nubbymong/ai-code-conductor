// WP1.70: the candidate check's binding and item-status rules, as pure
// functions over data. traceability.test.ts runs them on this repository; its
// [host] cases run them on injected lists, files and an injected git, so they
// spawn nothing. The ancestry verdict lives in
// scripts/wp1/fetch-ledger-commit.mjs, which deepens a shallow checkout before
// the suite runs, so the script and the test can never disagree on what
// "decidable" means. A targeted stable patch may carry the previous stable's
// evidence forward on a declared file list (carryForwardProblems, ADR-027).
import { isDeepStrictEqual } from 'node:util'
import { posix } from 'node:path'
import { ancestry, SHA_RE } from '../../scripts/wp1/fetch-ledger-commit.mjs'
// The committed-tree scan for the declaration is the gate's own, so the suite
// and the gate read it the same way.
import { CARRY_FORWARD_PATH as GATE_CARRY_FORWARD_PATH, scanCommittedCarryForward } from '../../scripts/release-gate.mjs'

export { ancestry, SHA_RE }

/** One git call: argv in, exit status and output back (status null: git did not run). */
export type Git = (args: string[]) => { status: number | null; stdout: string; stderr?: string }

export type EvidenceRecord = {
  artifact: string; sha256: string; head: string; actor: string; at: string; commands: string[]; runId?: string
}

export const MANIFEST_PATH = 'tests/wp1/traceability.json'

/** An item's status (ADR-026). `planned`: not recorded yet. `evidenced`:
 *  every part recorded; there is no "evidenced with limits" (ADR-026, settled
 *  point 2). A real-cli or packaged item's parts are taken on every OS its
 *  text, or else its release plan, gives it. An automated, ci or document
 *  item's parts are what its tests prove in CI at boundHead on the three OS
 *  runners and what each evidence file it cites records. An item whose own
 *  text names a part those do not prove stays planned, unless an owner
 *  decision it cites amends its scope.
 *  `unavailable`: recorded, except a part that cannot be taken, on the owner's
 *  decision recorded in this repository; it is held to everything `evidenced`
 *  is, plus the rules in unavailableProblems, and its records are taken at
 *  boundHead like any other (staleRecords). */
export const ITEM_STATUSES = ['planned', 'evidenced', 'unavailable'] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]

/** The only items that may read `unavailable` (ADR-026): those whose evidence
 *  needs something only the owner can give, a real provider identity or
 *  credential, or a host the owner consents to. Every automated, ci and document item
 *  can always be recorded by the agents, and so can WP1.71 (non-secret, no
 *  account). This list is not binding-neutral: widening it after boundHead
 *  breaks the binding. */
export const UNAVAILABLE_ELIGIBLE: readonly string[] = ['WP1.2', 'WP1.10', 'WP1.11', 'WP1.20', 'WP1.32', 'WP1.63', 'WP1.64', 'WP1.72']
const UNAVAILABLE_KINDS: ReadonlySet<string> = new Set(['real-cli', 'packaged'])
const UNAVAILABLE_REASON_MIN = 20
/** A dated owner-decisions record under docs/wp1, and the ID its `## <ID>`
 *  heading starts with. Nothing else can be referenced, so the decision is
 *  read from this repository, never only from a private tracker. */
const DECISION_RE = /^(docs\/wp1\/owner-decisions-\d{4}-\d{2}-\d{2}\.md)#([A-Za-z][A-Za-z0-9-]*)$/

/** What an `unavailable` item carries: what could not be taken and why, and the owner decision. */
export type Unavailable = { reason: string; decision: string }

/** The items the candidate check refuses: everything not `evidenced`, nor
 *  `unavailable` on an item UNAVAILABLE_ELIGIBLE names (`planned`, a status
 *  this gate does not know, or `unavailable` on any other item). The check
 *  holds the list itself, so it never rests on a separate case having run. */
export function incompleteItems(items: ReadonlyArray<{ id: string; status?: string }>): string[] {
  return items.filter((i) => !(i.status === 'evidenced' || (i.status === 'unavailable' && UNAVAILABLE_ELIGIBLE.includes(i.id)))).map((i) => i.id)
}

/** The items recorded `unavailable`, which the candidate check names. */
export function unavailableIds(items: ReadonlyArray<{ id: string; status?: string }>): string[] {
  return items.filter((i) => i.status === 'unavailable').map((i) => i.id)
}

const namesItem = (text: string, id: string) => new RegExp(`${id.replace(/\./g, '\\.')}(?![0-9])`).test(text)

/** The repository files evidenceProblems reads, injected so its rules can be
 *  proven without touching the disk. */
export type RepoFiles = { nonEmpty: (path: string) => boolean; text: (path: string) => string; sha256: (path: string) => string }

/** Every way a recorded item, evidenced or unavailable, fails its evidence: a
 *  listed test or evidence file that is missing or empty, a tests/wp1 file
 *  that does not name the item, or a docs/wp1/evidence file with no record or
 *  with a record whose digest, head, actor, time or commands are wrong. An
 *  unavailable item is held to all of it (ADR-026); a planned item is not
 *  checked here. */
export function evidenceProblems(
  items: ReadonlyArray<{ id: string; status?: string; tests: readonly string[]; evidence: readonly string[]; evidenceRecords?: ReadonlyArray<Partial<EvidenceRecord>> }>,
  files: RepoFiles,
): string[] {
  const out: string[] = []
  for (const i of items) {
    if (i.status !== 'evidenced' && i.status !== 'unavailable') continue
    for (const t of i.tests) {
      if (!files.nonEmpty(t)) out.push(`${i.id}: missing or empty ${t}`)
      else if (t.startsWith('tests/wp1/') && !namesItem(files.text(t), i.id)) out.push(`${t} does not name ${i.id}`)
    }
    for (const e of i.evidence) {
      if (!files.nonEmpty(e)) { out.push(`${i.id}: missing or empty ${e}`); continue }
      if (!e.startsWith('docs/wp1/evidence/')) continue
      const rec = (i.evidenceRecords ?? []).find((r) => r.artifact === e)
      if (!rec) { out.push(`${i.id}: no evidence record for ${e}`); continue }
      const digest = files.sha256(e)
      if (rec.sha256 !== digest) out.push(`${i.id}: the record for ${e} has sha256 ${String(rec.sha256)}, the file has ${digest}`)
      if (typeof rec.head !== 'string' || !SHA_RE.test(rec.head)) out.push(`${i.id}: the record for ${e} names no 40-hex head it was taken at`)
      if (typeof rec.actor !== 'string' || rec.actor.length === 0) out.push(`${i.id}: the record for ${e} names no actor`)
      if (typeof rec.at !== 'string' || Number.isNaN(Date.parse(rec.at))) out.push(`${i.id}: the record for ${e} has no valid time`)
      if (!Array.isArray(rec.commands) || rec.commands.length === 0) out.push(`${i.id}: the record for ${e} lists no commands`)
    }
  }
  return out
}

/** A Markdown text with CRLF read as LF and every HTML comment taken out,
 *  one never closed running to the end, as a renderer hides it. Other hidden
 *  Markdown (a link reference definition, a link's target) is kept. A fenced
 *  code block stays. */
export function shownText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '')
}

/** The `## <id>` section of a Markdown text, up to the next heading of level
 *  one or two; null when there is none. Text in an HTML comment or a fenced
 *  code block is not part of any section. A fence closes only on a line of
 *  its own character, at least as long, with nothing after it but spaces. */
function sectionOf(text: string, id: string): string | null {
  const lines: string[] = []
  let fence: string | null = null
  for (const l of shownText(text).split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l)
    if (fence === null) {
      if (f) fence = f[1]
      else lines.push(l)
    } else if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === '') fence = null
  }
  const head = new RegExp(`^##\\s+${id}(?:[.:]|\\s|$)`)
  const at = lines.findIndex((l) => head.test(l))
  if (at < 0) return null
  const end = lines.findIndex((l, n) => n > at && /^#{1,2}\s/.test(l))
  return lines.slice(at, end < 0 ? undefined : end).join('\n')
}

/** Every way the items break the `unavailable` rules (ADR-026), checked in
 *  every phase. textOf reads a repository file, null when it is not there.
 *  An `unavailable` item must be one UNAVAILABLE_ELIGIBLE names, of a
 *  real-cli or packaged kind, with a reason of 20 characters or more and a
 *  decision `docs/wp1/owner-decisions-YYYY-MM-DD.md#<ID>` whose own section
 *  names the item; one of its docs/wp1/evidence records must cite that
 *  decision, so the gap is stated in the record bound at boundHead. Any
 *  other item must carry no `unavailable` record. */
export function unavailableProblems(
  items: ReadonlyArray<{ id: string; kind: string; status?: string; evidence: readonly string[]; unavailable?: unknown }>,
  textOf: (path: string) => string | null,
): string[] {
  return items.flatMap((i) => {
    if (i.status !== 'unavailable') {
      return i.unavailable === undefined ? [] : [`${i.id}: carries an unavailable record, but its status is ${i.status}: remove the record, or set the status to unavailable`]
    }
    if (!UNAVAILABLE_ELIGIBLE.includes(i.id)) return [`${i.id} (${i.kind}) may not be unavailable: only ${UNAVAILABLE_ELIGIBLE.join(', ')} may (ADR-026)`]
    const out: string[] = []
    if (!UNAVAILABLE_KINDS.has(i.kind)) out.push(`${i.id}: an unavailable item must be real-cli or packaged, not ${i.kind}`)
    const u = (typeof i.unavailable === 'object' && i.unavailable !== null ? i.unavailable : {}) as Partial<Record<keyof Unavailable, unknown>>
    if (typeof u.reason !== 'string' || u.reason.trim().length < UNAVAILABLE_REASON_MIN) {
      out.push(`${i.id}: an unavailable item needs a reason of at least ${UNAVAILABLE_REASON_MIN} characters: what could not be taken, and why`)
    }
    const d = typeof u.decision === 'string' ? DECISION_RE.exec(u.decision) : null
    if (!d) {
      out.push(`${i.id}: an unavailable item needs decision "docs/wp1/owner-decisions-YYYY-MM-DD.md#<ID>", the owner decision recorded in this repository`)
      return out
    }
    const [decision, file, id] = d
    const text = textOf(file)
    const section = text === null ? null : sectionOf(text, id)
    if (text === null) out.push(`${i.id}: the decision file ${file} is not there`)
    else if (section === null) out.push(`${i.id}: ${file} has no "## ${id}" heading`)
    else if (!namesItem(section, i.id)) out.push(`${i.id}: section ${id} of ${file} does not name ${i.id}`)
    else if (!/\bunavailable\b/i.test(section)) out.push(`${i.id}: section ${id} of ${file} does not say what is unavailable`)
    const records = i.evidence.filter((e) => e.startsWith('docs/wp1/evidence/'))
    // The reference whole: a record citing #D10, #D1_x or #D1.2 does not cite
    // #D1 (a full stop that ends the sentence does). Text inside an HTML
    // comment never counts.
    const cites = new RegExp(`${decision.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`)
    if (records.length === 0) out.push(`${i.id}: an unavailable item needs a docs/wp1/evidence/ record, which says what was not taken`)
    else if (!records.some((e) => cites.test(shownText(textOf(e) ?? '')))) {
      out.push(`${i.id}: none of its evidence records (${records.join(', ')}) cites ${decision}: say there what was not taken, and cite the decision`)
    }
    return out
  })
}

// What may change after the binding without breaking it: this manifest (the
// commit that records boundHead edits it), and text that nothing in the app,
// its build or its packaged files reads: docs/ (the evidence files there are
// pinned again by each record's sha256), the running log, the ADRs and the
// top-level Markdown. Everything else breaks it: src, tests, scripts,
// resources, build, the workflows, package.json and its lockfile, every
// config, and any path added later, so a new kind of file is covered without
// anyone widening a list.
export const BINDING_NEUTRAL: readonly RegExp[] = [
  /^tests\/wp1\/traceability\.json$/,
  /^docs\//,
  /^CONTEXT\.d\//,
  /^architecture\/decisions\/[^/]+\.md$/,
  /^[^/]+\.md$/,
]

/** The changed paths that break the evidence binding. */
export function bindingBreaks(changed: readonly string[]): string[] {
  return changed.filter((p) => !BINDING_NEUTRAL.some((re) => re.test(p)))
}

/** Exactly what vitest.config.ts collects (tests/integration has no .tsx
 *  glob): a test is RUNNABLE_TEST and not NATIVE_TEST (*.native.test.* is
 *  excluded from the system-Node run). */
export const RUNNABLE_TEST = /^tests\/(unit|wp1)\/.+\.test\.tsx?$|^tests\/integration\/.+\.test\.ts$/
export const NATIVE_TEST = /\.native\.test\.tsx?$/

/** Every path changed between base and HEAD: NUL-separated (no quoting of
 *  unusual names) and without rename pairing (a file moved out of src still
 *  lists its old path). */
export function changedPaths(git: Git, base: string, only?: readonly string[]): string[] {
  const r = git(['diff', '--name-only', '--no-renames', '-z', `${base}..HEAD`, ...(only ? ['--', ...only] : [])])
  if (r.status !== 0) throw new Error(`git diff ${base}..HEAD exited ${r.status}: ${r.stderr ?? ''}`)
  return r.stdout.split('\0').filter(Boolean)
}

/** Lines added plus deleted between base and HEAD in these paths; null when
 *  one of them is binary, or a record is not two counts and a path (fail
 *  closed: a count it cannot read is never taken as zero). No paths, no git
 *  call. */
export function changedLines(git: Git, base: string, paths: readonly string[]): number | null {
  if (paths.length === 0) return 0
  const r = git(['diff', '--numstat', '--no-renames', '-z', `${base}..HEAD`, '--', ...paths])
  if (r.status !== 0) throw new Error(`git diff --numstat ${base}..HEAD exited ${r.status}: ${r.stderr ?? ''}`)
  let n = 0
  for (const rec of r.stdout.split('\0').filter(Boolean)) {
    const m = /^(\d+)\t(\d+)\t[^\t]+$/.exec(rec)
    if (!m) return null
    n += Number(m[1]) + Number(m[2])
  }
  return n
}

/** Every line added between base and HEAD in these paths, with its file and
 *  its text (a trailing CR left out). It reads the patch git prints (no
 *  context, no renames, no external diff or textconv); only lines inside a
 *  hunk are content. No paths, no git call. */
export function addedLines(git: Git, base: string, paths: readonly string[]): Array<{ file: string; text: string }> {
  if (paths.length === 0) return []
  const r = git(['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', `${base}..HEAD`, '--', ...paths])
  if (r.status !== 0) throw new Error(`git diff -U0 ${base}..HEAD exited ${r.status}: ${r.stderr ?? ''}`)
  const out: Array<{ file: string; text: string }> = []
  let file = ''
  let inHunk = false
  for (const raw of r.stdout.split('\n')) {
    const l = raw.replace(/\r$/, '')
    if (l.startsWith('diff --git ')) { inHunk = false; file = ''; continue }
    if (!inHunk) {
      if (l.startsWith('+++ ')) file = l.startsWith('+++ b/') ? l.slice(6) : l.slice(4)
      else if (l.startsWith('@@')) inHunk = true
      continue
    }
    if (l.startsWith('+')) out.push({ file, text: l.slice(1) })
  }
  return out
}

/** Every added line longer than `max` characters between base and HEAD in
 *  these paths, as "<path>: an added line of N characters" (addedLines). */
export function longAddedLines(git: Git, base: string, paths: readonly string[], max: number): string[] {
  return longOf(addedLines(git, base, paths), max)
}
const longOf = (lines: ReadonlyArray<{ file: string; text: string }>, max: number) =>
  lines.filter((l) => l.text.length > max).map((l) => `${l.file}: an added line of ${l.text.length} characters`)

/** The UTF-8 bytes of these added lines, each line end counted as one. */
export function addedBytes(lines: ReadonlyArray<{ text: string }>): number {
  return lines.reduce((n, l) => n + Buffer.byteLength(l.text, 'utf8') + 1, 0)
}

/** The carry-forward declaration as committed at HEAD, read from git and
 *  never from the working tree (ADR-027): its text, or null when HEAD has
 *  none. The tree scan is the gate's (scanCommittedCarryForward): the
 *  declaration's path in another case, or an entry at the path that is not a
 *  plain file, is a problem, and a file of that name in another folder is
 *  ignored. Besides those, a working-tree copy that differs from HEAD's (line
 *  endings aside), or one HEAD does not have, is a problem. `workingText` is
 *  the working-tree file, null when absent. */
export function committedCarryForward(git: Git, workingText: string | null): { text: string | null; problems: string[] } {
  const scan = scanCommittedCarryForward(git)
  const problems = [...scan.problems]
  if (!scan.present) {
    if (workingText !== null) problems.push(`${CARRY_FORWARD_PATH} is in the working tree but not committed at HEAD: the suite reads only the committed declaration`)
    return { text: null, problems }
  }
  if (scan.text === null) return { text: null, problems }
  const lf = (t: string) => t.replace(/\r\n/g, '\n')
  if (workingText === null || lf(workingText) !== lf(scan.text)) problems.push(`${CARRY_FORWARD_PATH} in the working tree is not the one committed at HEAD`)
  return { text: scan.text, problems }
}

/** The entries of HEAD's tree that are a symbolic link (mode 120000) or a
 *  submodule (mode 160000) under src/, under resources/, or at or under one
 *  of `declared`. A bundler or a packager follows a link, so one could bring
 *  in code that nothing declares or counts, at the size of one line. */
export function linkEntryProblems(git: Git, declared: readonly string[]): string[] {
  const r = git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])
  if (r.status !== 0) throw new Error(`git ls-tree HEAD exited ${r.status}: ${r.stderr ?? ''}`)
  const out: string[] = []
  for (const rec of r.stdout.split('\0').filter(Boolean)) {
    const mode = rec.slice(0, rec.indexOf(' '))
    const p = rec.slice(rec.indexOf('\t') + 1)
    if (mode !== '120000' && mode !== '160000') continue
    if (['src/', 'resources/'].some((t) => p.startsWith(t)) || declared.some((d) => p === d || p.startsWith(`${d}/`))) {
      out.push(`${p} at HEAD is a ${mode === '120000' ? 'symbolic link' : 'submodule'} (mode ${mode}) under src/, resources/ or a declared path: a carry-forward allows none`)
    }
  }
  return out
}

/** A file's text at a commit; null when the commit or the path is not
 *  there. The commit must be a 40-hex id, so nothing else reaches git. */
export function fileAt(git: Git, sha: string, path: string): string | null {
  if (!SHA_RE.test(sha)) throw new Error(`not a 40-hex commit id: ${JSON.stringify(sha)}`)
  const r = git(['show', `${sha}:${path}`])
  return r.status === 0 ? r.stdout : null
}

/** What every release step that runs the suite gives WP1_PHASE: the candidate
 *  phase on a stable release that is not a dry run, otherwise nothing
 *  (./phase.ts then reads the manifest). */
export const RELEASE_WP1_PHASE = "${{ inputs.channel == 'stable' && !inputs.dry_run && 'candidate' || '' }}"

export type SuiteStep = { job: string; name: string; phase: string | null }

/** The steps of a workflow that run the test suite (vitest, or an npm test
 *  script), each with its job, its name and the WP1_PHASE its own `env:`
 *  gives it (null: none). The manifest's `phase` is a neutral field, so a
 *  manifest-only commit could switch the candidate check off; the stable
 *  release declares the phase in its own steps' environment instead, which
 *  ./phase.ts lets only raise it. Line-based, for the workflows' own layout:
 *  jobs at two spaces; a step runs from its `- ` under `steps:` to the next
 *  one or the end of the list; comments never count. */
export function suiteSteps(yml: string): SuiteStep[] {
  const out: SuiteStep[] = []
  let job = ''
  let stepsAt = -1
  let itemAt = -1
  let step: string[] | null = null
  const close = () => {
    if (!step) return
    const code = step.filter((l) => !l.trim().startsWith('#')).join('\n')
    if (/^\s*(?:- )?run:/m.test(code) && /\bvitest\b|\bnpm (?:run )?test\b/.test(code)) {
      const name = /^\s*(?:- )?name:\s*(.+?)\s*$/m.exec(code)?.[1] ?? '(unnamed)'
      const phase = /^\s+WP1_PHASE:\s*(.+?)\s*$/m.exec(code)?.[1] ?? null
      out.push({ job, name, phase: phase === null ? null : phase.replace(/^(['"])(.*)\1$/, '$2') })
    }
    step = null
  }
  for (const line of yml.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) { step?.push(line); continue }
    const lead = /^ */.exec(line)![0].length
    const top = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (top) { close(); job = top[1]; stepsAt = -1; itemAt = -1; continue }
    if (stepsAt >= 0 && lead <= stepsAt) { close(); stepsAt = -1; itemAt = -1 }
    const steps = /^( +)steps:\s*$/.exec(line)
    if (steps && stepsAt < 0) { stepsAt = steps[1].length; continue }
    if (stepsAt < 0) continue
    const item = /^( +)- /.exec(line)
    if (item && (itemAt < 0 || item[1].length === itemAt)) { close(); itemAt = item[1].length; step = [line]; continue }
    step?.push(line)
  }
  close()
  return out
}

/** Evidence records not taken at boundHead. The manifest that declares
 *  boundHead is itself neutral, so boundHead alone could be moved past a
 *  source change with the evidence untouched; each record therefore names the
 *  head it was taken at, its artifact says so outside any HTML comment, and
 *  every one must be boundHead. */
export function staleRecords(
  items: ReadonlyArray<{ id: string; evidenceRecords?: ReadonlyArray<Pick<EvidenceRecord, 'artifact' | 'head'>> }>,
  boundHead: string,
  textOf: (artifact: string) => string,
): string[] {
  return items.flatMap((i) => (i.evidenceRecords ?? []).flatMap((r) => {
    if (r.head !== boundHead) return [`${i.id}: ${r.artifact} was taken at ${r.head || '(no head)'}, not at boundHead ${boundHead}`]
    if (!shownText(textOf(r.artifact)).includes(r.head)) return [`${i.id}: ${r.artifact} does not name the head ${r.head} its record claims`]
    return []
  }))
}

// ADR-027: a targeted stable patch carries the previous stable's WP1
// evidence forward, on a declared, tested and reviewed file list. The
// declaration is a file of its own, never a field of the neutral manifest, so
// an edit to it is itself a change it must declare. It replaces only the
// candidate case's final assertion (bindingVerdict); every other rule above
// still runs. The caps are constants here, never fields of the declaration,
// and count from boundHead, so chained patches add up until a qualification.
// The size caps count only what can ship in the app (isCountedPath): declared
// paths outside DEV_ONLY_TREES and DEV_ONLY_TOOLING, the release tooling a
// traceability case proves is not packaged. Raising a cap is a reviewed,
// non-neutral edit to this file.
export const CARRY_FORWARD_PATH: string = GATE_CARRY_FORWARD_PATH
export const CARRY_FORWARD_SCHEMA = 'wp1-carry-forward/1'
export const CARRY_FORWARD_MAX_PATHS = 16
export const CARRY_FORWARD_MAX_SHIPPED_LINES = 600
/** The longest added line a counted path may carry: a line count alone does
 *  not bound size. Above the longest one-line changelog description. */
export const CARRY_FORWARD_MAX_ADDED_LINE = 1000
/** The most a carry-forward may add in counted paths, in UTF-8 bytes (64
 *  KiB): the line caps alone still let 600 lines of 1000 characters through. */
export const CARRY_FORWARD_MAX_ADDED_BYTES = 65536
/** Trees that never ship: tests and workflows. */
export const DEV_ONLY_TREES: readonly string[] = ['tests/', '.github/']
/** Release tooling under scripts/ that is never packaged (not in package.json
 *  build.files or extraResources, imported by no src/ file and by no vite
 *  config); a traceability case proves each from the packaging config. Every
 *  other scripts/ file is counted, because several ship. */
export const DEV_ONLY_TOOLING: readonly string[] = ['scripts/release-gate.mjs', 'scripts/wp1/fetch-ledger-commit.mjs']
/** Whether a path's lines count toward the size caps. */
export const isCountedPath = (p: string) => !DEV_ONLY_TREES.some((t) => p.startsWith(t)) && !DEV_ONLY_TOOLING.includes(p)

/** Every way the packaging config could ship one of `tooling`, which the
 *  size caps leave out only while it never ships. `build` is package.json's
 *  `build` field; `imported` holds what the app's build config imports from
 *  outside src/; `namedInSrc` says whether a src/ file names a path. An entry
 *  of `files`, `extraResources` or `extraFiles` (per platform too) ships what
 *  it matches and everything under a folder it matches, a bare folder
 *  included; an entry that starts with ! only excludes, so it ships nothing.
 *  An entry this check cannot read (a brace or bracket glob, a file set with
 *  a filter) and a moved app root are problems themselves. */
export function toolingPackagingProblems(build: Json, tooling: readonly string[], imported: ReadonlySet<string>, namedInSrc: (path: string) => boolean): string[] {
  const b = typeof build === 'object' && build !== null ? build : {}
  const out: string[] = []
  if (b.directories?.app !== undefined) out.push('build.directories.app moves the packaged root, which this check cannot read')
  if (b.extends !== undefined && b.extends !== null) out.push('build.extends pulls in a config this check cannot read')
  const list = (v: Json): Json[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])
  const entries: Json[] = []
  for (const at of [b, b.win, b.mac, b.linux]) {
    if (typeof at !== 'object' || at === null) continue
    for (const k of ['files', 'extraResources', 'extraFiles']) entries.push(...list(at[k]))
  }
  const globRe = (g: string) => new RegExp(`^${g.split(/(\*\*\/|\*\*|\*|\?)/).map((s) => (s === '**/' ? '(?:.*/)?' : s === '**' ? '.*' : s === '*' ? '[^/]*' : s === '?' ? '[^/]' : escapeRe(s))).join('')}$`)
  const patterns: Array<{ shown: string; re: RegExp }> = []
  for (const e of entries) {
    const shown = typeof e === 'string' ? e : JSON.stringify(e)
    const from = typeof e === 'string' ? e : typeof e === 'object' && e !== null && e.filter === undefined && typeof e.from === 'string' ? e.from : null
    if (from === null || /[{}[\]]/.test(from)) { out.push(`the build entry ${shown} cannot be read here`); continue }
    if (from.startsWith('!')) continue
    patterns.push({ shown, re: globRe(from.replace(/\/+$/, '')) })
  }
  for (const t of tooling) {
    const within = t.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))
    for (const p of patterns) if (within.some((w) => p.re.test(w))) out.push(`${t} is packaged by the build entry ${p.shown}`)
    if (imported.has(t)) out.push(`${t} is imported by the app's build config`)
    if (namedInSrc(t)) out.push(`${t} is named in a string under src/`)
  }
  return out
}

/** The files outside src/ that src/ code imports by a relative path: data
 *  under resources/ the app reads, which ships with it (build.files) and
 *  counts toward the caps, so importing it hides nothing. Any other relative
 *  import that leaves src/ could pull code that is neither declared nor
 *  counted (under tests/, say) into the bundle. */
export const SRC_OUTSIDE_IMPORTS_ALLOWED: readonly string[] = [
  'resources/claude-code-model-configuration.json', 'resources/codex-model-catalogue.json', 'resources/codex-pricing.json',
  'resources/macos-release-floors.json', 'resources/model-registry.json', 'resources/sentinel-assumption-manifest.json',
]
/** A relative specifier in the ways a source file reaches another for the
 *  build: import or export from, a side-effect import, import(), require(),
 *  new URL() (an asset), import.meta.glob(), and an HTML src or href. Between
 *  the words and the quote it reads through whitespace and comments, block
 *  (one at a time: never past its own end) and line, so a comment such as
 *  `import(/* @vite-ignore *\/ '../x')` does not hide the specifier. */
const SRC_GAP = '(?:\\s|/\\*(?:[^*]|\\*(?!/))*\\*/|//[^\\n]*(?:\\n|$))*'
const SRC_SPECIFIER_RE = new RegExp(`(?:${[
  `\\bfrom${SRC_GAP}`,
  `\\bimport${SRC_GAP}\\(${SRC_GAP}`,
  `\\brequire${SRC_GAP}\\(${SRC_GAP}`,
  `\\bimport${SRC_GAP}`,
  `\\bnew${SRC_GAP}URL${SRC_GAP}\\(${SRC_GAP}`,
  `\\bimport${SRC_GAP}\\.${SRC_GAP}meta${SRC_GAP}\\.${SRC_GAP}glob${SRC_GAP}\\(${SRC_GAP}\\[?${SRC_GAP}`,
  '\\b(?:src|href)\\s*=\\s*',
].join('|')})(['"\`])(\\.{1,2}\\/[^'"\`]*)\\1`, 'g')

/** Every relative specifier in these src/ files that resolves outside src/
 *  to a file `allowed` does not name. Bare package names are not relative and
 *  are not looked at. The scan is static: a path built at run time is not
 *  seen. */
export function outOfSrcImports(files: ReadonlyArray<{ path: string; text: string }>, allowed: readonly string[] = SRC_OUTSIDE_IMPORTS_ALLOWED): string[] {
  const out: string[] = []
  for (const f of files) {
    for (const m of f.text.matchAll(SRC_SPECIFIER_RE)) {
      const target = posix.normalize(posix.join(posix.dirname(f.path), m[2]))
      if (!target.startsWith('src/') && !allowed.includes(target)) out.push(`${f.path} reaches ${m[2]}, outside src/ (${target})`)
    }
  }
  return out
}

/** The electron-builder override keys a build command may pass: the native
 *  rebuild switch and the Windows signing thumbprint. Any other key (files,
 *  extends, directories, extraResources) could change what is packaged. */
export const BUILDER_OVERRIDES_ALLOWED: readonly string[] = ['npmRebuild', 'win.signtoolOptions.certificateSha1']

/** Every way electron-builder could take a config other than package.json's
 *  build field, which the packaging proof reads: a config file of its own at
 *  the root (electron-builder.* or electron-builder.config.*), a --config or
 *  -c that names a file (on a line that runs electron-builder), or a dotted
 *  override (--config.<key> or -c.<key>, on any line, since an argument list
 *  can be built apart from the command) of a key BUILDER_OVERRIDES_ALLOWED
 *  does not name. `commands` are the texts that can run it (package.json
 *  scripts, the workflows), by where they come from; comment lines are
 *  skipped. */
export function builderConfigProblems(tracked: readonly string[], commands: ReadonlyArray<{ where: string; text: string }>): string[] {
  const out: string[] = []
  for (const p of tracked) if (/^electron-builder(?:\.config)?\.[A-Za-z0-9]+$/i.test(p)) out.push(`${p} is an electron-builder config of its own, which the packaging proof does not read`)
  for (const c of commands) {
    for (const line of c.text.split(/\r?\n/)) {
      if (/^\s*(?:#|\/\/)/.test(line)) continue
      for (const m of line.matchAll(/(?<![\w.-])(?:--config|-c)\.([A-Za-z0-9_.]+)/g)) {
        if (!BUILDER_OVERRIDES_ALLOWED.includes(m[1])) out.push(`${c.where}: an electron-builder override of ${m[1]}, which the packaging proof does not read`)
      }
      if (/\belectron-builder\b/.test(line) && /(?<![\w.-])(?:--config|-c)(?=[\s=]|$)/.test(line)) out.push(`${c.where}: electron-builder is given a config of its own, which the packaging proof does not read`)
    }
  }
  return out
}
/** The only binding-neutral paths a carry-forward lets change: Markdown, and
 *  the manifest. Any other file under a neutral prefix could be code nothing
 *  declares or counts. */
export const isCarryForwardNeutralFile = (p: string) => p === MANIFEST_PATH || /\.md$/.test(p)
/** The files that decide how the suite and the gate run. Once a base already
 *  has this rule, a carry-forward may change none of them, so a later patch
 *  cannot rewrite the check that judges it. */
export const CARRY_FORWARD_GATE_FILES: readonly string[] = [
  'tests/wp1/binding.ts', 'tests/wp1/traceability.test.ts', 'tests/wp1/phase.ts',
  'scripts/release-gate.mjs', 'scripts/wp1/fetch-ledger-commit.mjs',
  '.github/workflows/release.yml', '.github/workflows/ci.yml',
  'vitest.config.ts', 'vitest.native.config.ts', 'vitest.live.config.ts',
  'tests/global-setup.ts', 'tests/helpers/home-isolation.ts', 'tests/unit/setup.ts',
]
const STABLE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** An exact repository path: no leading /, no . or .. segment, and no glob,
 *  pathspec, quoting or space character, so git reads it as itself. */
const EXACT_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+\-/]+$/
const CASE_RE = /^[^'"`\\\n\r]{8,}$/
/** An unconditional skip, todo or focus (skipIf and runIf are conditional,
 *  and allowed). Searched for in the RAW text of a test file, comments and
 *  strings included, so no layout that misleads the lexer below can hide one
 *  (fail closed: a test file that only mentions one is refused too). */
const STATIC_SKIP_RE = /(?<![\w$.])(?:describe|suite|it|test)(?:\s*\.\s*[A-Za-z_$][\w$]*)*?\s*\.\s*(?:skip|todo|only)(?![\w$])|(?<![\w$.])x(?:describe|it|test)\s*\(/
/** A bare it( or test( call, up to its first argument. */
const TEST_CALL_RE = /(?<![\w$.])(?:it|test)\s*\(\s*/g
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** What may differ in a package file whose version alone changed. */
const VERSION_FREE: ReadonlyMap<string, (j: Json) => Json> = new Map([
  ['package.json', (j: Json) => { const c = structuredClone(j); delete c.version; return c }],
  ['package-lock.json', (j: Json) => { const c = structuredClone(j); delete c.version; if (c.packages?.['']) delete c.packages[''].version; return c }],
])

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The version whole (2.1.20 is not 2.1.2), with or without its v. */
const namesVersion = (text: string, v: string) => new RegExp(`(?<![\\w.-])v?${escapeRe(v)}(?![\\w-]|\\.\\d)`).test(text)
/** The path whole: not part of a longer path or name. */
const namesPath = (text: string, p: string) => new RegExp(`(?<![\\w./-])${escapeRe(p)}(?![\\w/-]|\\.\\w)`).test(text)
const parsedOrNull = (text: string | null): Json => {
  if (text === null) return null
  try { return JSON.parse(text) } catch { return null }
}

/** A test file's code: every comment, and the inside of every string,
 *  template and regular expression literal, blanked (newlines kept), with the
 *  text of each plain string or template (no escape, no ${}) by where it
 *  starts. Enough of the lexical grammar to tell code from text in an
 *  ordinary test file; it is not a parser. It guesses whether a / starts a
 *  regular expression (after a closing bracket it reads division), and a
 *  wrong guess can desynchronise it, so in a hostile layout it can miss a
 *  case or read one that is not there. It is used only to find case titles;
 *  skips are found in the raw text, and hostile test files are the ADR-009
 *  pass's to catch. */
function codeOf(text: string): { code: string; literals: Map<number, string> } {
  const out = text.split('')
  const literals = new Map<number, string>()
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  let last = -1
  const regexMayStart = () => {
    if (last < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(text[last])) return true
    if (!/[\w$]/.test(text[last])) return false
    let s = last
    while (s > 0 && /[\w$]/.test(text[s - 1])) s--
    return /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(text.slice(s, last + 1))
  }
  const literal = (i: number): number => {
    const q = text[i]
    let j = i + 1
    let seg = j
    let plain = true
    let inClass = false
    for (; j < text.length; j++) {
      const ch = text[j]
      if (ch === '\\') { plain = false; j++; continue }
      if (q === '/') {
        if (ch === '\n') break
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) break
        continue
      }
      if (ch === q || (q !== '`' && ch === '\n')) break
      if (q === '`' && ch === '$' && text[j + 1] === '{') { plain = false; blank(seg, j); j = code(j + 2, true); seg = j + 1 }
    }
    blank(seg, Math.min(j, text.length))
    const closed = j < text.length && text[j] === q
    if (plain && closed && q !== '/') literals.set(i, text.slice(i + 1, j))
    let end = closed ? j + 1 : j
    if (q === '/') while (end < text.length && /[A-Za-z]/.test(text[end])) end++
    return end
  }
  function code(i: number, inTemplate: boolean): number {
    let depth = 0
    while (i < text.length) {
      const c = text[i]
      if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); const end = e < 0 ? text.length : e; blank(i, end); i = end; continue }
      if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? text.length : e + 2; blank(i, end); i = end; continue }
      if (c === "'" || c === '"' || c === '`' || (c === '/' && regexMayStart())) { i = literal(i); last = i - 1; continue }
      if (c === '{') depth++
      else if (c === '}') { if (depth === 0 && inTemplate) return i; depth-- }
      if (!/\s/.test(c)) last = i
      i++
    }
    return i
  }
  code(0, false)
  return { code: out.join(''), literals }
}

/** The titles of a test file's bare it( and test( calls, and its code. */
function testsOf(text: string): { code: string; titles: Set<string> } {
  const { code, literals } = codeOf(text)
  const titles = new Set<string>()
  for (const m of code.matchAll(TEST_CALL_RE)) {
    const title = literals.get(m.index + m[0].length)
    if (title !== undefined) titles.add(title)
  }
  return { code, titles }
}

/** The owner decision a carry-forward cites: a dated record under docs/wp1
 *  whose `## <ID>` section names the version, says the evidence is carried
 *  forward, and names every declared path, outside code fences and HTML
 *  comments (the shape is checked, not the meaning, as for ADR-026). */
function approvalProblems(approval: unknown, version: string, paths: readonly unknown[], textOf: (path: string) => string | null): string[] {
  const d = typeof approval === 'string' ? DECISION_RE.exec(approval) : null
  if (!d) return ['approval must be "docs/wp1/owner-decisions-YYYY-MM-DD.md#<ID>", the owner decision recorded in this repository']
  const [, file, id] = d
  const text = textOf(file)
  if (text === null) return [`the approval file ${file} is not there`]
  const section = sectionOf(text, id)
  if (section === null) return [`${file} has no "## ${id}" heading`]
  const out: string[] = []
  if (!namesVersion(section, version)) out.push(`section ${id} of ${file} does not name ${version}`)
  // Spaced only: the hyphen form is the declaration's own path, which every section must name.
  if (!/\bcarr(?:y|ied) forward\b/i.test(section)) out.push(`section ${id} of ${file} does not say the evidence is carried forward`)
  for (const p of paths) if (typeof p === 'string' && p !== '' && !namesPath(section, p)) out.push(`section ${id} of ${file} does not name ${p}`)
  return out
}

/** A declared path's regression tests: a reason it changed, and one or more
 *  files vitest collects, each there, with no unconditional skip, todo or
 *  focus anywhere in its text, holding every named case as the title of a
 *  bare it( or test( call. A case is proven to exist, not to have run
 *  (ADR-027). */
function namedTestProblems(entry: Json, textOf: (path: string) => string | null): string[] {
  const p = String(entry?.path)
  const out: string[] = []
  if (typeof entry?.why !== 'string' || entry.why.trim().length < 10) out.push(`${p}: why must say in 10 characters or more why it changed`)
  const tests: Json[] = Array.isArray(entry?.tests) ? entry.tests : []
  if (tests.length === 0) out.push(`${p}: names no regression test`)
  for (const t of tests) {
    const file = t?.file
    if (typeof file !== 'string' || !EXACT_PATH_RE.test(file) || !RUNNABLE_TEST.test(file) || NATIVE_TEST.test(file)) { out.push(`${p}: ${String(file)} is not a test vitest collects`); continue }
    const text = textOf(file)
    if (text === null || text.trim() === '') { out.push(`${p}: ${file} is missing or empty`); continue }
    const { titles } = testsOf(text)
    if (STATIC_SKIP_RE.test(text)) out.push(`${p}: ${file} skips, todos or focuses a case unconditionally, or names such a call in its text`)
    const cases: Json[] = Array.isArray(t.cases) ? t.cases : []
    if (cases.length === 0) out.push(`${p}: ${file} names no case`)
    for (const c of cases) {
      if (typeof c !== 'string' || !CASE_RE.test(c)) out.push(`${p}: ${JSON.stringify(c)} is not a case title (8 characters or more, with no quote, backtick, backslash or newline)`)
      else if (!titles.has(c)) out.push(`${p}: ${file} has no it( or test( case titled "${c}"`)
    }
  }
  return out
}

export type CarryForwardContext = {
  git: Git; boundHead: string; version: string; breaks: readonly string[]
  /** Every path changed since boundHead, neutral ones included. */
  changed: readonly string[]
  /** A repository file in the working tree; null when it is not there. */
  textOf: (path: string) => string | null
}

/** Every way a carry-forward declaration fails (ADR-027); [] when the
 *  binding holds by carry-forward. `version` is package.json's, `breaks`
 *  the non-neutral paths changed since boundHead, `changed` all of them. */
export function carryForwardProblems(text: string, ctx: CarryForwardContext): string[] {
  let d: Json
  try { d = JSON.parse(text) } catch (e) { return [`${CARRY_FORWARD_PATH} is not valid JSON: ${String(e)}`] }
  if (typeof d !== 'object' || d === null || Array.isArray(d) || d.schema !== CARRY_FORWARD_SCHEMA) return [`${CARRY_FORWARD_PATH}: schema must be ${CARRY_FORWARD_SCHEMA}`]
  if (d.targetVersion !== ctx.version) return [`${CARRY_FORWARD_PATH} carries forward to ${d.targetVersion}, but package.json is ${ctx.version}: it is stale, delete it`]
  const out: string[] = []
  const base: Json = typeof d.base === 'object' && d.base !== null ? d.base : {}
  // The version: the next stable patch after a stable base of the same line.
  const t = STABLE_RE.exec(String(d.targetVersion))
  const b = STABLE_RE.exec(String(base.version))
  if (!t || !b) out.push(`targetVersion and base.version must be stable x.y.z versions, not ${d.targetVersion} and ${base.version}`)
  else if (!(t[1] === b[1] && t[2] === b[2] && Number(t[3]) === Number(b[3]) + 1)) out.push(`${d.targetVersion} is not the patch after ${base.version}`)
  if (base.tag !== `v${base.version}`) out.push(`base.tag must be v${base.version}, not ${base.tag}`)
  // The base: the previous stable, an ancestor of HEAD, whose manifest is a
  // candidate bound to this boundHead, so the evidence carried is the
  // evidence it shipped on.
  if (base.boundHead !== ctx.boundHead) out.push(`base.boundHead ${base.boundHead} is not the boundHead of the manifest, ${ctx.boundHead}`)
  if (typeof base.commit !== 'string' || !SHA_RE.test(base.commit)) out.push('base.commit is not a 40-hex commit id')
  else {
    const v = ancestry(ctx.git, base.commit)
    if (v === 'undecidable') out.push(`base.commit ${base.commit}: its ancestry is not decidable here; run node scripts/wp1/fetch-ledger-commit.mjs first`)
    else if (v !== 'ancestor') out.push(`base.commit ${base.commit} is not an ancestor of HEAD`)
    const pkg = parsedOrNull(fileAt(ctx.git, base.commit, 'package.json'))
    if (typeof base.version !== 'string' || pkg?.version !== base.version) out.push(`package.json at ${base.commit} is not version ${base.version}`)
    const m = parsedOrNull(fileAt(ctx.git, base.commit, MANIFEST_PATH))
    if (m?.phase !== 'candidate' || m.boundHead !== ctx.boundHead) out.push(`${MANIFEST_PATH} at ${base.commit} is not a candidate bound to ${ctx.boundHead}`)
    // Once the base already has this rule, the files that run and judge it are frozen.
    const rule = fileAt(ctx.git, base.commit, 'tests/wp1/binding.ts') ?? ''
    if (/export function carryForwardProblems\(|['"]tests\/wp1\/carry-forward\.json['"]/.test(rule)) {
      const touched = changedPaths(ctx.git, base.commit, CARRY_FORWARD_GATE_FILES)
      if (touched.length > 0) out.push(`the base ${base.commit} already has the carry-forward rule, so its gate files may not change: ${touched.join(', ')}`)
    }
  }
  // The declaration is committed after boundHead, so it is one of the breaks.
  if (!ctx.breaks.includes(CARRY_FORWARD_PATH)) out.push(`${CARRY_FORWARD_PATH} is not among the paths changed since boundHead`)
  // Under a neutral prefix, only Markdown and the manifest may change.
  for (const p of ctx.changed) {
    if (bindingBreaks([p]).length === 0 && !isCarryForwardNeutralFile(p)) out.push(`${p} changed since boundHead under a binding-neutral path but is not Markdown: a carry-forward allows only Markdown and ${MANIFEST_PATH} there`)
  }
  // Why, who approved it, and the ADR-009 pass that covers it (always).
  if (typeof d.reason !== 'string' || d.reason.trim().length < 40) out.push('reason must be 40 characters or more')
  const entries: Json[] = Array.isArray(d.paths) ? d.paths : []
  const paths: unknown[] = entries.map((e) => e?.path)
  out.push(...approvalProblems(d.approval, d.targetVersion, paths, ctx.textOf))
  const pr = d.adversarial?.pr
  if (!Number.isInteger(pr) || pr <= 0) out.push('adversarial.pr must name the PR whose ADR-009 PASS covers this diff')
  // The list: exactly the non-neutral paths changed since boundHead, by exact string.
  if (paths.length === 0 || paths.length > CARRY_FORWARD_MAX_PATHS) out.push(`paths must list 1 to ${CARRY_FORWARD_MAX_PATHS} files`)
  const exact = new Set<string>()
  for (const p of paths) {
    if (typeof p !== 'string' || !EXACT_PATH_RE.test(p)) out.push(`${String(p)}: not an exact repository path`)
    else if (bindingBreaks([p]).length === 0) out.push(`${p} is binding-neutral; declare only paths that break the binding`)
    else exact.add(p)
  }
  if (new Set(paths).size !== paths.length) out.push('paths lists a file twice')
  for (const p of ctx.breaks) if (!paths.includes(p)) out.push(`${p} changed after boundHead and is not declared`)
  for (const p of paths) if (!ctx.breaks.includes(p as string)) out.push(`${String(p)} is declared but not changed after boundHead`)
  // No link or submodule under src/, resources/ or a declared path, in the commit.
  out.push(...linkEntryProblems(ctx.git, paths.filter((p): p is string => typeof p === 'string' && p !== '')))
  // The named regression tests.
  for (const e of entries) out.push(...namedTestProblems(e, ctx.textOf))
  // A package file may change its version and nothing else.
  for (const p of exact) {
    const strip = VERSION_FREE.get(p)
    if (!strip) continue
    const before = parsedOrNull(fileAt(ctx.git, ctx.boundHead, p))
    const after = parsedOrNull(ctx.textOf(p))
    const same = typeof before === 'object' && before !== null && typeof after === 'object' && after !== null && isDeepStrictEqual(strip(before), strip(after))
    if (!same) out.push(`${p} changed more than its version since boundHead`)
  }
  // The size of what can ship (isCountedPath), since boundHead: lines added
  // plus deleted, no added line longer than CARRY_FORWARD_MAX_ADDED_LINE, and
  // no more than CARRY_FORWARD_MAX_ADDED_BYTES added in all.
  const counted = [...exact].filter(isCountedPath)
  const lines = changedLines(ctx.git, ctx.boundHead, counted)
  if (lines === null) out.push('a counted declared file is binary, or git gave a line count that cannot be read')
  else if (lines > CARRY_FORWARD_MAX_SHIPPED_LINES) out.push(`${lines} lines changed in counted paths since boundHead; at most ${CARRY_FORWARD_MAX_SHIPPED_LINES} carry forward`)
  const added = addedLines(ctx.git, ctx.boundHead, counted)
  for (const l of longOf(added, CARRY_FORWARD_MAX_ADDED_LINE)) out.push(`${l}, over the ${CARRY_FORWARD_MAX_ADDED_LINE} a carry-forward allows`)
  const bytes = addedBytes(added)
  if (bytes > CARRY_FORWARD_MAX_ADDED_BYTES) out.push(`${bytes} bytes added in counted paths since boundHead; at most ${CARRY_FORWARD_MAX_ADDED_BYTES} carry forward`)
  return out
}

export type BindingVerdict = { problems: string[]; message: string; carried: boolean }

/** The candidate case's final assertion. No declaration: nothing but neutral
 *  paths may have changed since boundHead, with the message the case always
 *  gave. A declaration, sound or not, is judged by carryForwardProblems. */
export function bindingVerdict(breaks: readonly string[], carryText: string | null, ctx: Omit<CarryForwardContext, 'breaks'>): BindingVerdict {
  if (carryText === null) {
    return { problems: [...breaks], message: `changed after evidence collection; regenerate the affected records:\n${breaks.join('\n')}`, carried: false }
  }
  const problems = carryForwardProblems(carryText, { ...ctx, breaks })
  return { problems, message: `the carry-forward declaration does not hold (ADR-027):\n${problems.join('\n')}`, carried: problems.length === 0 }
}
