/**
 * aicc_planning#88: the session dialog's SSH card said "plain session", and
 * users took "plain" to mean no AI, the word the Terminal only card uses for
 * exactly that. The sidebar-marks showcase page described the blue SSH mark
 * with the same word ("A plain remote session"). It now says what tells the
 * kind apart, as the dialog card does: the session ends when the link drops.
 */
import { describe, it, expect } from 'vitest'
import { SHOWCASES } from '../../../src/renderer/onboarding/showcase-pages'

describe('sidebar-marks showcase page: the blue SSH mark (aicc_planning#88)', () => {
  const page = SHOWCASES.find((p) => p.id === 'sidebarMarks')!
  const blue = page.points.find((p) => p.lead === 'Blue SSH.')!

  it('says the session ends when the link drops', () => {
    expect(blue.rest).toBe('A remote session that ends when the link drops.')
  })

  it('no point on the page calls an SSH session plain', () => {
    for (const p of page.points) expect(`${p.lead} ${p.rest}`, p.lead).not.toMatch(/\bplain\b/i)
  })
})
