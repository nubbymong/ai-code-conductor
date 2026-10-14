// A stream's reads go to the log redacted on whole lines, so a credential
// split across two reads is still hidden. Run with
// the real failure redactor, at every split point of a line.
import { describe, it, expect } from 'vitest'
import { createLineRedactor, LOG_LINE_CARRY_MAX } from '../../../src/main/log-line-redact'
import { redactFailure, redactHead } from '../../../src/main/providers/review-support'

const redact = (text: string) => redactHead(text, redactFailure)
const BEARER = 'QQQQQQQQQQabcdef0123456789xyz'
const PASSWORD = 'pa55word-fixture-0004'
const LINES = [
  `request failed: Authorization: Bearer ${BEARER}\n`,
  `fatal: could not read from https://agent:${PASSWORD}@example.invalid/repo.git\n`,
]

/** Every read's output and the flush, joined: what the log gets. */
function logged(chunks: string[]): string {
  const r = createLineRedactor(redact)
  return chunks.map((c) => r.push(c)).join('') + r.flush()
}

describe('createLineRedactor', () => {
  it('the redactor hides each test credential when it sees the whole line (the premise)', () => {
    for (const line of LINES) {
      const shown = redact(line)
      expect(shown).not.toContain(BEARER.slice(0, 6))
      expect(shown).not.toContain(PASSWORD.slice(0, 6))
    }
  })

  it('a line split at any point across two reads is logged as the whole line redacted', () => {
    for (const line of LINES) {
      for (let i = 1; i < line.length; i++) {
        const out = logged([line.slice(0, i), line.slice(i)])
        expect(out, `split at ${i}`).toBe(redact(line))
      }
    }
  })

  it('...and across three reads', () => {
    const line = LINES[1]
    for (let i = 1; i < line.length - 1; i += 7) {
      for (let j = i + 1; j < line.length; j += 11) {
        expect(logged([line.slice(0, i), line.slice(i, j), line.slice(j)])).toBe(redact(line))
      }
    }
  })

  it('a read gives back the whole lines it completes and holds the rest', () => {
    const r = createLineRedactor(redact)
    expect(r.push('first line\nrequest failed: Authorization: Bearer QQQQ')).toBe('first line\n')
    const second = r.push(`${BEARER.slice(4)}\nthird `)
    expect(second).toContain('request failed: Authorization: Bearer ')
    expect(second).not.toContain('QQQQ')
    expect(second).not.toContain('abcdef')
    expect(r.flush()).toBe('third ')
    expect(r.flush()).toBe('')
  })

  it('a carriage return ends a line too', () => {
    const r = createLineRedactor(redact)
    expect(r.push('progress 10%\rprogress 2')).toBe('progress 10%\r')
    expect(r.push('0%\r')).toBe('progress 20%\r')
  })

  it('a read that completes no line logs nothing; the stream\'s end logs what is held, redacted', () => {
    const r = createLineRedactor(redact)
    expect(r.push('fatal: could not read from https://agent:pa55')).toBe('')
    expect(r.push('word-fixture-0004@example.invalid/x')).toBe('')
    const last = r.flush()
    expect(last).toContain('https://[REDACTED]@example.invalid/x')
    expect(last).not.toContain('pa55')
  })

  it('an unfinished line past the bound is logged as it stands, so what is held stays bounded', () => {
    const r = createLineRedactor(redact, 16)
    expect(r.push('a'.repeat(10))).toBe('')
    expect(r.push('b'.repeat(10))).toBe(`${'a'.repeat(10)}${'b'.repeat(10)}`)
    expect(r.flush()).toBe('')
    expect(LOG_LINE_CARRY_MAX).toBe(8 * 1024)
  })

  it('an empty read changes nothing', () => {
    const r = createLineRedactor(redact)
    expect(r.push('')).toBe('')
    expect(r.push('held')).toBe('')
    expect(r.push('')).toBe('')
    expect(r.flush()).toBe('held')
  })
})
