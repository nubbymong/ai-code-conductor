// The tests' shared RegExp escape (tests/helpers/escape-regexp.ts): each special
// character, a text made of all of them, and the texts the callers pass are
// matched as themselves and only as themselves, with and without the u flag.
import { describe, it, expect } from 'vitest'
import { escapeRegExp } from '../../helpers/escape-regexp'

const SPECIAL = '.*+?^${}()|[]\\'

describe('escapeRegExp', () => {
  it('matches each special character, and a text of all of them, as itself', () => {
    for (const text of [...SPECIAL, SPECIAL, 'registerLogsWipeHandlers(getWindow)', '.mark', 'WP1.11']) {
      for (const flags of ['', 'u']) {
        const re = new RegExp(`^${escapeRegExp(text)}$`, flags)
        expect(re.test(text), `${text} /${flags}`).toBe(true)
        // A text of the same length with its first character changed is not matched.
        expect(re.test(`a${text.slice(1)}`), `${text} /${flags}`).toBe(text.startsWith('a'))
      }
    }
  })

  it('leaves every other character as it is', () => {
    expect(escapeRegExp('abc XYZ 123 -/,:;=<>!@#%&~`\'"')).toBe('abc XYZ 123 -/,:;=<>!@#%&~`\'"')
  })
})
