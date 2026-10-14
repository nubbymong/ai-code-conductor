// WP1.70: the candidate check's binding and item-status rules, as pure
// functions over data. traceability.test.ts runs them on this repository; its
// [host] cases run them on injected lists, files and an injected git, so they
// spawn nothing. The ancestry verdict lives in
// scripts/wp1/fetch-ledger-commit.mjs, which deepens a shallow checkout before
// the suite runs, so the script and the test can never disagree on what
// "decidable" means.
import { ancestry, SHA_RE } from '../../scripts/wp1/fetch-ledger-commit.mjs'

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

/** Every path changed between base and HEAD: NUL-separated (no quoting of
 *  unusual names) and without rename pairing (a file moved out of src still
 *  lists its old path). */
export function changedPaths(git: Git, base: string): string[] {
  const r = git(['diff', '--name-only', '--no-renames', '-z', `${base}..HEAD`])
  if (r.status !== 0) throw new Error(`git diff ${base}..HEAD exited ${r.status}: ${r.stderr ?? ''}`)
  return r.stdout.split('\0').filter(Boolean)
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
