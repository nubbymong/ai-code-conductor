// The deterministic first-run / what's-new rule.
//
// The rule it replaces was `lastSeen !== changelog[0].version`, which could not
// distinguish a fresh install from an upgrade and only ever showed the single
// newest entry — so someone going 2.0.0 → 2.1.0 saw one release's notes and not
// the fourteen in between.

import { describe, it, expect } from 'vitest'
import * as UF from '../../../src/renderer/onboarding/upgrade-flow'
import * as VO from '../../../src/shared/version-order'
import * as WN from '../../../src/renderer/onboarding/WhatsNewV2Step'

const { decideUpgradeFlow, entriesSince, bootWhatsNewSurface, seenVersionFor, lastRunVersionOf } = UF
const { compareVersions, crossedReleaseLine, releaseLine } = VO
// Read off the module object, so a run against a build without them fails on
// the assertion rather than on the import.
const { sectionsFor } = WN as any
const { whatsNewAnchorFor, lastFinalBefore, newSince } = UF as any
const { finalRelease } = VO as any
const ALL_SECTIONS: any[] = (WN as any).WHATS_NEW_SECTIONS ?? []

describe('compareVersions', () => {
  it('orders the release tuple', () => {
    expect(compareVersions('2.1.0', '2.0.0')).toBeGreaterThan(0)
    expect(compareVersions('2.0.9', '2.1.0')).toBeLessThan(0)
    expect(compareVersions('1.5.45', '1.5.44')).toBeGreaterThan(0)
    expect(compareVersions('2.1.0', '2.1.0')).toBe(0)
  })

  it('orders prereleases numerically, not as text', () => {
    // The bug a naive string compare produces: '2' > '14'.
    expect(compareVersions('2.1.0-beta.14', '2.1.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('2.1.0-beta.9', '2.1.0-beta.10')).toBeLessThan(0)
  })

  it('ranks rc above beta, and a final release above both', () => {
    // docs/versioning.md: both ride the beta channel, rc outranks beta, final
    // outranks rc.
    expect(compareVersions('2.1.0-rc.1', '2.1.0-beta.14')).toBeGreaterThan(0)
    expect(compareVersions('2.1.0', '2.1.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('2.1.0', '2.1.0-beta.1')).toBeGreaterThan(0)
  })

  it('tolerates a v prefix and surrounding whitespace', () => {
    expect(compareVersions('v2.1.0', '2.1.0')).toBe(0)
    expect(compareVersions(' 2.1.0 ', '2.1.0')).toBe(0)
  })

  it('treats an unparseable version as the oldest thing there is', () => {
    // Fail toward showing too much rather than silently showing nothing.
    expect(compareVersions('garbage', '2.1.0')).toBeLessThan(0)
    expect(compareVersions('2.1.0', '')).toBeGreaterThan(0)
    expect(compareVersions('garbage', 'nonsense')).toBe(0)
  })
})

describe('releaseLine / crossedReleaseLine', () => {
  it('reads the major.minor line', () => {
    expect(releaseLine('2.1.0-beta.14')).toBe('2.1')
    expect(releaseLine('2.0.0')).toBe('2.0')
  })

  it('crosses on a minor bump but not within one', () => {
    expect(crossedReleaseLine('2.0.5', '2.1.0')).toBe(true)
    expect(crossedReleaseLine('2.1.0-beta.13', '2.1.0-beta.14')).toBe(false)
    expect(crossedReleaseLine('2.1.0-rc.1', '2.1.0')).toBe(false)
    expect(crossedReleaseLine('1.5.45', '2.0.0')).toBe(true)
  })

  it('counts an unreadable origin as a crossing', () => {
    expect(crossedReleaseLine('', '2.1.0')).toBe(true)
  })
})

describe('decideUpgradeFlow', () => {
  it('a fresh install gets the tour and NO what is new', () => {
    const d = decideUpgradeFlow({ currentVersion: '2.1.0' })
    expect(d).toMatchObject({ kind: 'first-install', showTour: true, showWhatsNew: false })
    expect(d.reason).toBe('no-stored-version')
  })

  it('an unchanged version shows nothing at all', () => {
    const d = decideUpgradeFlow({ lastSeenVersion: '2.1.0', currentVersion: '2.1.0' })
    expect(d).toMatchObject({ kind: 'nothing', showTour: false, showWhatsNew: false })
  })

  it('does not re-fire on a formatting difference alone', () => {
    // A stored 'v2.1.0' is the same release as '2.1.0'; a string compare would
    // show the modal on every single launch.
    expect(decideUpgradeFlow({ lastSeenVersion: 'v2.1.0', currentVersion: '2.1.0' }).kind).toBe('nothing')
  })

  it('crossing a release line shows what is new AND re-runs the tour', () => {
    // The owner's ask in one case: 2.0 users must walk the tour again on 2.1.
    const d = decideUpgradeFlow({ lastSeenVersion: '2.0.0', currentVersion: '2.1.0' })
    expect(d).toMatchObject({ kind: 'upgrade', showTour: true, showWhatsNew: true })
    expect(d.reason).toBe('crossed-line')
  })

  it('moving within a line shows what is new only', () => {
    const d = decideUpgradeFlow({ lastSeenVersion: '2.1.0', currentVersion: '2.1.1' })
    expect(d).toMatchObject({ kind: 'upgrade', showTour: false, showWhatsNew: true })
    expect(d.reason).toBe('within-line')
  })

  it('beta testers re-walk the tour on every version', () => {
    const d = decideUpgradeFlow({
      lastSeenVersion: '2.1.0-beta.13',
      currentVersion: '2.1.0-beta.14',
      channel: 'beta',
    })
    expect(d).toMatchObject({ showTour: true, showWhatsNew: true })
    expect(d.reason).toBe('beta-channel')
  })

  it('a stable user moving between patches does NOT get the tour', () => {
    const d = decideUpgradeFlow({
      lastSeenVersion: '2.1.0-beta.13',
      currentVersion: '2.1.0-beta.14',
      channel: 'stable',
    })
    expect(d.showTour).toBe(false)
  })

  it('still shows notes after a downgrade', () => {
    // A tester dropping back a build changed what they are running; showing the
    // notes for it beats showing nothing.
    const d = decideUpgradeFlow({ lastSeenVersion: '2.1.0', currentVersion: '2.0.0' })
    expect(d.showWhatsNew).toBe(true)
  })
})

describe('entriesSince', () => {
  // Deliberately in the real changelog's DATE order, which is not semver order:
  // 2.0.0 shipped before its own -beta.5 and -rc.2 entries and therefore sits
  // BELOW them in the array while ranking ABOVE them by version.
  const log = [
    { version: '2.1.0-beta.14' },
    { version: '2.1.0-beta.13' },
    { version: '2.1.0-beta.1' },
    { version: '2.0.0-rc.2' },
    { version: '2.0.0-beta.5' },
    { version: '2.0.0' },
    { version: '1.5.45' },
  ]

  it('returns everything newer than what was last seen', () => {
    expect(entriesSince(log, '2.1.0-beta.13', '2.1.0-beta.14').map((e) => e.version)).toEqual([
      '2.1.0-beta.14',
    ])
  })

  it('spans many releases, not just the newest one', () => {
    const got = entriesSince(log, '2.0.0', '2.1.0-beta.14').map((e) => e.version)
    expect(got).toEqual(['2.1.0-beta.14', '2.1.0-beta.13', '2.1.0-beta.1'])
  })

  it('never hands a 2.0.0 user the notes for 2.0.0 own prereleases', () => {
    // The whole reason this filters instead of slicing by index. Those two
    // entries sit ABOVE 2.0.0 in the array but BELOW it by version.
    const got = entriesSince(log, '2.0.0', '2.1.0-beta.14').map((e) => e.version)
    expect(got).not.toContain('2.0.0-rc.2')
    expect(got).not.toContain('2.0.0-beta.5')
  })

  it('is sorted newest first even though the source array is not', () => {
    const got = entriesSince(log, '1.5.45', '2.1.0-beta.14').map((e) => e.version)
    expect(got).toEqual([
      '2.1.0-beta.14',
      '2.1.0-beta.13',
      '2.1.0-beta.1',
      '2.0.0',
      '2.0.0-rc.2',
      '2.0.0-beta.5',
    ])
  })

  it('excludes anything newer than the running build', () => {
    // A downgraded tester must not be shown notes for a build they no longer
    // have installed.
    const got = entriesSince(log, '2.0.0', '2.1.0-beta.13').map((e) => e.version)
    expect(got).not.toContain('2.1.0-beta.14')
  })

  it('returns nothing for a first install', () => {
    expect(entriesSince(log, undefined, '2.1.0-beta.14')).toEqual([])
  })
})

describe('sectionsFor — which highlights the upgrade page shows, by anchor', () => {
  // Was keyed on the release LINE (O1): every 2.0 or 2.1 arrival got the whole
  // 2.1 set, and a 2.1.x build named only "2.1". Now each line carries the
  // first build that shipped it and shows when it is newer than the anchor
  // (whatsNewAnchorFor). Cohort (fresh / upgrade-only) and provider filters
  // are the page's (summarySections); these are the raw sets.
  const titlesFor = (anchor: string | undefined) =>
    sectionsFor(anchor).flatMap((s: any) => s.items.map((i: any) => i.title))

  it('shows the 2.1 story and the 2.1.1 one to someone coming from 2.0', () => {
    const titles = titlesFor('2.0.4')
    expect(titles).toContain('New name.')
    expect(titles).toContain('Agent Canvas.')
    expect(titles).toContain('Codex, no longer Beta.')
    // They lived through 2.0; re-announcing it is noise.
    expect(titles).not.toContain('Guided setup.')
  })

  it('shows everything to someone arriving from 1.x, oldest first', () => {
    const titles = titlesFor('1.5.45')
    expect(titles).toContain('Guided setup.')
    expect(titles).toContain('New name.')
    // Oldest first: the order the app actually changed in.
    expect(titles.indexOf('Guided setup.')).toBeLessThan(titles.indexOf('New name.'))
    expect(titles.indexOf('New name.')).toBeLessThan(titles.indexOf('Codex, no longer Beta.'))
  })

  it('shows everything when the stored version cannot be read', () => {
    expect(titlesFor(undefined)).toContain('Guided setup.')
    expect(titlesFor('garbage')).toContain('New name.')
  })

  it('O1: a 2.1.0 user gets the 2.1.1 set, and none of the 2.1 set', () => {
    const titles = titlesFor('2.1.0')
    expect(titles).toContain('Codex, no longer Beta.')
    expect(titles).toContain('Codex asks once.')
    for (const old of ['New name.', 'Agent Canvas.', 'SSH Persistent.', 'Insights.']) expect(titles, old).not.toContain(old)
  })

  it('nothing curated since the anchor gives nothing: the page then shows its fixes line, never an older set', () => {
    // The beta.2 rule fell back to the NEWEST set on a line with none of its
    // own, which is the owner's complaint again on the next patch (O1 verdict).
    expect(titlesFor('2.1.1')).toEqual([])
    expect(titlesFor('2.2.0')).toEqual([])
  })

  it('every line stays ONE line — the whole point of the rewrite', () => {
    // The rejected version had 3-4 sentence descriptions per card. A cap that
    // no input can trip is worse than none, so this is deliberately tight
    // enough to fail if someone pastes a paragraph back in. Every set,
    // the 2.1.1 one included.
    expect(ALL_SECTIONS.length).toBeGreaterThan(0)
    for (const s of ALL_SECTIONS) {
      for (const it of s.items) {
        expect(it.desc.length, `${it.title} is too long for one line`).toBeLessThanOrEqual(110)
        expect(it.title.length, `${it.title} is not a short lead-in`).toBeLessThanOrEqual(32)
      }
    }
  })
})

describe('finalRelease / lastFinalBefore', () => {
  it('finalRelease drops the prerelease and keeps a final as itself', () => {
    expect(finalRelease('2.1.1-beta.2')).toBe('2.1.1')
    expect(finalRelease('2.1.0-rc.17')).toBe('2.1.0')
    expect(finalRelease('v2.1.0')).toBe('2.1.0')
    expect(finalRelease('garbage')).toBeNull()
  })

  it('lastFinalBefore is the newest FINAL release below a version, skipping prereleases', () => {
    const log = [{ version: '2.1.1-beta.2' }, { version: '2.1.0' }, { version: '2.1.0-rc.17' }, { version: '2.0.5' }, { version: 'junk' }]
    expect(lastFinalBefore('2.1.1', log)).toBe('2.1.0')
    expect(lastFinalBefore('2.1.0', log)).toBe('2.0.5')
    expect(lastFinalBefore('2.0.5', log)).toBeUndefined()
  })
})

describe("whatsNewAnchorFor: where What's New diffs from (owner rule 2026-10-11)", () => {
  // Content is keyed to the FINAL release: prereleases of a release never
  // count as having seen it; a prerelease of an OLDER release counts as that
  // release; a fresh install has no anchor.
  const releases = [
    { version: '2.1.1-beta.2' }, { version: '2.1.1-beta.1' }, { version: '2.1.0' }, { version: '2.1.0-rc.17' },
    { version: '2.0.5' }, { version: '2.0.0' }, { version: '1.5.45' },
  ]
  const a = (seenVersion: string | undefined, currentVersion: string) => whatsNewAnchorFor({ seenVersion, currentVersion, releases })

  it('a fresh install has none', () => {
    expect(a(undefined, '2.1.1-beta.3')).toBeUndefined()
  })

  it('a stable 2.1.0 user diffs from 2.1.0, on every 2.1.1 build', () => {
    expect(a('2.1.0', '2.1.1-beta.3')).toBe('2.1.0')
    expect(a('2.1.0', '2.1.1')).toBe('2.1.0')
  })

  it('a prerelease never counts as having seen its own release: beta.1 -> beta.2 -> beta.3 -> 2.1.1 all diff from 2.1.0', () => {
    expect(a('2.1.1-beta.1', '2.1.1-beta.2')).toBe('2.1.0')
    expect(a('2.1.1-beta.2', '2.1.1-beta.3')).toBe('2.1.0')
    expect(a('2.1.1-beta.3', '2.1.1')).toBe('2.1.0')
  })

  it('a prerelease of an OLDER release counts as that release (2.1.0-rc.17 = 2.1.0)', () => {
    expect(a('2.1.0-rc.17', '2.1.1-beta.3')).toBe('2.1.0')
    expect(a('2.1.0-rc.17', '2.1.1')).toBe('2.1.0')
  })

  it('older finals stay where they are', () => {
    expect(a('2.0.4', '2.1.1')).toBe('2.0.4')
    expect(a('1.5.45', '2.1.1-beta.3')).toBe('1.5.45')
  })

  it('the next patch diffs from the last final: 2.1.1 -> 2.1.2 (and its prereleases) from 2.1.1', () => {
    // The seen final counts even with no 2.1.1 entry in the list.
    expect(a('2.1.1', '2.1.2-beta.1')).toBe('2.1.1')
    expect(a('2.1.1', '2.1.2')).toBe('2.1.1')
  })

  it("a downgrade onto a prerelease still shows that release's whole story", () => {
    expect(a('2.1.1', '2.1.1-beta.3')).toBe('2.1.0')
  })

  it('a pre-rename 2.1.0 beta tester arriving at the 2.1.0 final diffs from the last 2.0 final', () => {
    expect(a('2.1.0-beta.5', '2.1.0')).toBe('2.0.5')
  })

  it('an unreadable stamp is kept (it ranks oldest, so everything shows)', () => {
    expect(a('garbage', '2.1.1-beta.3')).toBe('garbage')
  })

  it('composes with the #369 clamp: a stamp written ahead of its build diffs from what ran', () => {
    // Values that do not floor to 2.1.0, so the clamp decides them: a run of
    // 2.0.5 under a stamp of the running prerelease, and a final build
    // stamped ahead of the 2.1.0 that ran (no prerelease floor there).
    const seen = seenVersionFor({ lastSeenVersion: '2.1.1-beta.3', lastRunVersion: '2.0.5' })
    expect(a(seen, '2.1.1-beta.3')).toBe('2.0.5')
    const seenFinal = seenVersionFor({ lastSeenVersion: '2.1.1', lastRunVersion: '2.1.0' })
    expect(a(seenFinal, '2.1.1')).toBe('2.1.0')
  })
})

describe('newSince: one rule for every line and page', () => {
  it('newer than the anchor shows; at or below it does not; no anchor shows everything', () => {
    expect(newSince('2.1.1-beta.2', '2.1.0')).toBe(true)
    expect(newSince('2.1.0-rc.1', '2.1.0')).toBe(false)
    expect(newSince('2.1.0', '2.1.0')).toBe(false)
    expect(newSince('2.0.0', undefined)).toBe(true)
  })

  it("has NO upper bound: a line tagged with its final shows on that release's prereleases", () => {
    // O2 verdict: with a "since <= current" bound, a tag of 2.1.1 would hide
    // on every 2.1.1 prerelease, the tester's view included.
    expect(newSince('2.1.1', '2.1.0')).toBe(true)
  })
})

describe('bootWhatsNewSurface — which surface carries the notes this launch', () => {
  it('the harness is the surface whenever it is going to run', () => {
    expect(bootWhatsNewSurface({ tourWillRun: true, whatsNewDue: true })).toBe('tour')
    expect(bootWhatsNewSurface({ tourWillRun: true, whatsNewDue: false })).toBe('tour')
  })

  it('the harness is ALSO the surface for a version change with no tour due', () => {
    // Reversed from the original on 2026-08-21. This case used to return
    // 'modal' — and it is the case that actually shipped, because the pending
    // changelog entry is authored ahead of the version bump, so every dev and
    // preview build read as a within-line upgrade with no tour. That is how a
    // wall-of-text modal was what an upgrader saw. There is no modal arm now:
    // the harness opens in what's-new-only mode.
    expect(bootWhatsNewSurface({ tourWillRun: false, whatsNewDue: true })).toBe('tour')
  })

  it('nothing shows when nothing changed', () => {
    expect(bootWhatsNewSurface({ tourWillRun: false, whatsNewDue: false })).toBe('none')
  })
})

describe('decideUpgradeFlow — a "seen" stamp no build of that version ever wrote (#369)', () => {
  // The beta.16 incident. A beta.15-era build stamped `lastSeenVersion` from
  // the changelog head (beta.16, pending) rather than from the version it was
  // running. The real beta.16 then compared the stamp to itself, read
  // `same-version`, and never showed the page. Nothing corrected it: the
  // "corrects itself on the next launch" claim held only for a stamp two or
  // more releases ahead, and the stamp that actually gets written is always
  // exactly one ahead.
  //
  // The witness is the version that actually RAN last (`lastRunVersion`, or
  // `setupVersion` on a meta written before that field existed — every build
  // since 1.x has stamped it with its own version). A stamp newer than any
  // build that ran cannot have been written on the build it names.
  it('shows the page when the stamp equals the running build but is NEWER than the last build that ran', () => {
    const d = decideUpgradeFlow({
      lastSeenVersion: '2.1.0-beta.16',   // stamped by a beta.15 build, from the changelog head
      lastRunVersion: '2.1.0-beta.15',    // the last build that actually ran
      currentVersion: '2.1.0-beta.16',
      channel: 'beta',
    })
    expect(d.showWhatsNew).toBe(true)
    expect(d.reason).toBe('stamped-ahead')
  })

  it('still shows nothing when the stamp was written by the running build itself', () => {
    // The ordinary relaunch: seen on beta.16, ran beta.16, running beta.16.
    const d = decideUpgradeFlow({
      lastSeenVersion: '2.1.0-beta.16',
      lastRunVersion: '2.1.0-beta.16',
      currentVersion: '2.1.0-beta.16',
    })
    expect(d).toMatchObject({ kind: 'nothing', showWhatsNew: false, reason: 'same-version' })
  })

  it('does not re-show after a downgrade once the notes for that build were acknowledged', () => {
    // Ran beta.17 without acknowledging, dropped back to beta.16 whose notes
    // WERE acknowledged on beta.16: the stamp (beta.16) is older than the last
    // run (beta.17), so it is trusted, and it matches the running build.
    const d = decideUpgradeFlow({
      lastSeenVersion: '2.1.0-beta.16',
      lastRunVersion: '2.1.0-beta.17',
      currentVersion: '2.1.0-beta.16',
    })
    expect(d.showWhatsNew).toBe(false)
  })

  it('without any witness, trusts the stamp as before', () => {
    // A meta with no record of what ran (neither field) is the pre-existing
    // behaviour, and every other test in this file: the stamp decides.
    const d = decideUpgradeFlow({ lastSeenVersion: '2.1.0-beta.16', currentVersion: '2.1.0-beta.16' })
    expect(d.reason).toBe('same-version')
  })

  it('a stamp ahead by MORE than one release already showed (the one case the old rule caught)', () => {
    const d = decideUpgradeFlow({
      lastSeenVersion: '2.1.0-beta.17',
      lastRunVersion: '2.1.0-beta.15',
      currentVersion: '2.1.0-beta.16',
    })
    expect(d.showWhatsNew).toBe(true)
  })

  it('a fresh install stays a fresh install even if some build ran before', () => {
    // No stamp at all means the tour never finished; the tour, not the notes,
    // is what that user gets (deriveOnboarding has them). lastRunVersion must
    // not turn that into an upgrade.
    const d = decideUpgradeFlow({ lastRunVersion: '2.1.0-beta.15', currentVersion: '2.1.0-beta.16' })
    expect(d.kind).toBe('first-install')
    expect(d.showWhatsNew).toBe(false)
  })
})

describe('seenVersionFor — the version the user can actually have seen', () => {
  it('clamps a stamp that is ahead of the last build that ran', () => {
    expect(seenVersionFor({ lastSeenVersion: '2.1.0-beta.16', lastRunVersion: '2.1.0-beta.15' })).toBe('2.1.0-beta.15')
  })
  it('leaves a stamp at or behind the last run alone', () => {
    expect(seenVersionFor({ lastSeenVersion: '2.1.0-beta.16', lastRunVersion: '2.1.0-beta.16' })).toBe('2.1.0-beta.16')
    expect(seenVersionFor({ lastSeenVersion: '2.1.0-beta.15', lastRunVersion: '2.1.0-beta.17' })).toBe('2.1.0-beta.15')
  })
  it('passes through when there is no witness, or no stamp', () => {
    expect(seenVersionFor({ lastSeenVersion: '2.1.0-beta.16' })).toBe('2.1.0-beta.16')
    expect(seenVersionFor({ lastRunVersion: '2.1.0-beta.16' })).toBeUndefined()
    expect(seenVersionFor({})).toBeUndefined()
  })
})

describe('lastRunVersionOf — which meta field witnesses the last run', () => {
  it('prefers lastRunVersion, falls back to setupVersion, else undefined', () => {
    expect(lastRunVersionOf({ lastRunVersion: '2.1.0-beta.16', setupVersion: '2.1.0-beta.15' })).toBe('2.1.0-beta.16')
    expect(lastRunVersionOf({ setupVersion: '2.1.0-beta.15' })).toBe('2.1.0-beta.15')
    expect(lastRunVersionOf({})).toBeUndefined()
  })
})
