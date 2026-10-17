import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// release-gate.mjs is plain ESM and guards main() behind an argv[1] check, so
// importing it here pulls in the pure verdict logic without touching GitHub.
// Everything external (the REST list calls) is injected through `listAll`.
import {
  evaluateMilestone,
  evaluateModels,
  evaluateCodexModels,
  formatReport,
  registryIdCovers,
  repoFromUrl,
  repoFromPackageJson,
  runGate,
  githubListAll,
  resolveToken,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_CANNOT_EVALUATE,
  EXCLUDED_LABEL,
  DEFAULT_REGISTRY_PATH,
  DEFAULT_EXPECTED_PATH,
  DEFAULT_CODEX_EXPECTED_PATH,
  DEFAULT_MACOS_FLOORS_PATH,
  evaluateMacosFloor,
  electronVersionOf,
  readElectronVersion,
  DEFAULT_LOCK_PATH,
  DEFAULT_CARRY_FORWARD_PATH,
  MARKER_RE,
  TEST_CHECK_RE,
  TEST_OS_FAMILIES,
  TRUSTED_ASSOCIATIONS,
  carryForwardApplies,
  evaluateCarryForward,
  githubGet,
  listCheckRuns,
  readCarryForwardApi,
  readCarryForwardFile,
} from '../../../scripts/release-gate.mjs'

type Issue = { number: number; title: string; labels?: Array<{ name: string } | string>; pull_request?: object; state?: string }
type Milestone = { number: number; title: string; state?: string }

const EXPECTED = {
  source: 'https://example.test/article',
  fetchedAt: '2026-08-22',
  models: [
    { label: 'Opus 4.8', id: 'claude-opus-4-8' },
    { label: 'Sonnet 4.6', id: 'claude-sonnet-4-6' },
    { label: 'Haiku 4.5', id: 'claude-haiku-4-5-20251001' },
  ],
}

const REGISTRY_OK = {
  models: [
    { id: 'claude-opus-4-8', family: 'opus', label: 'Opus 4.8' },
    { id: 'claude-sonnet-4-6', family: 'sonnet', label: 'Sonnet 4.6' },
    { id: 'claude-haiku-4-5', family: 'haiku', label: 'Haiku 4.5' },
    { id: 'codex-family', family: 'codex', label: 'Codex', pickable: false },
    { id: 'gpt-5.5', family: 'codex', label: 'GPT-5.5' },
  ],
}

// The Codex half's list (P3.8 round 1, G1): resources/codex-model-catalogue.json's shape.
const CODEX_EXPECTED = {
  source: 'the model catalogue bundled with the Codex CLI',
  cliVersions: ['0.155.1'],
  fetchedAt: '2026-09-29',
  models: [{ label: 'GPT-5.5', id: 'gpt-5.5' }],
}

/** A fake GitHub: one milestone list, issues keyed by milestone number. */
function fakeGitHub(milestones: Milestone[], issuesByMilestone: Record<number, Issue[]>) {
  const calls: string[] = []
  const listAll = async (p: string): Promise<unknown[]> => {
    calls.push(p)
    if (p.startsWith('/repos/o/r/milestones')) return milestones
    const m = /\/repos\/o\/r\/issues\?milestone=(\d+)&state=open/.exec(p)
    if (m) return issuesByMilestone[Number(m[1])] ?? []
    throw new Error(`unexpected path ${p}`)
  }
  return { listAll, calls }
}

const silent = () => {}

// The macOS floor half (check 4): resources/macos-release-floors.json's shape.
const FLOORS = { floors: [{ fromTag: 'v2.1.1-beta.2', electronMajor: 44, macosMajor: 13 }] }
/** An Electron that needs no macOS floor, so the other checks decide (their cases' versions predate any floor). */
const MAC_OK = { electronVersion: '43.7.1', macosFloors: FLOORS }

// ── evaluateMilestone ──────────────────────────────────────────────
describe('release-gate evaluateMilestone', () => {
  const milestones: Milestone[] = [{ number: 7, title: '2.1.0-beta.17' }, { number: 8, title: '2.2' }]

  it('passes a milestone with no open issues', () => {
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues: [] })
    expect(r.ok).toBe(true)
    expect(r.milestone?.number).toBe(7)
    expect(r.blocking).toEqual([])
  })

  it('fails and lists every open issue that is not excluded, ascending', () => {
    const issues: Issue[] = [
      { number: 385, title: 'Model picker', labels: [{ name: 'bug' }] },
      { number: 358, title: 'Command bar', labels: [{ name: 'enhancement' }, { name: 'ux' }] },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(false)
    expect(r.blocking.map((i) => i.number)).toEqual([358, 385])
    expect(r.blocking[0].labels).toEqual(['enhancement', 'ux'])
    expect(r.reason).toContain('2 open issue(s)')
  })

  it('ignores issues carrying the excluded label (owner-excluded from the gate)', () => {
    const issues: Issue[] = [
      { number: 374, title: 'GPU rendering', labels: [{ name: EXCLUDED_LABEL }, { name: 'enhancement' }] },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(true)
    expect(r.excluded.map((i) => i.number)).toEqual([374])
  })

  it('accepts labels as plain strings too', () => {
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues: [{ number: 1, title: 'x', labels: ['excluded'] }] })
    expect(r.ok).toBe(true)
  })

  it('an open in-beta issue is DONE for this release, not outstanding — the lifecycle keeps it open until promotion', () => {
    const issues: Issue[] = [
      { number: 373, title: 'Canvas: per-note A/B/C approve', labels: [{ name: 'in-beta' }, { name: 'canvas' }] },
      { number: 377, title: 'Tips re-review', labels: [{ name: 'in-beta' }] },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(true)
    expect(r.shipped.map((i) => i.number)).toEqual([373, 377])
    expect(r.blocking).toEqual([])
  })

  it('an open in-release issue (rolled into an rc) is likewise DONE, not outstanding', () => {
    const issues: Issue[] = [
      { number: 373, title: 'rolled into rc.1', labels: [{ name: 'in-release' }] },
      { number: 377, title: 'merged after the rc cut', labels: [{ name: 'in-beta' }] },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(true)
    expect(r.shipped.map((i) => i.number)).toEqual([373, 377])
    expect(r.blocking).toEqual([])
  })

  it('the FAIL report lists blockers, the shipped riders, and the in-beta remediation route', () => {
    const issues: Issue[] = [
      { number: 373, title: 'shipped', labels: ['in-beta'] },
      { number: 412, title: 'still outstanding', labels: ['enhancement'] },
    ]
    const mr = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    const text = formatReport({ version: '2.1.0-beta.17', repo: 'o/r', milestoneResult: mr, modelsResult: null, expectedMeta: null }).join('\n')
    expect(text).toContain('#412  still outstanding')
    expect(text).toContain('(in-beta/in-release, shipping in this release: #373)')
    expect(text).toContain('Merge their fixes (label "in-beta")')
    expect(mr.reason).toContain('"in-release"')
  })

  it('the OK report names what is shipping', () => {
    const mr = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues: [{ number: 373, title: 's', labels: ['in-beta'] }] })
    const text = formatReport({ version: '2.1.0-beta.17', repo: 'o/r', milestoneResult: mr, modelsResult: null, expectedMeta: null }).join('\n')
    expect(text).toContain('has no outstanding issues')
    expect(text).toContain('(1 shipping in this release: #373)')
  })

  it('an issue carrying BOTH labels lands in excluded — the stronger owner claim wins', () => {
    const issues: Issue[] = [{ number: 1, title: 'x', labels: ['excluded', 'in-beta'] }]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(true)
    expect(r.excluded.map((i) => i.number)).toEqual([1])
    expect(r.shipped).toEqual([])
  })

  it('an in-beta issue does not shield a genuinely open one beside it', () => {
    const issues: Issue[] = [
      { number: 373, title: 'shipped', labels: [{ name: 'in-beta' }] },
      { number: 412, title: 'still outstanding', labels: [{ name: 'enhancement' }] },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(false)
    expect(r.blocking.map((i) => i.number)).toEqual([412])
    expect(r.shipped.map((i) => i.number)).toEqual([373])
    expect(r.reason).toContain('"in-beta"')
  })

  it('ignores pull requests and non-open items on the milestone', () => {
    const issues: Issue[] = [
      { number: 390, title: 'feat: something', pull_request: { url: 'x' } },
      { number: 391, title: 'closed already', state: 'closed' },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(true)
  })

  it('fails CLOSED when no milestone carries the version as its title', () => {
    const r = evaluateMilestone({ version: '2.1.0-beta.18', milestones, issues: [] })
    expect(r.ok).toBe(false)
    expect(r.milestone).toBeNull()
    expect(r.reason).toMatch(/no GitHub milestone titled "2.1.0-beta.18"/)
  })

  it('matches the milestone title exactly — "2.2" is not "2.2.0"', () => {
    expect(evaluateMilestone({ version: '2.2.0', milestones, issues: [] }).ok).toBe(false)
    expect(evaluateMilestone({ version: ' 2.2 ', milestones, issues: [] }).ok).toBe(true)
  })
})

// ── evaluateModels ─────────────────────────────────────────────────
describe('release-gate evaluateModels', () => {
  it('passes when every article model is covered (dated article ids resolve to the undated registry entry)', () => {
    const r = evaluateModels({ registry: REGISTRY_OK, expected: EXPECTED })
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.covered).toContainEqual({ id: 'claude-haiku-4-5-20251001', by: 'claude-haiku-4-5' })
    expect(r.extra).toEqual([])   // codex-family is not a Claude model
  })

  it('fails with the missing ids when the article names a model the registry lacks', () => {
    const registry = { models: REGISTRY_OK.models.filter((m) => m.id !== 'claude-sonnet-4-6') }
    const r = evaluateModels({ registry, expected: EXPECTED })
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }])
  })

  it('flags (but does not fail on) a registry Claude model the article no longer lists', () => {
    const registry = { models: [...REGISTRY_OK.models, { id: 'claude-opus-4-8-fast', family: 'opus', label: 'Opus 4.8 Fast' }] }
    const r = evaluateModels({ registry, expected: EXPECTED })
    expect(r.ok).toBe(true)
    expect(r.extra).toEqual([{ id: 'claude-opus-4-8-fast', label: 'Opus 4.8 Fast' }])
  })

  it('FAILS CLOSED when the expected-models fixture is empty or missing — a truncated fixture must not vacuously pass', () => {
    for (const expected of [{ models: [] }, {}, null, undefined]) {
      const r = evaluateModels({ registry: REGISTRY_OK, expected })
      expect(r.ok, JSON.stringify(expected)).toBe(false)
      expect(r.reason).toMatch(/empty or missing|cannot verify|fail closed/i)
    }
  })

  it('registryIdCovers: equal, or equal minus a -YYYYMMDD suffix — nothing looser', () => {
    expect(registryIdCovers('claude-opus-4-5', 'claude-opus-4-5-20251101')).toBe(true)
    expect(registryIdCovers('claude-opus-4-5', 'claude-opus-4-5')).toBe(true)
    // a bare family id must NOT cover a versioned one — that is the #385 bug shape
    expect(registryIdCovers('claude-opus', 'claude-opus-4-5-20251101')).toBe(false)
    expect(registryIdCovers('claude-opus-4', 'claude-opus-4-5')).toBe(false)
    expect(registryIdCovers('claude-opus-4-5', 'claude-opus-4-5-fast')).toBe(false)
  })
})

// ── runGate (mocked GitHub) ────────────────────────────────────────
describe('release-gate runGate', () => {
  it('clean milestone + covered registry → exit 0 with a PASS line', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] })
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_OK)
    expect(r.lines.at(-1)).toMatch(/^PASS/)
    expect(gh.calls).toEqual(['/repos/o/r/milestones?state=all', '/repos/o/r/issues?milestone=7&state=open'])
  })

  it('open issue → exit 1 and the issue is printed by number and title', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [{ number: 377, title: 'Tips re-review', labels: [{ name: 'ux' }] }] })
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/#377\s+Tips re-review\s+\[ux\]/)
    expect(r.lines.at(-1)).toMatch(/^REFUSED/)
  })

  it('excluded label ignored → exit 0, and the excluded issue is named in the OK line', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [{ number: 374, title: 'GPU', labels: [{ name: 'excluded' }] }] })
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_OK)
    expect(r.lines.join('\n')).toMatch(/excluded by the owner: #374/)
  })

  it('missing milestone → exit 1 (fails closed) and never queries issues', async () => {
    const gh = fakeGitHub([{ number: 8, title: '2.2' }], {})
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/no GitHub milestone titled "2.1.0-beta.17"/)
    expect(gh.calls).toEqual(['/repos/o/r/milestones?state=all'])
  })

  it('model check fails → exit 1 even when the milestone is clean, with a diff of the missing ids', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] })
    const registry = { models: REGISTRY_OK.models.filter((m) => m.id !== 'claude-opus-4-8') }
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    const text = r.lines.join('\n')
    expect(text).toMatch(/OK\s+milestone/)
    expect(text).toMatch(/FAIL\s+model registry/)
    expect(text).toMatch(/- claude-opus-4-8\s+\(Opus 4.8\)/)
  })

  it('model check passes → the OK line says how many models are covered', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] })
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.lines.join('\n')).toMatch(/OK\s+model registry covers all 3 supported Claude Code models/)
  })

  it('GitHub unreachable → exit 2 (cannot evaluate), not a pass', async () => {
    const listAll = async () => { throw new Error('GitHub API 503 for /repos/o/r/milestones?state=all') }
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE)
    expect(r.lines[0]).toMatch(/CANNOT EVALUATE/)
  })

  it('no version / no repo → exit 2', async () => {
    const gh = fakeGitHub([], {})
    expect((await runGate({ version: '', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })).exitCode).toBe(EXIT_CANNOT_EVALUATE)
    expect((await runGate({ version: '1.0.0', repo: null, listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })).exitCode).toBe(EXIT_CANNOT_EVALUATE)
  })
})

// -- the Codex half (P3.8 round 1, G1) --
describe('release-gate Codex models', () => {
  const clean = () => fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] })

  it('a Codex model the list names but the registry lacks -> exit 1, with a diff, even when everything else is clean', async () => {
    const codexExpected = { ...CODEX_EXPECTED, models: [...CODEX_EXPECTED.models, { label: 'GPT-6-Astra', id: 'gpt-6-astra' }] }
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    const text = r.lines.join('\n')
    expect(text).toMatch(/OK\s+milestone/)
    expect(text).toMatch(/OK\s+model registry covers all 3/)
    expect(text).toMatch(/FAIL\s+Codex models: 1 model\(s\) the Codex CLI lists are not in the registry/)
    expect(text).toMatch(/- gpt-6-astra\s+\(GPT-6-Astra\)/)
    expect(r.codexResult?.missing.map((m: { id: string }) => m.id)).toEqual(['gpt-6-astra'])
  })

  it('a Codex model the list no longer names is a WARNING, not a refusal', async () => {
    const registry = { models: [...REGISTRY_OK.models, { id: 'gpt-5.2', family: 'codex', label: 'GPT-5.2' }] }
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_OK)
    expect(r.lines.join('\n')).toMatch(/WARN\s+gpt-5\.2 \(GPT-5\.2\) is a Codex model in the registry but the Codex list no longer names it/)
  })

  it('the OK line says how many Codex models are covered and from which CLI versions', async () => {
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_OK)
    expect(r.lines.join('\n')).toMatch(/OK\s+Codex models: the registry covers all 1 models Codex 0\.155\.1 lists \(list read 2026-09-29\)/)
  })

  it('FAILS CLOSED when the Codex list is missing or empty: a caller that forgets it cannot pass', async () => {
    for (const codexExpected of [undefined, null, { models: [] }, { models: [{ id: '' }] }]) {
      const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected, ...MAC_OK, log: silent })
      expect(r.exitCode).toBe(EXIT_REFUSED)
      expect(r.lines.join('\n')).toMatch(/FAIL\s+Codex models: the expected Codex models list is empty or missing/)
    }
  })

  it('a Codex id the registry lists twice refuses, and the report names it (round 2, GS)', async () => {
    const registry = { models: [{ id: 'gpt-5.5', family: 'opus', label: 'x' }, ...REGISTRY_OK.models] }
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] }).listAll, registry, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/gpt-5\.5 is listed more than once in resources\/model-registry\.json/)
  })

  it('a malformed Codex list refuses rather than throwing (round 2, GS)', async () => {
    for (const codexExpected of [{ models: {} }, { models: 'gpt-5.5' }, { models: [{ id: 42 }] }]) {
      const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] }).listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected, ...MAC_OK, log: silent })
      expect(r.exitCode, JSON.stringify(codexExpected)).toBe(EXIT_REFUSED)
    }
  })

  it('only the codex family counts: a Claude-family entry with a Codex id does not cover it', () => {
    const registry = { models: [{ id: 'gpt-5.5', family: 'opus', label: 'x' }] }
    const r = evaluateCodexModels({ registry, expected: CODEX_EXPECTED })
    expect(r.ok).toBe(false)
    expect(r.missing.map((m: { id: string }) => m.id)).toEqual(['gpt-5.5'])
  })

  it('main reads the Codex list from the shipped catalogue by default', () => {
    expect(resolve(DEFAULT_CODEX_EXPECTED_PATH)).toMatch(/resources[\\/]codex-model-catalogue\.json$/)
    const list = JSON.parse(readFileSync(DEFAULT_CODEX_EXPECTED_PATH, 'utf-8'))
    const registry = JSON.parse(readFileSync(DEFAULT_REGISTRY_PATH, 'utf-8'))
    expect(evaluateCodexModels({ registry, expected: list }).ok).toBe(true)
  })
})

// -- the macOS floor (check 4, Electron 44 needs macOS 13) --
describe('release-gate macOS floor', () => {
  const clean = () => fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] })
  const gate = (version: string, electronVersion: string | undefined, macosFloors: unknown = FLOORS) =>
    evaluateMacosFloor({ version, electronVersion, floors: macosFloors })

  it('an Electron 44 build is refused under a tag whose floor is below macOS 13: the updater would offer it to Macs that cannot open it', () => {
    const r = gate('2.1.1-beta.1', '44.5.1')
    expect(r.ok).toBe(false)
    expect(r.needed).toBe(13)
    expect(r.floor).toBe(0)
    expect(r.reason).toMatch(/Electron 44 needs macOS 13, but v2\.1\.1-beta\.1 has no macOS floor/)
  })

  it('an Electron 44 build passes under a tag at or after the floor, the bare -beta tag release.yml cuts from a final version included', () => {
    for (const v of ['2.1.1-beta.2', '2.1.1-beta.3', '2.1.1-rc.1', '2.1.1', '2.1.1-beta', '2.2.0-beta.1']) {
      const r = gate(v, '44.5.1')
      expect(r.ok, v).toBe(true)
      expect(r.floor, v).toBe(13)
    }
  })

  it('an Electron with no floor of its own passes under any tag', () => {
    for (const v of ['2.1.0-beta.17', '2.1.1-beta.1', '2.1.1']) expect(gate(v, '43.7.1').ok, v).toBe(true)
  })

  it('a tag no updater offers (a dev cut) is not held to a floor', () => {
    const r = gate('2.1.1-dev', '44.5.1')
    expect(r.ok).toBe(true)
    expect(r.offered).toBe(false)
  })

  it('a later Electron is held to its own entry', () => {
    const floors = { floors: [...FLOORS.floors, { fromTag: 'v3.0.0-beta.1', electronMajor: 45, macosMajor: 14 }] }
    expect(gate('3.0.0-beta.1', '45.0.0', floors).ok).toBe(true)
    const r = gate('2.9.0', '45.0.0', floors)
    expect(r.ok).toBe(false)
    expect(r.needed).toBe(14)
    expect(r.floor).toBe(13)
  })

  it('FAILS CLOSED when the floors file or the Electron version cannot be read', () => {
    for (const floors of [undefined, null, {}, { floors: [] }, { floors: 'x' }]) {
      const r = evaluateMacosFloor({ version: '2.1.1-beta.2', electronVersion: '44.5.1', floors })
      expect(r.ok, JSON.stringify(floors)).toBe(false)
      expect(r.reason).toMatch(/resources\/macos-release-floors\.json lists no floors/)
    }
    for (const electron of [undefined, '', 'latest']) {
      const r = gate('2.1.1-beta.2', electron)
      expect(r.ok, String(electron)).toBe(false)
      expect(r.reason).toMatch(/cannot read the Electron version/)
    }
  })

  it('a floors entry it cannot read is refused with a FAIL line, never left out', async () => {
    const good = FLOORS.floors[0]
    const unreadable: unknown[] = [
      { fromTag: 'v1.0.0' },
      { fromTag: 'garbage', electronMajor: 44, macosMajor: 13 },
      { fromTag: 'v2.1.1-beta.2', electronMajor: '44', macosMajor: 13 },
      { fromTag: 'v2.1.1-beta.2', electronMajor: 44, macosMajor: 13.5 },
      { fromTag: 'v2.1.1-beta.2', electronMajor: 44, macosMajor: 0 },
      null,
      'v2.1.1-beta.2',
    ]
    for (const entry of unreadable) {
      for (const floors of [{ floors: [entry] }, { floors: [good, entry] }]) {
        const r = gate('2.1.1-beta.2', '44.5.1', floors)
        expect(r.ok, JSON.stringify(floors)).toBe(false)
        expect(r.reason, JSON.stringify(floors)).toMatch(/resources\/macos-release-floors\.json entry \d+ cannot be read/)
      }
    }
    const gh = fakeGitHub([{ number: 7, title: '2.1.1-beta.2' }], { 7: [] })
    const run = await runGate({ version: '2.1.1-beta.2', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, electronVersion: '44.5.1', macosFloors: { floors: [good, { fromTag: 'v3.0.0' }] }, log: silent })
    expect(run.exitCode).toBe(EXIT_REFUSED)
    expect(run.lines.join('\n')).toMatch(/FAIL\s+macOS floor: resources\/macos-release-floors\.json entry 2 cannot be read/)
  })

  it('the Electron version must be exact: a range (what package.json may hold) is refused, never read as its lower bound', () => {
    for (const range of ['>=43.0.0', '43.x || 44.x', '^43.7.1', '~43.7.1', '43', '43.x', '43.7', 'v43.7.1', '43.7.1 || 44.5.1']) {
      const r = gate('2.1.0', range)
      expect(r.ok, range).toBe(false)
      expect(r.reason, range).toMatch(/cannot read the Electron version package-lock\.json resolves/)
    }
    for (const exact of ['43.7.1', '44.5.1', '45.0.0-beta.3', '44.5.1+build.7']) expect(gate('2.1.1-beta.2', exact).ok, exact).toBe(true)
  })


  it('runGate refuses the cut, with a FAIL line, even when everything else is clean', async () => {
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, electronVersion: '44.5.1', macosFloors: FLOORS, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    const text = r.lines.join('\n')
    expect(text).toMatch(/OK\s+milestone/)
    expect(text).toMatch(/FAIL\s+macOS floor: Electron 44 needs macOS 13, but v2\.1\.0-beta\.17 has no macOS floor/)
    expect(r.lines.at(-1)).toMatch(/^REFUSED/)
  })

  it('runGate says what the floor is when it passes, and refuses a caller that leaves the floor inputs out', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.1-beta.2' }], { 7: [] })
    const ok = await runGate({ version: '2.1.1-beta.2', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, electronVersion: '44.5.1', macosFloors: FLOORS, log: silent })
    expect(ok.exitCode).toBe(EXIT_OK)
    expect(ok.lines.join('\n')).toMatch(/OK\s+macOS floor: v2\.1\.1-beta\.2 needs macOS 13 or later, as Electron 44 does/)
    const left = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, log: silent })
    expect(left.exitCode).toBe(EXIT_REFUSED)
  })

  it('main reads the Electron version package-lock.json resolves, and the floors from the shipped file', () => {
    expect(resolve(DEFAULT_MACOS_FLOORS_PATH)).toMatch(/resources[\\/]macos-release-floors\.json$/)
    expect(resolve(DEFAULT_LOCK_PATH)).toBe(resolve(__dirname, '../../../package-lock.json'))
    expect(electronVersionOf({ packages: { '': { devDependencies: { electron: '>=43.0.0' } }, 'node_modules/electron': { version: '44.5.1' } } })).toBe('44.5.1')
    for (const lock of [{}, null, undefined, { packages: {} }, { packages: { 'node_modules/electron': {} } }, { packages: { 'node_modules/electron': { version: 44 } } }]) {
      expect(electronVersionOf(lock as never), JSON.stringify(lock)).toBeUndefined()
    }
    // package.json's own shape is never read for it
    expect(electronVersionOf({ devDependencies: { electron: '44.5.1' } } as never)).toBeUndefined()
  })

  it('a package.json range with a lock that resolves Electron 44: the lock decides, so an earlier tag is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-lock-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { electron: '>=43.0.0' } }))
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: { '': { devDependencies: { electron: '>=43.0.0' } }, 'node_modules/electron': { version: '44.5.1' } } }))
      const electronVersion = readElectronVersion(join(dir, 'package-lock.json'))
      expect(electronVersion).toBe('44.5.1')
      const r = gate('2.1.0', electronVersion)
      expect(r.ok).toBe(false)
      expect(r.reason).toMatch(/Electron 44 needs macOS 13, but v2\.1\.0 has no macOS floor/)
      writeFileSync(join(dir, 'broken-lock.json'), '{ "packages": ')
      for (const p of [join(dir, 'no-such-lock.json'), join(dir, 'broken-lock.json')]) {
        expect(readElectronVersion(p), p).toBeUndefined()
        expect(gate('2.1.1-beta.2', readElectronVersion(p)).ok, p).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('with the real lock and floors file: this Electron cannot be cut as 2.1.1-beta.1, and can as 2.1.1-beta.2, 2.1.1-beta and 2.1.1', () => {
    const floors = JSON.parse(readFileSync(DEFAULT_MACOS_FLOORS_PATH, 'utf-8'))
    const electronVersion = readElectronVersion()
    const installed = JSON.parse(readFileSync(resolve(__dirname, '../../../node_modules/electron/package.json'), 'utf-8')).version
    expect(electronVersion).toBe(installed)
    expect(parseInt(String(electronVersion), 10)).toBeGreaterThanOrEqual(44)
    expect(evaluateMacosFloor({ version: '2.1.1-beta.1', electronVersion, floors }).ok).toBe(false)
    for (const v of ['2.1.1-beta.2', '2.1.1-beta', '2.1.1']) expect(evaluateMacosFloor({ version: v, electronVersion, floors }).ok, v).toBe(true)
  })
})

// -- the carry-forward (check 5, ADR-027) --
describe('release-gate carry-forward (check 5)', () => {
  const SHA = 'a'.repeat(40)
  const HEAD = 'b'.repeat(40)
  const BASE = '9'.repeat(40)
  const decl = (over: Record<string, unknown> = {}) => ({
    schema: 'wp1-carry-forward/1', targetVersion: '2.1.2',
    base: { tag: 'v2.1.1', version: '2.1.1', commit: BASE, boundHead: 'd'.repeat(40) }, adversarial: { pr: 650 }, ...over,
  })
  const leg = (os: string, over: Record<string, unknown> = {}) => ({ name: `Test (${os})`, app: { slug: 'github-actions' }, head_sha: SHA, status: 'completed', conclusion: 'success', ...over })
  const GREEN = [leg('windows-2025'), leg('macos-latest'), leg('ubuntu-latest')]
  const PULL = { number: 650, merged: true, merge_commit_sha: SHA, head: { sha: HEAD } }
  const marker = (verdict: string, head = HEAD, pr = 650) => `ADVERSARIAL-REVIEW v1 | ${verdict} | pr=#${pr} | head=${head} | content=${'c'.repeat(64)} | 0 blockers, 0 majors open`
  const comment = (body: string, over: Record<string, unknown> = {}) => ({ id: 1, created_at: '2026-10-17T10:00:00Z', author_association: 'OWNER', body, ...over })
  const TAG = { ref: 'refs/tags/v2.1.1', object: { type: 'commit', sha: BASE } }
  const data = (over: Record<string, unknown> = {}) => ({ checkRuns: GREEN, pull: PULL, comments: [comment(`${marker('PASS')}\n\nNo findings open.`)], tagRef: TAG, ...over })
  const verdict = (over: Record<string, unknown> = {}, declaration: unknown = decl()) => evaluateCarryForward({ version: '2.1.2', sha: SHA, declaration, ...data(over) })
  const gh = () => fakeGitHub([{ number: 9, title: '2.1.2' }], { 9: [] })
  const gate = (o: Record<string, unknown>) => runGate({ version: '2.1.2', repo: 'o/r', listAll: gh().listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, sha: SHA, log: silent, ...o })

  it('check 5 is a no-op with no declaration, or one for another version, and reads nothing from GitHub', async () => {
    expect(evaluateCarryForward({ version: '2.1.2', sha: SHA, declaration: null })).toEqual({ ok: true, applies: false, problems: [] })
    for (const version of ['2.1.3', '2.1.2-beta', '2.2.0']) expect(carryForwardApplies(version, decl()), version).toBe(false)
    expect(carryForwardApplies('2.1.2', decl())).toBe(true)
    for (const d of [null, undefined, 'x', [], {}]) expect(carryForwardApplies('2.1.2', d), JSON.stringify(d)).toBe(false)
    let reads = 0
    const readCarryForward = async () => { reads++; return data() }
    const none = await gate({ carryForward: null, readCarryForward })
    expect(none.exitCode).toBe(EXIT_OK)
    expect(none.lines.join('\n')).not.toMatch(/carry-forward/)
    const other = await gate({ carryForward: decl({ targetVersion: '2.1.3' }), readCarryForward })
    expect(other.exitCode).toBe(EXIT_OK)
    expect(reads).toBe(0)
  })

  it('check 5 passes with the three Test legs green on this commit, the PR merged as it with a PASS at its head, and the base tag on the base commit', async () => {
    const r = verdict()
    expect(r).toMatchObject({ ok: true, applies: true, problems: [], pr: 650, head: HEAD, tag: 'v2.1.1', base: BASE })
    expect(r.families).toEqual({ windows: ['Test (windows-2025)'], macos: ['Test (macos-latest)'], ubuntu: ['Test (ubuntu-latest)'] })
    const seen: unknown[] = []
    const run = await gate({ carryForward: decl(), readCarryForward: async (input: unknown) => { seen.push(input); return data() } })
    expect(run.exitCode).toBe(EXIT_OK)
    expect(seen).toEqual([{ repo: 'o/r', sha: SHA, declaration: decl() }])
    expect(run.lines.join('\n')).toMatch(/OK\s+carry-forward: Test green on windows, macos, ubuntu; PR #650 merged as this commit, ADR-009 PASS at its head bbbbbbbbbbbb; v2\.1\.1 is 999999999999/)
    expect(run.lines.at(-1)).toMatch(/^PASS/)
  })

  it('check 5a refuses a missing OS family, a leg that is red, cancelled or still running, and a leg from another app or another commit', () => {
    const NO_MAC = `no "Test (macos-...)" run from GitHub Actions on ${SHA}`
    expect(verdict({ checkRuns: [GREEN[0], GREEN[2]] }).problems).toEqual([NO_MAC])
    expect(verdict({ checkRuns: [] }).problems).toEqual(TEST_OS_FAMILIES.map((f) => `no "Test (${f}-...)" run from GitHub Actions on ${SHA}`))
    for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required', null]) {
      expect(verdict({ checkRuns: [GREEN[0], leg('macos-latest', { conclusion }), GREEN[2]] }).problems, String(conclusion)).toEqual([`Test (macos-latest) on ${SHA} is ${conclusion}, not green`])
    }
    for (const status of ['in_progress', 'queued', 'waiting']) {
      expect(verdict({ checkRuns: [GREEN[0], leg('macos-latest', { status, conclusion: null }), GREEN[2]] }).problems, status).toEqual([`Test (macos-latest) on ${SHA} is ${status}, not green`])
    }
    // A green leg beside a red one of the same family does not hide it.
    expect(verdict({ checkRuns: [...GREEN, leg('macos-15', { conclusion: 'failure' })] }).problems).toEqual([`Test (macos-15) on ${SHA} is failure, not green`])
    // Only GitHub Actions runs of this commit, named as ci.yml names its Test legs, count.
    for (const mac of [leg('macos-latest', { app: { slug: 'some-other-app' } }), leg('macos-latest', { app: null }), leg('macos-latest', { head_sha: HEAD }),
      { ...leg('macos-latest'), name: 'Test (macos)' }, { ...leg('macos-latest'), name: 'Conformance (macos-latest)' }, { ...leg('macos-latest'), name: 'Test (macos-latest) extra' }]) {
      expect(verdict({ checkRuns: [GREEN[0], mac, GREEN[2]] }).problems, JSON.stringify(mac)).toEqual([NO_MAC])
    }
    expect(evaluateCarryForward({ version: '2.1.2', sha: 'HEAD', declaration: decl(), ...data() }).problems).toContainEqual('the release commit "HEAD" is not a 40-hex commit id')
  })

  it('check 5b refuses a PR not merged as this commit, and a latest trusted verdict that is not a PASS at the final head', () => {
    const NOT_MERGED = `PR #650 is not merged as ${SHA}`
    for (const pull of [{ ...PULL, merged: false }, { ...PULL, merge_commit_sha: HEAD }, { ...PULL, number: 651 }, null]) {
      expect(verdict({ pull }).problems, JSON.stringify(pull)).toContainEqual(NOT_MERGED)
    }
    const at = (n: number) => `2026-10-17T1${n}:00:00Z`
    expect(verdict({ comments: [comment(marker('PASS'), { id: 1, created_at: at(0) }), comment(marker('FINDINGS'), { id: 2, created_at: at(1) })] }).problems).toEqual(['the latest ADR-009 verdict on PR #650 is FINDINGS'])
    expect(verdict({ comments: [comment(marker('FINDINGS'), { id: 1, created_at: at(0) }), comment(marker('PASS'), { id: 2, created_at: at(1) })] }).problems).toEqual([])
    // Latest by time, not by the order of the list.
    expect(verdict({ comments: [comment(marker('FINDINGS'), { id: 2, created_at: at(1) }), comment(marker('PASS'), { id: 1, created_at: at(0) })] }).problems).toEqual(['the latest ADR-009 verdict on PR #650 is FINDINGS'])
    // A PASS for an older head: the PR moved after the pass.
    expect(verdict({ comments: [comment(marker('PASS', 'e'.repeat(40)))] }).problems).toEqual([`the ADR-009 PASS on PR #650 is for ${'e'.repeat(40)}, not its final head ${HEAD}`])
    // Only an owner, member or collaborator posts a verdict that counts.
    const NO_MARKER = 'PR #650 has no ADR-009 verdict marker from an owner, member or collaborator'
    expect([...TRUSTED_ASSOCIATIONS]).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR'])
    for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', undefined]) {
      expect(verdict({ comments: [comment(marker('PASS'), { author_association: association })] }).problems, String(association)).toEqual([NO_MARKER])
    }
    expect(verdict({ comments: [comment(marker('FINDINGS'), { created_at: at(0) }), comment(marker('PASS'), { id: 2, created_at: at(1), author_association: 'NONE' })] }).problems).toEqual(['the latest ADR-009 verdict on PR #650 is FINDINGS'])
    // The marker is the first line, for this PR, in the shape adv-marker.sh prints.
    for (const body of [`Looks good.\n${marker('PASS')}`, marker('PASS', HEAD, 651), marker('PASS').replace('pr=#650', 'pr=#-'), marker('PASS').replace('v1', 'v2'), ` ${marker('PASS')}`, '', null]) {
      expect(verdict({ comments: [comment(body as string)] }).problems, String(body)).toEqual([NO_MARKER])
    }
    expect(verdict({ comments: [] }).problems).toEqual([NO_MARKER])
    expect(verdict({ comments: [comment(marker('PASS').replace(/\n.*/s, '') + '\r\nmore')] }).problems).toEqual([])
    for (const adversarial of [undefined, { pr: 0 }, { pr: '650' }]) {
      expect(verdict({}, decl({ adversarial })).problems, JSON.stringify(adversarial)).toEqual(['the declaration names no ADR-009 PR (adversarial.pr)'])
    }
  })

  it('check 5c refuses a base tag that is not the base commit, and dereferences an annotated tag once', () => {
    const T = 'f'.repeat(40)
    const NOT_BASE = (is: string) => `v2.1.1 is ${is}, not the declared base ${BASE}`
    expect(verdict({ tagRef: { ...TAG, object: { type: 'commit', sha: HEAD } } }).problems).toEqual([NOT_BASE(HEAD)])
    expect(verdict({ tagRef: { ref: 'refs/tags/v2.1.1', object: { type: 'tag', sha: T } }, tagObject: { sha: T, object: { type: 'commit', sha: BASE } } }).problems).toEqual([])
    expect(verdict({ tagRef: { ref: 'refs/tags/v2.1.1', object: { type: 'tag', sha: T } }, tagObject: { sha: T, object: { type: 'commit', sha: HEAD } } }).problems).toEqual([NOT_BASE(HEAD)])
    for (const tagObject of [undefined, { sha: HEAD, object: { type: 'commit', sha: BASE } }, { sha: T, object: { type: 'tag', sha: BASE } }]) {
      expect(verdict({ tagRef: { ref: 'refs/tags/v2.1.1', object: { type: 'tag', sha: T } }, tagObject }).problems, JSON.stringify(tagObject)).toEqual([NOT_BASE('not a tag of a commit')])
    }
    for (const tagRef of [{ ...TAG, ref: 'refs/tags/v2.1.10' }, { ...TAG, object: { type: 'tree', sha: BASE } }, { ref: TAG.ref }, null]) {
      expect(verdict({ tagRef }).problems, JSON.stringify(tagRef)).toEqual([NOT_BASE('not a tag of a commit')])
    }
    const short = decl({ base: { tag: 'v2.1.1', version: '2.1.1', commit: 'HEAD' } })
    expect(verdict({ tagRef: { ...TAG, object: { type: 'commit', sha: 'HEAD' } } }, short).problems).toEqual(['v2.1.1 is HEAD, not the declared base HEAD'])
  })

  it('check 5 cannot be evaluated on a GitHub error or with no reader, and asks GitHub only for well-formed values', async () => {
    const failed = await gate({ carryForward: decl(), readCarryForward: async () => { throw new Error('GitHub API 403 for /repos/o/r/pulls/650') } })
    expect(failed.exitCode).toBe(EXIT_CANNOT_EVALUATE)
    expect(failed.lines[0]).toMatch(/CANNOT EVALUATE .*could not read the carry-forward evidence from GitHub: GitHub API 403/)
    expect((await gate({ carryForward: decl() })).exitCode).toBe(EXIT_CANNOT_EVALUATE)
    // What the reader asks for.
    const T = 'f'.repeat(40)
    const asked: string[] = []
    const get = async (p: string) => {
      asked.push(p)
      if (p.includes('/check-runs')) return { total_count: 3, check_runs: GREEN }
      if (p.endsWith('/git/ref/tags/v2.1.1')) return { ref: 'refs/tags/v2.1.1', object: { type: 'tag', sha: T } }
      if (p.endsWith(`/git/tags/${T}`)) return { sha: T, object: { type: 'commit', sha: BASE } }
      return PULL
    }
    const listAll = async (p: string) => { asked.push(p); return [comment(marker('PASS'))] }
    const read = await readCarryForwardApi({ repo: 'o/r', sha: SHA, declaration: decl(), get, listAll })
    expect(asked).toEqual([`/repos/o/r/commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`, '/repos/o/r/pulls/650', '/repos/o/r/issues/650/comments', '/repos/o/r/git/ref/tags/v2.1.1', `/repos/o/r/git/tags/${T}`])
    expect(evaluateCarryForward({ version: '2.1.2', sha: SHA, declaration: decl(), ...read }).problems).toEqual([])
    // A value in the wrong shape never reaches a URL.
    asked.length = 0
    const odd = await readCarryForwardApi({ repo: 'o/r', sha: 'HEAD', declaration: decl({ adversarial: { pr: '650/../../x' }, base: { tag: '../../x', commit: BASE } }), get, listAll })
    expect(asked).toEqual([])
    expect(evaluateCarryForward({ version: '2.1.2', sha: 'HEAD', declaration: decl({ adversarial: { pr: '650/../../x' } }), ...odd }).ok).toBe(false)
    // Check runs are paged by total_count; a reply that is not a list cannot be read.
    const pages: Record<string, unknown> = { 1: { total_count: 3, check_runs: [GREEN[0], GREEN[1]] }, 2: { total_count: 3, check_runs: [GREEN[2]] } }
    const paged = async (p: string) => pages[new URL(`https://x${p}`).searchParams.get('page') ?? '']
    expect(await listCheckRuns(paged, '/c?filter=latest', { perPage: 2 })).toEqual(GREEN)
    for (const reply of [[], {}, { check_runs: [] }, { total_count: 1 }, null]) {
      await expect(listCheckRuns(async () => reply, '/c'), JSON.stringify(reply)).rejects.toThrow(/no check-run list/)
    }
    await expect(listCheckRuns(async () => ({ total_count: 999, check_runs: [GREEN[0], GREEN[1]] }), '/c', { perPage: 2, maxPages: 2 })).rejects.toThrow(/more than 4 check runs/)
    // One GET: the token sent, a non-2xx thrown.
    const sent: Array<{ url: string; auth?: string }> = []
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => { sent.push({ url, auth: init.headers.Authorization }); return { ok: true, status: 200, json: async () => ({ a: 1 }) } }
    expect(await githubGet('/repos/o/r/pulls/650', { token: 't0k', fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ a: 1 })
    expect(sent).toEqual([{ url: 'https://api.github.com/repos/o/r/pulls/650', auth: 'Bearer t0k' }])
    await expect(githubGet('/repos/o/r/pulls/650', { fetchImpl: (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch })).rejects.toThrow(/GitHub API 404 for \/repos\/o\/r\/pulls\/650/)
  })

  it('check 5 refuses the cut with a FAIL line per unmet requirement, and main reads the declaration from tests/wp1', async () => {
    const run = await gate({ carryForward: decl(), readCarryForward: async () => data({ checkRuns: [GREEN[0], GREEN[2]], pull: { ...PULL, merged: false } }) })
    expect(run.exitCode).toBe(EXIT_REFUSED)
    const text = run.lines.join('\n')
    expect(text).toMatch(/OK\s+milestone/)
    expect(text).toMatch(/FAIL\s+carry-forward: tests\/wp1\/carry-forward\.json does not hold on GitHub \(ADR-027\)/)
    expect(text).toContain(`- no "Test (macos-...)" run from GitHub Actions on ${SHA}`)
    expect(text).toContain(`- PR #650 is not merged as ${SHA}`)
    expect(run.lines.at(-1)).toMatch(/^REFUSED/)
    expect(resolve(DEFAULT_CARRY_FORWARD_PATH)).toBe(resolve(__dirname, '../../../tests/wp1/carry-forward.json'))
    const dir = mkdtempSync(join(tmpdir(), 'gate-carry-'))
    try {
      expect(readCarryForwardFile(join(dir, 'carry-forward.json'))).toBeNull()
      writeFileSync(join(dir, 'carry-forward.json'), JSON.stringify(decl()))
      expect(readCarryForwardFile(join(dir, 'carry-forward.json'))).toEqual(decl())
      writeFileSync(join(dir, 'carry-forward.json'), '{ "targetVersion": ')
      expect(() => readCarryForwardFile(join(dir, 'carry-forward.json'))).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('check 5 matches the Test legs ci.yml runs and the marker adv-marker.sh prints, and the gate job may read them', () => {
    const ci = readFileSync(resolve(__dirname, '../../../.github/workflows/ci.yml'), 'utf-8').replace(/\r\n/g, '\n').split('\n')
    const named = ci.findIndex((l) => l.trim() === 'name: Test (${{ matrix.os }})')
    expect(named, 'ci.yml has no Test (matrix.os) job').toBeGreaterThan(0)
    const oses = /^\s*os:\s*\[(.+)\]\s*$/.exec(ci.slice(named).find((l) => /^\s*os:\s*\[/.test(l)) ?? '')?.[1].split(',').map((s) => s.trim()) ?? []
    expect(oses.length).toBe(3)
    expect(oses.map((os) => TEST_CHECK_RE.exec(`Test (${os})`)?.[1]).sort()).toEqual([...TEST_OS_FAMILIES].sort())
    const script = readFileSync(resolve(__dirname, '../../../.claude/skills/adversarial-review/adv-marker.sh'), 'utf-8')
    const format = /printf '(ADVERSARIAL-REVIEW v1 [^']+)'/.exec(script)?.[1]
    expect(format).toBe('ADVERSARIAL-REVIEW v1 | %s | pr=#%s | head=%s | content=%s | ')
    const printed = [PULL.number, HEAD, 'c'.repeat(64)].reduce((s: string, v) => s.replace('%s', String(v)), format!.replace('%s', 'PASS'))
    expect(MARKER_RE.exec(printed)?.slice(1)).toEqual(['PASS', '650', HEAD])
    // The gate job's permissions: issues (milestone, PR comments), checks and pull-requests (check 5).
    const yml = readFileSync(resolve(__dirname, '../../../.github/workflows/release.yml'), 'utf-8').replace(/\r\n/g, '\n').split('\n')
    const start = yml.indexOf('  gate:')
    const end = yml.findIndex((l, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l))
    const job = yml.slice(start, end)
    const at = job.indexOf('    permissions:')
    const perms = job.slice(at + 1).filter((l, i, all) => all.slice(0, i + 1).every((x) => /^ {6}\S/.test(x))).map((l) => l.trim())
    expect(perms.sort()).toEqual(['checks: read', 'contents: read', 'issues: read', 'pull-requests: read'])
  })
})

// ── plumbing ───────────────────────────────────────────────────────
describe('release-gate plumbing', () => {
  it('githubListAll paginates until a short page and sends the bearer token', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = []
    const pages: Record<string, unknown[]> = { '1': Array.from({ length: 2 }, (_, i) => ({ n: i })), '2': [{ n: 2 }] }
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.Authorization })
      const page = new URL(url).searchParams.get('page') ?? '1'
      return { ok: true, status: 200, json: async () => pages[page] ?? [] }
    }
    const all = await githubListAll('/repos/o/r/milestones?state=all', { token: 't0k', fetchImpl: fetchImpl as unknown as typeof fetch, perPage: 2 })
    expect(all).toHaveLength(3)
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.github.com/repos/o/r/milestones?state=all&per_page=2&page=1',
      'https://api.github.com/repos/o/r/milestones?state=all&per_page=2&page=2',
    ])
    expect(seen[0].auth).toBe('Bearer t0k')
  })

  it('githubListAll throws on a non-2xx (so the gate reports CANNOT EVALUATE, never pass)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) })
    await expect(githubListAll('/repos/o/r/milestones', { token: null, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/401/)
  })

  it('resolveToken prefers GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`', () => {
    expect(resolveToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }, () => 'c')).toBe('a')
    expect(resolveToken({ GH_TOKEN: 'b' }, () => 'c')).toBe('b')
    expect(resolveToken({}, () => 'c\n')).toBe('c')
    expect(resolveToken({}, () => { throw new Error('no gh') })).toBeNull()
  })

  it('repoFromUrl handles https, ssh and git+https forms', () => {
    expect(repoFromUrl('https://github.com/nubbymong/claude-command-center.git')).toBe('nubbymong/claude-command-center')
    expect(repoFromUrl('git@github.com:nubbymong/claude-command-center.git\n')).toBe('nubbymong/claude-command-center')
    expect(repoFromUrl('git+https://github.com/o/r')).toBe('o/r')
    expect(repoFromUrl('')).toBeNull()
    expect(repoFromPackageJson({ repository: { type: 'git', url: 'https://github.com/o/r.git' } })).toBe('o/r')
    expect(repoFromPackageJson({})).toBeNull()
  })
})

// ── the real fixture and the real registry ─────────────────────────
describe('release-gate shipped fixture', () => {
  const expected = JSON.parse(readFileSync(DEFAULT_EXPECTED_PATH, 'utf-8'))
  const registry = JSON.parse(readFileSync(DEFAULT_REGISTRY_PATH, 'utf-8'))

  it('the fixture is well-formed: source, fetch date, and unique claude-* ids', () => {
    expect(expected.source).toMatch(/^https:\/\/support\.claude\.com\//)
    expect(expected.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const ids = expected.models.map((m: { id: string }) => m.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^claude-[a-z0-9-]+$/)
  })

  it('evaluates the shipped registry without throwing (the verdict itself is the gate\'s business, not this test\'s)', () => {
    // Deliberately NOT asserting ok here: the registry is edited under #385 and
    // the article changes under Anthropic's hand. The release gate is where the
    // verdict bites; this test only proves the real inputs are readable.
    const r = evaluateModels({ registry, expected })
    expect(Array.isArray(r.missing)).toBe(true)
    expect(r.covered.length + r.missing.length).toBe(expected.models.length)
  })

  it('resolves DEFAULT paths to files that exist in the repo', () => {
    expect(resolve(DEFAULT_REGISTRY_PATH)).toMatch(/resources[\\/]model-registry\.json$/)
    // Under resources/ (not scripts/fixtures/) so the packaged app's Sentinel
    // check reads the same snapshot the gate does (#385).
    expect(resolve(DEFAULT_EXPECTED_PATH)).toMatch(/resources[\\/]claude-code-model-configuration\.json$/)
  })
})
