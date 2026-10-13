// @vitest-environment jsdom
/**
 * O3 C6, C7, C8 (2026-10-11): Hello Codex's lines about usage and the
 * attention dot, as 2.1.1 ships them.
 *
 * - "How Codex differs" said Codex reports tokens only and that Claude's
 *   rate-limit figures do not apply; since 2.1.1 the Usage page shows each
 *   ChatGPT-signed-in Codex account's 5-hour and weekly allowance (or its
 *   credits), and an API-key account is billed per token, with no allowance.
 * - The comparison table's usage row said the same stale thing.
 * - The launch page did not name the one-time "Hooks need review" prompt
 *   every Codex account meets, which the attention dot depends on.
 *
 * Kept apart from hello-codex.acceptance.test.ts, which another change edits
 * in the same release.
 */
import { describe, it, expect } from 'vitest'

;(globalThis as any).__APP_VERSION__ = '2.1.1-beta.3'

const { helloCodexPages, helloCodexComparison } = await import('../../../src/renderer/onboarding/hello-codex')

const EM_DASH = String.fromCharCode(0x2014)
const inputs = [
  { claudeReview: true, claudeOn: true },
  { claudeReview: true, claudeOn: false },
  { claudeReview: false, claudeOn: true },
]

describe('Hello Codex: usage and the hooks prompt, as 2.1.1 ships them', () => {
  it('C6: the differences page says where each Codex account\'s usage is, and that an API key has no allowance', () => {
    for (const i of inputs) {
      const usage = helloCodexPages(i).find((p) => p.id === 'differences')!.points.find((p) => p.lead === 'Usage.')!
      expect(usage.rest).toContain('5-hour and weekly allowance')
      expect(usage.rest).toContain('Usage page')
      expect(usage.rest).toContain('API-key account is billed per token')
      expect(usage.rest).not.toMatch(/tokens per session and review/)
      expect(usage.rest).not.toMatch(/rate-limit figures do not apply/)
      expect(usage.rest.includes(EM_DASH)).toBe(false)
    }
  })

  it('C7: the comparison table\'s usage row matches', () => {
    for (const i of inputs) {
      const rows = helloCodexComparison(i)
      expect(rows.find(([w]) => w === 'Usage shown'), 'the old row is gone').toBeUndefined()
      const row = rows.find(([w]) => w === 'Usage page')!
      expect(row).toBeDefined()
      expect(row[2]).toContain('5-hour and weekly allowance')
      expect(row[2]).toContain('per token for an API key')
      expect(row[2]).not.toMatch(/when it sends them/)
    }
  })

  it('C8: the launch page names the one-time hooks prompt, with the button to press', () => {
    for (const i of inputs) {
      const launch = helloCodexPages(i).find((p) => p.id === 'launch')!
      const hooks = launch.points.find((p) => p.lead === 'Trust the hooks once.')
      expect(hooks, 'the launch page names the hooks prompt').toBeDefined()
      expect(hooks!.rest).toContain('Trust all and continue')
      expect(launch.points.length).toBeLessThanOrEqual(4)
    }
  })
})
