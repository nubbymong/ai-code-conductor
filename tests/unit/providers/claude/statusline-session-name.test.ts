// aicc_planning#305: the local statusline bridge forwards Claude Code's own
// session name (`session_name`) as `sessionName`: text only, at most 200
// characters. The expression is read out of the script as DEPLOYED (it is
// emitted from a template literal, so what runs is what is tested) and
// evaluated on its own: the rest of the bridge reads the account's sign-in
// and may call the usage API, which a unit test must not.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { deployClaudeStatuslineScript } from '../../../../src/main/providers/claude/statusline'

let resDir: string
let sessionNameOf: (data: unknown) => unknown

beforeAll(async () => {
  resDir = mkdtempSync(join(tmpdir(), 'sl-name-'))
  await deployClaudeStatuslineScript(resDir)
  const script = readFileSync(join(resDir, 'scripts', 'claude-multi-statusline.js'), 'utf8')
  const m = script.match(/sessionName: (typeof data\.session_name === 'string'[\s\S]*?: undefined),\n\s*timestamp:/)
  expect(m, 'sessionName expression in the deployed script').not.toBeNull()
  sessionNameOf = new Function('data', `return (${m![1]})`) as (data: unknown) => unknown
})
afterAll(() => { rmSync(resDir, { recursive: true, force: true }) })

describe('statusline bridge: session_name (#305)', () => {
  it('forwards the name as text', () => {
    expect(sessionNameOf({ session_name: 'fix the login bug' })).toBe('fix the login bug')
  })

  it('drops control characters (terminal escapes, newlines, C1)', () => {
    expect(sessionNameOf({ session_name: 'a\u001b[31mred\u0007\nb\u009bc' })).toBe('a[31mredbc')
  })

  it('caps it at 200 characters', () => {
    expect((sessionNameOf({ session_name: 'x'.repeat(500) }) as string).length).toBe(200)
  })

  it('absent, empty after cleaning, or not a string: no name', () => {
    expect(sessionNameOf({})).toBeUndefined()
    expect(sessionNameOf({ session_name: '\u0001\u0002  ' })).toBeUndefined()
    expect(sessionNameOf({ session_name: 42 })).toBeUndefined()
  })
})
