/**
 * 2.1.3-beta.19 text smoke (#42), an outside finding: the Feature Guide's
 * Reference showed 'Known issues and workarounds' as ONE paragraph, a single
 * <p> of 93,293 characters, 25,498 px tall, `white-space: normal`, so the
 * blank lines between its entries were gone and each issue ran into the next.
 * The Reference's bodies (app-knowledge's sections, and the search results
 * that show the same bodies) keep their line breaks now (`whitespace-pre-line`).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APP_KNOWLEDGE_SECTIONS } from '../../../src/shared/app-knowledge'

describe('the Feature Guide\'s Reference keeps the breaks between its entries', () => {
  it('the known issues are many entries, each apart from the next by a blank line', () => {
    const known = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'known-issues')!
    expect(known).toBeDefined()
    expect(known.body.split('\n\n').length).toBeGreaterThan(50)
  })

  it('both places that show a section\'s body keep its line breaks', () => {
    const page = readFileSync(join(process.cwd(), 'src/renderer/components/FeatureGuidePage.tsx'), 'utf8')
    const bodies = page.split('\n').filter((l) => l.includes('{s.body}</p>'))
    expect(bodies).toHaveLength(2)
    for (const l of bodies) expect(l, l).toContain('whitespace-pre-line')
  })
})
