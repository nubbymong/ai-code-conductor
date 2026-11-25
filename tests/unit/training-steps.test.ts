import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  trainingSteps,
  currentTrainingVersion,
  getNewSteps,
  compareTrainingVersions,
  type TrainingStep,
} from '../../src/renderer/training-steps'

describe('training-steps', () => {
  describe('trainingSteps array', () => {
    it('has exactly 25 steps', () => {
      // v1.5.12 added dynamic-workflows; permission-tray step removed with the
      // feature; v2-readiness added multi-account + sentinel steps (16 -> 18);
      // v2.0.0 added the ai-usage-meter step (18 -> 19); the Agent Canvas got
      // an entry of its own (19 -> 20) -- FinishStep promises the Feature Guide
      // "explains every feature", and it was the one shipped feature missing.
      // Ask Conductor was the next one missing (20 -> 21): it shipped in 2.0 as
      // "Ask Command Center" and was renamed, but never got a card (#372).
      // #443 deprecated the Agent Hub, so its card left (21 -> 20). The 2.1
      // canvas rework's Canvas Explained page got a card (20 -> 21). The second
      // provider (2.1.1) added two surfaces with no card: the Providers and
      // Accounts page, and code review in both directions (21 -> 23). Cloud
      // Agents, without a card since the Agent Hub's left, got one of its own
      // (the owner's 2026-10-04 answer; 23 -> 24). The Machines page
      // (2.1.3-beta.6) got a card of its own (24 -> 25).
      expect(trainingSteps).toHaveLength(25)
    })

    it('every step has required fields', () => {
      for (const step of trainingSteps) {
        expect(step.id).toBeTruthy()
        expect(step.title).toBeTruthy()
        // Prerelease suffixes are legal since canvas-explained shipped on the
        // rc.10 line; compareVersions ignores the suffix, so '2.1.0-rc.10'
        // ranks as 2.1.0 for tour-resurfacing purposes.
        expect(step.sinceVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/)
        expect(step.bullets.length).toBeGreaterThan(0)
        expect(step.screenshotFilename).toMatch(/\.jpg$/)
      }
    })

    it('has unique step ids', () => {
      const ids = trainingSteps.map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('original steps have unique screenshot filenames', () => {
      const originalSteps = trainingSteps.filter(s => s.sinceVersion === '1.0.0')
      const filenames = originalSteps.map((s) => s.screenshotFilename)
      expect(new Set(filenames).size).toBe(filenames.length)
    })

    it('steps are in logical order starting with session-options and ending with github-sidebar', () => {
      expect(trainingSteps[0].id).toBe('session-options')
      expect(trainingSteps[trainingSteps.length - 1].id).toBe('github-sidebar')
    })
  })

  describe('the Ask Conductor entry (#372)', () => {
    // Fail loudly on a missing step rather than letting a non-null assertion
    // throw an opaque TypeError three lines later.
    const ask = (): TrainingStep => {
      const step = trainingSteps.find((s) => s.id === 'ask-conductor')
      if (!step) throw new Error('no trainingSteps entry with id "ask-conductor" (#372)')
      return step
    }

    it('exists, so the Feature Guide covers the help surface itself', () => {
      // Asserted against the id list rather than through ask(), which finds BY
      // id and so could only ever agree with itself.
      expect(trainingSteps.map((s) => s.id)).toContain('ask-conductor')
    })

    it('is filed under its current name, never the retired 2.0 one', () => {
      const step = ask()
      expect(step.title).toBe('Ask Conductor')
      // It shipped as "Ask Command Center". The card is user-facing copy about
      // what the feature is TODAY, so the old name must not leak into it.
      // Every user-facing string on the card, howToTrigger labels and values
      // included -- those render in the card's right column.
      const copy = [
        step.title,
        step.summary ?? '',
        step.proTip ?? '',
        ...step.bullets,
        ...(step.highlights ?? []),
        ...(step.howToTrigger ?? []).flatMap((t) => [t.label, t.value]),
      ].join(' ')
      expect(copy).not.toContain('Ask Command Center')
      expect(copy).not.toContain('Command Center')
    })

    it('uses the hero layout and names a screenshot asset', () => {
      const step = ask()
      // `summary` is what switches FeatureGuidePage to the hero layout; without
      // it the card silently falls back to the flat bullet list.
      expect(step.summary).toBeTruthy()
      expect(step.highlights?.length).toBeGreaterThan(0)
      expect(step.howToTrigger?.length).toBeGreaterThan(0)
      // Only the shape is asserted here; that the file actually exists on disk
      // is covered for every step by training-screenshots-exist.test.ts.
      expect(step.screenshotFilename).toMatch(/\.jpg$/)
    })

    it('is surfaced to beta users who already ran the 2.1 tour, with only the other 2.1.1 cards and the 2.1.3 Machines card', () => {
      // The whole point of the entry. A user who finished the 2.1 tour holds
      // lastTrainingVersion '2.1.0'; getNewSteps keeps sinceVersion > that, so
      // the card has to sit ABOVE 2.1.0 or getNewSteps('2.1.0') leaves it out and
      // the cohort that already has the feature is never shown it (#372).
      // Equally only the 2.1.1 cards may be re-surfaced -- the new surfaces'
      // cards are a proportionate interruption, replaying the 2.1 set is not.
      // Cloud Agents joined them (the owner's 2026-10-04 answer). The 2.1.3
      // Machines card joins them too: it is newer than 2.1.0, and nothing opens
      // the tour by itself after an update (see the comment on the Providers and
      // Accounts card), so a pin above 2.1.1 interrupts no one.
      expect(getNewSteps('2.1.0').map((s) => s.id)).toEqual(['provider-accounts', 'ask-conductor', 'code-review', 'cloud-agents', 'machines'])
      // Users arriving from 2.0.x get it as part of the normal backlog.
      expect(getNewSteps('2.0.0').map((s) => s.id)).toContain('ask-conductor')
    })
  })

  // 2.1.3-beta.18 release smoke (card-machines): the Machines card named the
  // switches for plain terminals and for sessions, but not the third one, so
  // how to turn the remote sessions preview on was not there. The row names
  // the switch by the label Settings shows, read here from SettingsPage.tsx,
  // and by where it is (General, its Terminal section). The switch shows on
  // Windows only, so the row says that first. (The recheck of 69fd3ead: the
  // row ended "(Windows)" where Settings shows "(Linux, preview)".)
  describe('the Machines card names the remote sessions switch', () => {
    it('has a Remote row pointing at the switch by its Settings label and place', () => {
      const card = trainingSteps.find((s) => s.id === 'machines')
      if (!card) throw new Error('no trainingSteps entry with id "machines"')
      const row = (card.howToTrigger ?? []).find((t) => t.label === 'Remote')
      expect(row?.value).toBe('On Windows: Settings -> General -> Remote sessions through the session helper (Linux, preview)')
      const page = readFileSync(resolve(__dirname, '../../src/renderer/components/SettingsPage.tsx'), 'utf8')
      // The label is the text the switch's own <span> starts with.
      const at = page.indexOf('data-testid="setting-remote-sessions-helper"')
      expect(at).toBeGreaterThan(-1)
      const label = /<span>\s*([^<]+?)\s*<span/.exec(page.slice(at))?.[1]
      expect(label).toBe('Remote sessions through the session helper (Linux, preview)')
      expect(row?.value).toContain(`Settings -> General -> ${label}`)
      // ...in the General tab's Terminal section, as the row's path says.
      const general = page.indexOf("activeTab === 'general'")
      const terminal = page.indexOf('<Section title="Terminal"', general)
      const next = page.indexOf('<Section title=', terminal + 1)
      expect(general).toBeGreaterThan(-1)
      expect(terminal).toBeGreaterThan(general)
      expect(at).toBeGreaterThan(terminal)
      expect(at).toBeLessThan(next)
      // ...and shown on Windows only, as the row's "On Windows:" says.
      expect(page.slice(at - 240, at)).toContain("window.electronPlatform === 'win32' && (")
    })
  })

  describe('currentTrainingVersion', () => {
    it('returns a valid semver string', () => {
      const ver = currentTrainingVersion()
      expect(ver).toMatch(/^\d+\.\d+\.\d+$/)
    })

    it('returns the highest sinceVersion across all steps', () => {
      const ver = currentTrainingVersion()
      for (const step of trainingSteps) {
        expect(compareSemver(ver, step.sinceVersion)).toBeGreaterThanOrEqual(0)
      }
    })
  })

  // [host] PR 4 VM final: a tour stamp of a prerelease (2.1.1-beta.2) read as
  // 2.1.0 (Number('1-beta') is NaN, then 0), so the 2.1.1 cards counted as
  // unseen. A prerelease is read as its release: a 2.1.1 beta carries the
  // 2.1.1 cards.
  describe('the tour version compare reads a prerelease as its release', () => {
    it('a stamp of 2.1.1-beta.2 has seen the 2.1.1 cards; a 2.1.0 one has not', () => {
      // Only the cards pinned above 2.1.1 remain (the 2.1.3 Machines card).
      expect(getNewSteps('2.1.1-beta.2').map((s) => s.id)).toEqual(['machines'])
      expect(getNewSteps('2.1.0').map((s) => s.sinceVersion)).toContain('2.1.1')
      expect(getNewSteps('2.1.0-rc.10').map((s) => s.sinceVersion)).toContain('2.1.1')
    })
    it('orders by the numbers, whatever follows them', () => {
      expect(compareTrainingVersions('2.1.1-beta.2', '2.1.1')).toBe(0)
      expect(compareTrainingVersions('2.1.2-beta.1', '2.1.1')).toBeGreaterThan(0)
      expect(compareTrainingVersions('2.1.0-rc.10', '2.1.1')).toBeLessThan(0)
      expect(compareTrainingVersions('v2.1.1', '2.1.1')).toBe(0)
      expect(compareTrainingVersions('2.10.0', '2.9.9')).toBeGreaterThan(0)
      expect(compareTrainingVersions('garbage', '0.0.0')).toBe(0)
    })
  })

  describe('getNewSteps', () => {
    it('returns all steps when no lastVersion provided', () => {
      const steps = getNewSteps()
      expect(steps).toHaveLength(trainingSteps.length)
    })

    it('returns all steps when no lastVersion is undefined', () => {
      const steps = getNewSteps(undefined)
      expect(steps).toHaveLength(trainingSteps.length)
    })

    it('returns no steps when lastVersion equals currentTrainingVersion', () => {
      const steps = getNewSteps(currentTrainingVersion())
      expect(steps).toHaveLength(0)
    })

    it('returns no steps when lastVersion is higher than all steps', () => {
      const steps = getNewSteps('99.99.99')
      expect(steps).toHaveLength(0)
    })

    it('returns all steps when lastVersion is 0.0.0', () => {
      // All steps have sinceVersion > 0.0.0
      const steps = getNewSteps('0.0.0')
      expect(steps).toHaveLength(trainingSteps.length)
    })

    it('filters by sinceVersion correctly', () => {
      // If we set lastVersion to just below the current, should get steps at or above
      const steps = getNewSteps('0.99.99')
      // All current steps are sinceVersion 1.0.0, which is > 0.99.99
      expect(steps.length).toBeGreaterThan(0)
    })
  })
})

// Helper to verify ordering (mirrors the internal compareVersions)
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
