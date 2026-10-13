import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  modelCoverageFindings,
  modelCheckFailedFinding,
  fixtureAgeDays,
  FIXTURE_STALE_DAYS,
  EXPECTED_MODEL_SET,
  registryCoveredModelFindingIds,
  staleModelFindingIds,
} from '../../src/main/sentinel/sentinel-models'
import { parseArticleModelIds, MIN_PLAUSIBLE_IDS } from '../../src/main/sentinel/sentinel-model-article'
import type { ModelRegistry, ExpectedModelSet } from '../../src/shared/model-registry'
import type { FindingStatus } from '../../src/shared/sentinel-types'
import baselineJson from '../../resources/model-registry.json'

const reg = baselineJson as unknown as ModelRegistry
const NOW = Date.parse('2026-08-22T00:00:00Z')

function registryOf(ids: string[]): ModelRegistry {
  return {
    ...reg,
    models: ids.map((id) => ({ id, patterns: [id], family: 'opus', label: id })),
  }
}
const expectedOf = (ids: string[]): ExpectedModelSet => ({
  source: 'https://support.claude.com/en/articles/11940350-claude-code-model-configuration',
  fetchedAt: '2026-08-22',
  models: ids.map((id) => ({ id, label: id })),
})

describe('Sentinel model-coverage check (#385)', () => {
  it('is silent when the shipped registry covers the shipped article snapshot', () => {
    expect(modelCoverageFindings(reg, EXPECTED_MODEL_SET, NOW)).toEqual([])
  })

  it('flags a model Anthropic offers that we do not', () => {
    const f = modelCoverageFindings(registryOf(['claude-opus-5']), expectedOf(['claude-opus-5', 'claude-opus-6']), NOW)
    expect(f).toHaveLength(1)
    expect(f[0].id).toBe('models:missing:claude-opus-6')
    expect(f[0].kind).toBe('compat')
    expect(f[0].severity).toBe('warn')
    expect(f[0].title).toContain('not in the model picker')
  })

  it('flags a model we still offer that the article dropped (retired/renamed)', () => {
    const f = modelCoverageFindings(registryOf(['claude-opus-5', 'claude-opus-3']), expectedOf(['claude-opus-5']), NOW)
    expect(f).toHaveLength(1)
    expect(f[0].id).toBe('models:retired:claude-opus-3')
    expect(f[0].title).toContain('no longer lists it')
  })

  it('honours articleExempt so a deliberately-carried model is not nagged about', () => {
    const withExempt: ModelRegistry = {
      ...reg,
      models: [
        { id: 'claude-opus-5', patterns: ['opus'], family: 'opus', label: 'Opus 5' },
        { id: 'claude-opus-5-fast', patterns: ['fast'], family: 'opus', label: 'Fast', articleExempt: true },
      ],
    }
    expect(modelCoverageFindings(withExempt, expectedOf(['claude-opus-5']), NOW)).toEqual([])
  })

  it('ignores non-Claude catch-all entries', () => {
    const withCodex: ModelRegistry = {
      ...reg,
      models: [
        { id: 'claude-opus-5', patterns: ['opus'], family: 'opus', label: 'Opus 5' },
        { id: 'codex-family', patterns: ['codex'], family: 'codex', label: 'Codex' },
      ],
    }
    expect(modelCoverageFindings(withCodex, expectedOf(['claude-opus-5']), NOW)).toEqual([])
  })

  it('a dated article id is covered by our undated entry', () => {
    expect(modelCoverageFindings(
      registryOf(['claude-opus-4-5']),
      expectedOf(['claude-opus-4-5-20251101']),
      NOW,
    )).toEqual([])
  })

  it('fails closed on a torn or empty snapshot instead of passing vacuously', () => {
    const f = modelCoverageFindings(reg, { models: [] }, NOW)
    expect(f).toHaveLength(1)
    expect(f[0].id).toBe('models:fixture-unreadable')
    expect(f[0].evidence).toContain('fail closed')
  })

  it('reports a stale snapshot as info, not as an alarm', () => {
    const old = { ...expectedOf(['claude-opus-5']), fetchedAt: '2026-01-01' }
    const f = modelCoverageFindings(registryOf(['claude-opus-5']), old, NOW)
    expect(f).toHaveLength(1)
    expect(f[0].id).toContain('models:fixture-stale')
    expect(f[0].severity).toBe('info')
    expect(f[0].kind).toBe('info')
  })

  // ── S1: the live arm, which is the only way "Anthropic added a model" can
  //    ever fire on a released build (registry + snapshot ship together and the
  //    release gate guarantees they agree at cut time).
  it('LIVE mode reports a model the article lists that the shipped snapshot does not', () => {
    const f = modelCoverageFindings(
      registryOf(['claude-opus-5']),
      expectedOf(['claude-opus-5']),                 // snapshot agrees with the registry
      NOW,
      ['claude-opus-5', 'claude-opus-6'],            // the article has moved on
    )
    expect(f).toHaveLength(1)
    expect(f[0].id).toBe('models:missing:claude-opus-6')
    expect(f[0].evidence).toContain('read online from')  // says the claim is first-hand
    // ...and says what was read and from where, never when: a kept notice
    // must not say "just now" days later (owner findings 2026-10-11).
    expect(f[0].evidence).not.toContain('just now')
  })

  it('a snapshot-mode finding never claims to be current', () => {
    const f = modelCoverageFindings(registryOf([]), expectedOf(['claude-opus-5']), NOW, null)
    expect(f[0].id).toBe('models:missing:claude-opus-5')
    expect(f[0].evidence).toContain('shipped with this build')
    expect(f[0].evidence).not.toContain('just now')
    expect(f[0].evidence).not.toContain('read online')
  })

  it('a successful live read suppresses the staleness note — it just answered first-hand', () => {
    const old = { ...expectedOf(['claude-opus-5']), fetchedAt: '2026-01-01' }
    const f = modelCoverageFindings(registryOf(['claude-opus-5']), old, NOW, ['claude-opus-5'])
    expect(f).toEqual([])
  })

  it('the RETIRED arm stays on the human-verified snapshot, never on the live parse', () => {
    // A thin HTML parse that silently stops matching must not accuse every
    // model we ship of having been retired.
    const f = modelCoverageFindings(
      registryOf(['claude-opus-5', 'claude-opus-4-8']),
      expectedOf(['claude-opus-5', 'claude-opus-4-8']),
      NOW,
      ['claude-opus-5'],                             // live parse came back short
    )
    expect(f.filter((x) => x.id.startsWith('models:retired:'))).toEqual([])
  })

  // ── Q4: an overlay-added model must not be called "possibly retired".
  it('does not report a Sentinel- or user-added overlay model as retired', () => {
    const withOverlay: ModelRegistry = {
      ...reg,
      models: [
        { id: 'claude-opus-5', patterns: ['opus'], family: 'opus', label: 'Opus 5' },
        {
          id: 'claude-opus-9', patterns: ['opus-9'], family: 'opus', label: 'Opus 9',
          provenance: { addedBy: 'sentinel', date: '2026-09-01' },
        } as ModelRegistry['models'][number],
      ],
    }
    const f = modelCoverageFindings(withOverlay, expectedOf(['claude-opus-5']), NOW)
    expect(f).toEqual([])
  })

  it('surfaces a finding when the check itself fails, rather than vanishing into a log', () => {
    const f = modelCheckFailedFinding('boom', NOW)
    expect(f.id).toBe('models:check-failed')
    expect(f.severity).toBe('warn')
    expect(f.evidence).toContain('boom')
  })

  it('does not report a freshly-fetched snapshot as stale', () => {
    expect(modelCoverageFindings(registryOf(['claude-opus-5']), expectedOf(['claude-opus-5']), NOW)).toEqual([])
  })

  it('finding ids are stable across runs so a dismissal sticks', () => {
    const args = [registryOf(['claude-opus-5']), expectedOf(['claude-opus-5', 'claude-opus-6']), NOW] as const
    expect(modelCoverageFindings(...args).map((f) => f.id))
      .toEqual(modelCoverageFindings(...args).map((f) => f.id))
  })

  it('needs no network and no claude binary — pure over its inputs', () => {
    // Guard the design property: the check is a pure function, so it still runs
    // offline and when `claude --version` is unavailable.
    expect(typeof modelCoverageFindings).toBe('function')
    expect(modelCoverageFindings.length).toBeLessThanOrEqual(3)
  })
})

describe('parseArticleModelIds (#385 S1)', () => {
  it('pulls the model ids out of article markup, in order, deduped', () => {
    const html = `
      <h2>Supported models</h2>
      <p>claude-opus-5</p><p>claude-sonnet-5</p><p>claude-opus-4-5-20251101</p>
      <p>claude-opus-5</p>
    `
    expect(parseArticleModelIds(html)).toEqual([
      'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-5-20251101',
    ])
  })

  it('does not mistake "claude-code" for a model — a digit must follow the family', () => {
    const html = 'Claude Code (claude-code) docs. Use claude-code-router. Try claude-opus-5.'
    expect(parseArticleModelIds(html)).toEqual(['claude-opus-5'])
  })

  it('is case-insensitive', () => {
    expect(parseArticleModelIds('CLAUDE-OPUS-5 and claude-haiku-4-5')).toEqual([
      'claude-opus-5', 'claude-haiku-4-5',
    ])
  })

  it('rejects a token that CONTINUES past the id instead of trimming it back', () => {
    // Was: a trailing hyphen was trimmed off, which is how `claude-fable-5` got
    // carved out of the slug `claude-fable-5-on-your-plan`. A hyphen (or any
    // further word) after the version means this is not a model id, so the whole
    // token is dropped (ADR-009 MAJOR-1 on #404).
    expect(parseArticleModelIds('claude-opus-5- and claude-fable-5-on-your-plan')).toEqual([])
    expect(parseArticleModelIds('claude-opus-5-preview claude-haiku-4-5x')).toEqual([])
  })

  it('finds nothing in a page with no model ids, so the caller falls back', () => {
    expect(parseArticleModelIds('<html><body>Sorry, page moved.</body></html>').length)
      .toBeLessThan(MIN_PLAUSIBLE_IDS)
  })

  it('reads the shipped snapshot ids out of article-shaped markup', () => {
    // Round-trip: the ids we ship must be exactly what this parser would find.
    const html = EXPECTED_MODEL_SET.models.map((m) => `<td>${m.label}</td><td>${m.id}</td>`).join('\n')
    expect(parseArticleModelIds(html)).toEqual(EXPECTED_MODEL_SET.models.map((m) => m.id))
  })

  it('never reads a model id out of a tag — only out of visible text', () => {
    const html = `
      <h2>Supported models</h2>
      <a title="Claude Fable 9 on your plan"
         href="https://support.claude.com/en/articles/15424964-claude-fable-9">Read more</a>
      <div data-model="claude-opus-9" class="claude-sonnet-9">
        <p>claude-opus-5</p><p>claude-sonnet-5</p><p>claude-haiku-4-5</p>
      </div>
    `
    // Note claude-fable-9 is a WHOLE-token id at the end of that href: the
    // shape rule alone would take it, and only "text, not markup" keeps it out.
    expect(parseArticleModelIds(html)).toEqual([
      'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
    ])
  })

  it('ignores a model named outside the Supported models section', () => {
    const html = `
      <h2>Supported models</h2>
      <p>claude-opus-5</p><p>claude-sonnet-5</p><p>claude-haiku-4-5</p>
      <h2>Retired models</h2>
      <p>claude-opus-3 is no longer available.</p>
    `
    expect(parseArticleModelIds(html)).toEqual([
      'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
    ])
  })

  it('falls back to the whole page when the Supported models heading is gone', () => {
    const html = `
      <h2>Which models can I use?</h2>
      <p>claude-opus-5</p><p>claude-sonnet-5</p><p>claude-haiku-4-5</p>
    `
    expect(parseArticleModelIds(html)).toEqual([
      'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
    ])
  })

  it('heals an id that inline markup split in two', () => {
    const html = '<h2>Supported models</h2><code>claude --model<b> </b>claude-haiku-4-5-20251001</code>'
    expect(parseArticleModelIds(html)).toEqual(['claude-haiku-4-5-20251001'])
  })
})

// The defect this fixture exists for: the parser used to regex the WHOLE ~345 KB
// page, so it harvested `claude-fable-5-on-your-plan` from a sidebar link's
// href. registryIdCovers() cannot match that against `claude-fable-5`, so the
// LIVE arm raised a permanent, stable-id'd `models:missing:...` finding on every
// startup of every Sentinel-enabled build. See the fixture header for what the
// three slices are; the markup inside each is the real page, unmodified.
describe('parseArticleModelIds against the REAL article (ADR-009 MAJOR-1, #404)', () => {
  const REAL_ARTICLE_HTML = readFileSync(
    join(__dirname, '..', 'fixtures', 'model-article', 'claude-code-model-configuration.trimmed.html'),
    'utf8',
  )
  const PHANTOM = 'claude-fable-5-on-your-plan'

  it('still contains the sidebar link that produced the phantom', () => {
    // Guards the fixture itself: if a future trim drops this href, the two tests
    // below would pass for the wrong reason.
    expect(REAL_ARTICLE_HTML).toContain(`15424964-${PHANTOM}`)
  })

  it('does NOT return the phantom id scraped from that link', () => {
    const ids = parseArticleModelIds(REAL_ARTICLE_HTML)
    expect(ids).not.toContain(PHANTOM)
    expect(ids.some((id) => id.includes('on-your-plan'))).toBe(false)
  })

  it('DOES return every genuine id, in article order', () => {
    expect(parseArticleModelIds(REAL_ARTICLE_HTML))
      .toEqual(EXPECTED_MODEL_SET.models.map((m) => m.id))
  })

  it('is well clear of the "unreadable" floor, so the live arm still runs', () => {
    expect(parseArticleModelIds(REAL_ARTICLE_HTML).length)
      .toBeGreaterThanOrEqual(MIN_PLAUSIBLE_IDS)
  })

  it('raises NO finding when the live article is parsed against the shipped registry', () => {
    // The user-visible symptom, end to end: with the old parser this produced
    // `models:missing:claude-fable-5-on-your-plan` ("New model: ...") on every
    // single startup, permanently, because the id is stable and never resolves.
    const liveIds = parseArticleModelIds(REAL_ARTICLE_HTML)
    expect(modelCoverageFindings(reg, EXPECTED_MODEL_SET, NOW, liveIds)).toEqual([])
  })
})

describe('fixtureAgeDays', () => {
  it('measures whole days and tolerates a missing or unparseable date', () => {
    expect(fixtureAgeDays('2026-08-12', NOW)).toBe(10)
    expect(fixtureAgeDays(undefined, NOW)).toBeNull()
    expect(fixtureAgeDays('not-a-date', NOW)).toBeNull()
  })
  it('the shipped snapshot is not already stale', () => {
    const age = fixtureAgeDays(EXPECTED_MODEL_SET.fetchedAt, Date.now())
    if (age !== null) expect(age).toBeLessThanOrEqual(FIXTURE_STALE_DAYS)
  })
})

// O8: model findings are kept by id, so nothing closed one whose cause went
// away. v2.1.0 and 2.1.1-beta.1 raised "not in the model picker" for Opus,
// Sonnet and Haiku 5.5 from the live article (their registry lacked all three);
// beta.2 added them, and the notices stayed open at every launch. These pin
// which open findings the check no longer stands behind.
describe('closing model findings the check no longer stands behind (O8)', () => {
  const REAL_LIVE = parseArticleModelIds(readFileSync(
    join(__dirname, '..', 'fixtures', 'model-article', 'claude-code-model-configuration.trimmed.html'),
    'utf8',
  ))
  const FIVE_FIVE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
  const NOTICES = FIVE_FIVE.map((id) => `models:missing:${id}`).sort()
  // The registry of v2.1.0 and 2.1.1-beta.1: none of the three 5.5 models.
  const beta1: ModelRegistry = { ...reg, models: reg.models.filter((m) => !FIVE_FIVE.includes(m.id)) }
  const raisedByBeta1 = modelCoverageFindings(beta1, EXPECTED_MODEL_SET, NOW, REAL_LIVE)
  const open = (id: string, status: FindingStatus = 'open') => ({ id, status })

  it('an install without the 5.5 models raised the three notices the owner saw, from the live article', () => {
    expect(raisedByBeta1.map((f) => f.id).sort()).toEqual(NOTICES)
  })

  it("the owner's case: all three close against the shipped registry, before the article is read and after a check, live or offline", () => {
    expect(registryCoveredModelFindingIds(raisedByBeta1, reg).sort()).toEqual(NOTICES)
    for (const live of [REAL_LIVE, null]) {
      const current = modelCoverageFindings(reg, EXPECTED_MODEL_SET, NOW, live)
      expect(current).toEqual([])
      expect(staleModelFindingIds(raisedByBeta1, reg, current, EXPECTED_MODEL_SET, live).sort(), String(live)).toEqual(NOTICES)
    }
  })

  it('against a registry without them, none of the three closes (the notices are true there)', () => {
    expect(registryCoveredModelFindingIds(raisedByBeta1, beta1)).toEqual([])
    expect(staleModelFindingIds(raisedByBeta1, beta1, raisedByBeta1, EXPECTED_MODEL_SET, REAL_LIVE)).toEqual([])
    const offline = modelCoverageFindings(beta1, EXPECTED_MODEL_SET, NOW, null)
    expect(staleModelFindingIds(raisedByBeta1, beta1, offline, EXPECTED_MODEL_SET, null)).toEqual([])
  })

  it('a model the registry does not cover stays open, offline or while the article lists it; a muted one is never named', () => {
    const findings = [open('models:missing:claude-opus-6'), open('models:missing:claude-opus-5-5', 'muted'), open('models:missing:claude-sonnet-5-5', 'dismissed')]
    expect(registryCoveredModelFindingIds(findings, reg)).toEqual([])
    expect(staleModelFindingIds(findings, reg, [], EXPECTED_MODEL_SET, null)).toEqual([])
    const live = [...REAL_LIVE, 'claude-opus-6']
    const current = modelCoverageFindings(reg, EXPECTED_MODEL_SET, NOW, live)
    expect(current.map((f) => f.id)).toEqual(['models:missing:claude-opus-6'])
    expect(staleModelFindingIds(findings, reg, current, EXPECTED_MODEL_SET, live)).toEqual([])
  })

  it('live mode only: a notice for a model the article has since dropped closes, though the app never added it', () => {
    const findings = [open('models:missing:claude-opus-6')]
    expect(staleModelFindingIds(findings, reg, [], EXPECTED_MODEL_SET, REAL_LIVE)).toEqual(['models:missing:claude-opus-6'])
    // Never offline (a still-true notice would flap with the network), never
    // from a read too thin to count as read.
    expect(staleModelFindingIds(findings, reg, [], EXPECTED_MODEL_SET, null)).toEqual([])
    expect(staleModelFindingIds(findings, reg, [], EXPECTED_MODEL_SET, REAL_LIVE.slice(0, MIN_PLAUSIBLE_IDS - 1))).toEqual([])
    // A model the article still lists is never closed by the live read, even
    // when the caller passes no findings for the run.
    expect(staleModelFindingIds(findings, reg, [], EXPECTED_MODEL_SET, [...REAL_LIVE, 'claude-opus-6'])).toEqual([])
  })

  it('live mode: a model the shipped snapshot still lists is not closed by the live read alone', () => {
    const findings = [open('models:missing:claude-opus-6')]
    const live = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5']
    const one = registryOf(['claude-opus-5'])
    expect(staleModelFindingIds(findings, one, [], expectedOf(['claude-opus-5', 'claude-opus-6']), live)).toEqual([])
    expect(staleModelFindingIds(findings, one, [], expectedOf(['claude-opus-5']), live)).toEqual(['models:missing:claude-opus-6'])
  })

  it('retired: closes when a check that compared no longer raises it; never after a run that found the snapshot unreadable', () => {
    const findings = [open('models:retired:claude-opus-3')]
    expect(staleModelFindingIds(findings, reg, [], EXPECTED_MODEL_SET, null)).toEqual(['models:retired:claude-opus-3'])
    const empty: ExpectedModelSet = { models: [] }
    const unreadable = modelCoverageFindings(reg, empty, NOW, REAL_LIVE)
    expect(unreadable.map((f) => f.id)).toEqual(['models:fixture-unreadable'])
    expect(staleModelFindingIds(findings, reg, unreadable, empty, REAL_LIVE)).toEqual([])
    // Raised again by this run: stays.
    const withOld = registryOf(['claude-opus-5', 'claude-opus-3'])
    const current = modelCoverageFindings(withOld, expectedOf(['claude-opus-5']), NOW)
    expect(current.map((f) => f.id)).toEqual(['models:retired:claude-opus-3'])
    expect(staleModelFindingIds(findings, withOld, current, expectedOf(['claude-opus-5']), null)).toEqual([])
  })

  it('a run that found the snapshot unreadable closes no notice by its live read either', () => {
    const empty: ExpectedModelSet = { models: [] }
    const unreadable = modelCoverageFindings(reg, empty, NOW, REAL_LIVE)
    expect(staleModelFindingIds([open('models:missing:claude-opus-6')], reg, unreadable, empty, REAL_LIVE)).toEqual([])
  })

  it('fixture-unreadable and check-failed close once a check completes without them', () => {
    const findings = [open('models:fixture-unreadable'), open('models:check-failed')]
    expect(staleModelFindingIds(findings, reg, [], EXPECTED_MODEL_SET, null).sort()).toEqual(['models:check-failed', 'models:fixture-unreadable'])
    const empty: ExpectedModelSet = { models: [] }
    expect(staleModelFindingIds(findings, reg, modelCoverageFindings(reg, empty, NOW), empty, null)).toEqual(['models:check-failed'])
  })

  it('fixture-stale closes once the shipped snapshot has another date, and not before', () => {
    const old = open('models:fixture-stale:2026-05-01')
    const same = open(`models:fixture-stale:${EXPECTED_MODEL_SET.fetchedAt}`)
    expect(staleModelFindingIds([old, same], reg, [], EXPECTED_MODEL_SET, null)).toEqual([old.id])
  })

  it('names Claude model findings only: Codex model findings and other findings are not its business', () => {
    const findings = [open('models:codex-missing:gpt-5.5'), open('models:codex-check-failed'), open('models:codex-list-unreadable'), open('codex-version:too-new:0.157.1'), open('cc:2.1.300:1')]
    expect(registryCoveredModelFindingIds(findings, reg)).toEqual([])
    expect(staleModelFindingIds(findings, reg, [], EXPECTED_MODEL_SET, REAL_LIVE)).toEqual([])
  })
})
