// The Account usage page's renewal routes are wired into the app
// (nubbymong/aicc_planning#444): main sets the primary's and a not-yet-checked
// folder's renewal to Claude Code's own `claude auth status`
// (readClaudeCliAuth), and the duplicate / wrong-account check to the same
// cross-check the page's banners read. Nothing on that path runs `claude -p`,
// which would bill a model call.
//
// Read from the source: the start sequence runs inside Electron's ready
// handler, which no unit test here starts; the behaviour itself is pinned in
// tests/unit/account-usage-renewal.test.ts and the probe's own arguments in
// tests/unit/claude-cli-auth-read.test.ts.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/** A source file with its comments taken out (a line comment, a block comment). */
function code(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/ .*$/gm, '')
}

/** The argument text of the first call to `name(`. */
function argsOf(src: string, name: string): string {
  const at = src.indexOf(`${name}(`)
  expect(at, `${name}( is called`).toBeGreaterThanOrEqual(0)
  const open = at + name.length
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  throw new Error('unbalanced call')
}

const index = code('src/main/index.ts')

describe('the usage page renewal routes are wired at start', () => {
  it('the CLI renewal is readClaudeCliAuth, for the profile id alone', () => {
    const arg = argsOf(index, 'setClaudeCliRenewal')
    expect(arg.replace(/\s+/g, '')).toBe('(profileId)=>readClaudeCliAuth(profileId)')
  })

  it('the sign-in problem check is the panel\'s own cross-check, quiet', () => {
    const arg = argsOf(index, 'setClaudeSignInProblem')
    expect(arg.replace(/\s+/g, '')).toBe('(profileId)=>signInProblemOf(readAllProfileAuthInfo({quiet:true}),profileId)')
  })

  it('both are set beside the usage page\'s other start seam, before the usage handlers', () => {
    const allowed = index.indexOf('setClaudeAccountDataAllowed(')
    expect(allowed).toBeGreaterThan(0)
    expect(index.indexOf('setClaudeCliRenewal(')).toBeGreaterThan(allowed)
    expect(index.indexOf('setClaudeSignInProblem(')).toBeGreaterThan(allowed)
    const handlers = index.indexOf('registerUsageHandlers(')
    expect(handlers).toBeGreaterThan(0)
    expect(index.indexOf('setClaudeCliRenewal(')).toBeLessThan(handlers)
    expect(index.indexOf('setClaudeSignInProblem(')).toBeLessThan(handlers)
  })
})

describe('no `claude -p` on the renewal path', () => {
  const PRINT = /['"`](?:-p|--print)['"`]/

  it('the usage module and the status probe pass no -p / --print argument', () => {
    expect(code('src/main/usage/account-usage.ts')).not.toMatch(PRINT)
    expect(code('src/main/account-web/claude-cli-auth.ts')).not.toMatch(PRINT)
  })

  it('the status probe runs `auth status` and nothing else', () => {
    const probe = code('src/main/account-web/claude-cli-auth.ts')
    const runs = [...probe.matchAll(/\[\s*'auth'\s*,\s*'([a-z-]+)'\s*\]/g)].map((m) => m[1])
    expect(runs.length).toBeGreaterThan(0)
    // The status probe and the sign-out's own command; never a model call.
    expect(new Set(runs)).toEqual(new Set(['status', 'logout']))
  })
})
