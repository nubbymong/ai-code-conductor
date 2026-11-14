/**
 * What Sentinel says when its AI analysis fails on the analysis account.
 *
 * Owner report (2.1.3-beta.1): an account whose login had expired was said
 * to have "hit its usage limit", was called "auto-picked, your chosen
 * analysis account is no longer available" with no account chosen, the
 * message came twice in one run, and the CLI's own remedy was cut off in
 * the middle of a sentence. Each of those is pinned here, on the pure
 * functions; the once-per-run rule and the wiring are pinned through the
 * real service in main/sentinel-codex-service.test.ts.
 *
 * No account address appears in this file: ACCOUNT stands in for one.
 */
import { describe, it, expect } from 'vitest'
import { envelopeError, analysisFailureMessage, runAnalysis, plainErrorReason } from '../../src/main/sentinel/sentinel-analysis'
import { claudeAnalysisAccountLabel, codexAnalysisAccountLabel } from '../../src/main/sentinel/sentinel-account'
import { sentinelCodexAccountOffered } from '../../src/shared/providers/accounts-view'
import type { AccountView } from '../../src/shared/providers/accounts-view'

/** The CLI's own text for a login that ran out, as the owner saw it. */
const EXPIRED_LOGIN = 'Failed to authenticate: this login reached its time limit and cannot be renewed. Run claude auth login to sign in again, or use claude setup-token and set CLAUDE_CODE_OAUTH_TOKEN for a long-lived login.'
const envelope = (result: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'result', is_error: true, result, ...extra })

describe('a login that has expired is a sign-in problem, never a usage limit', () => {
  it('the owner\'s message: read as a sign-in failure, although it says "time limit"', () => {
    const e = envelopeError(envelope(EXPIRED_LOGIN))!
    expect(e.signIn).toBe(true)
    expect(e.rateLimited).toBe(false)
    expect(e.unreachable).toBe(false)
  })

  it('a 401 from the service is a sign-in failure whatever its text', () => {
    const e = envelopeError(envelope('Request was not accepted', { api_error_status: 401 }))!
    expect(e.signIn).toBe(true)
    expect(e.rateLimited).toBe(false)
  })

  it.each([
    'OAuth token has expired. Please run /login',
    'Invalid API key · Please run /login',
    'Not logged in · Please run /login',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
    'Codex exited with code 1: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    'Codex exited with code 1: unexpected status 401 Unauthorized',
  ])('the CLIs\' other sign-in failures: %s', (text) => {
    const e = envelopeError(envelope(text))!
    expect(e.signIn).toBe(true)
    expect(e.rateLimited).toBe(false)
  })

  it('usage limits are still usage limits', () => {
    for (const text of ["You've hit your weekly limit · resets 4am (Europe/London)", "You've hit your limit · resets 3pm", "Codex exited with code 1: You've hit your usage limit.", 'Usage limit reached.', 'API Error: Rate limit reached']) {
      const e = envelopeError(envelope(text))!
      expect(e.rateLimited, text).toBe(true)
      expect(e.signIn, text).toBe(false)
    }
  })

  it('a 429 is a usage limit even when its text speaks of signing in', () => {
    const e = envelopeError(envelope('Limit reached. Sign in again later.', { api_error_status: 429 }))!
    expect(e.rateLimited).toBe(true)
    expect(e.signIn).toBe(false)
  })

  it('a sign-in failure whose text also speaks of a limit is still a sign-in failure', () => {
    const e = envelopeError(envelope('Not logged in · Please run /login to see your usage limit'))!
    expect(e.signIn).toBe(true)
    expect(e.rateLimited).toBe(false)
    // What went wrong only: the CLI's own remedy after its " · " is not echoed.
    expect(e.reason).toBe('Not logged in')
  })

  // Review finding: the reverse of the owner's bug. A usage limit whose text
  // also said how to change account was read as signed out, lost its reset
  // time, and the user was told to sign in again when the remedy was to wait.
  it.each([
    ["You've hit your limit · resets 4am. Please run /login to switch accounts", 'resets 4am'],
    ['Usage limit reached. You can sign in again with another account after reset', 'Usage limit reached'],
    ["You've hit your weekly limit · resets 4am (Europe/London) · run claude auth login to use another account", 'resets 4am (Europe/London)'],
    ['Rate limit reached. Log in again with a different account to continue', 'Rate limit reached'],
  ])('a usage limit whose text also says how to sign in is still a usage limit, and keeps its reset time: %s', (text, kept) => {
    const e = envelopeError(envelope(text))!
    expect(e.rateLimited).toBe(true)
    expect(e.signIn).toBe(false)
    expect(e.reason).toContain(kept)
    const msg = analysisFailureMessage('', e, 'ACCOUNT, the primary account')
    expect(msg).toMatch(/has hit its usage limit/)
    expect(msg).toContain(kept)
    expect(msg).not.toMatch(/signed out/i)
  })

  it.each([
    'Failed to authenticate: the rate limit could not be read. Please run /login',
    'OAuth token has expired, so your usage limit could not be read. Please run /login',
    'API Error: authentication_error while reading the usage limit',
    'Invalid API key · the usage limit could not be read',
    'Codex exited with code 1: 401 Unauthorized while reading the usage limit',
    'Your login has expired, so the usage limit could not be read',
  ])('a text that says outright that the sign-in failed is a sign-in failure, even with a limit in it: %s', (text) => {
    const e = envelopeError(envelope(text))!
    expect(e.signIn).toBe(true)
    expect(e.rateLimited).toBe(false)
  })

  it('a 401 from the service is a sign-in failure even when its text speaks of a limit', () => {
    const e = envelopeError(envelope("You've hit your limit. Please run /login", { api_error_status: 401 }))!
    expect(e.signIn).toBe(true)
    expect(e.rateLimited).toBe(false)
  })

  it.each([
    'Please run /login',
    'Codex exited with code 1: Please sign in again.',
    'Run claude auth login to continue',
  ])('with no limit in the text, being told to sign in is a sign-in failure as before: %s', (text) => {
    const e = envelopeError(envelope(text))!
    expect(e.signIn).toBe(true)
    expect(e.rateLimited).toBe(false)
  })

  it('a sign-in that could not reach the service is said as unreachable, not as signed out', () => {
    const e = envelopeError(envelope('Failed to authenticate: connect ECONNREFUSED 10.0.0.5:443'))!
    expect(e.unreachable).toBe(true)
    expect(e.signIn).toBe(false)
    expect(e.rateLimited).toBe(false)
  })

  it('a time limit that is not about a login is neither a usage limit nor a sign-in failure', () => {
    const e = envelopeError(envelope('The request reached its time limit'))!
    expect(e.rateLimited).toBe(false)
    expect(e.signIn).toBe(false)
  })

  it('the message says it is signed out, names the account, and gives this app\'s remedy in full', () => {
    const msg = analysisFailureMessage('', envelopeError(envelope(EXPIRED_LOGIN)), 'ACCOUNT, the primary account')
    expect(msg).not.toMatch(/usage limit/i)
    expect(msg).not.toMatch(/once it resets/i)
    expect(msg).toMatch(/signed out/i)
    expect(msg).toContain('(ACCOUNT, the primary account)')
    // Why, in the CLI's own first sentence, whole.
    expect(msg).toContain('this login reached its time limit and cannot be renewed.')
    // The CLI's remedy signs its own global login in, not this app's account: never echoed, never half of it.
    expect(msg).not.toContain('claude auth login')
    expect(msg).not.toContain('setup-token')
    expect(msg).not.toContain('(cut short)')
    // This app's remedy, whole, and the message ends on a whole sentence.
    expect(msg).toContain('Sign that account in again from its card on the Usage page, or pick a different account in Settings → Sentinel, then use Re-run.')
    expect(msg.endsWith('The deterministic checks still ran.')).toBe(true)
  })

  it('a sign-in failure with no text still has a reason', () => {
    const msg = analysisFailureMessage('', envelopeError(envelope('', { api_error_status: 401 })), null)
    expect(msg).toMatch(/signed out/i)
    expect(msg).toContain('HTTP 401')
  })

  it('a usage limit keeps its own message', () => {
    const msg = analysisFailureMessage('', envelopeError(envelope("You've hit your weekly limit · resets 4am", { api_error_status: 429 })), 'ACCOUNT, the primary account')
    expect(msg).toMatch(/has hit its usage limit/)
    expect(msg).toContain('resets 4am')
    expect(msg).toMatch(/Re-run once it resets/)
    expect(msg).not.toMatch(/signed out/i)
  })

  it('an expired login is not tried a second time in the same analysis', async () => {
    let runs = 0
    const r = await runAnalysis({
      runner: async () => { runs++; return { code: 1, stdout: envelope(EXPIRED_LOGIN), stderr: '' } },
      changelog: '## 2.1.0 - x', from: '2.0.0', to: '2.1.0', accountLabel: 'ACCOUNT, the primary account',
    })
    expect(runs).toBe(1)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/signed out/i)
      expect(r.error).not.toMatch(/usage limit/i)
    }
  })
})

describe('a long reason is never left half a sentence', () => {
  it('whole sentences that fit are kept, the one that does not is dropped whole', () => {
    const first = 'The service refused the request because the organisation has disabled this model for every member'
    const second = 'Ask an administrator to turn it back on in the console, or choose another model in the settings page of the workspace'
    const reason = plainErrorReason(`${first}. ${second}.`)
    expect(reason).toBe(`${first} (cut short)`)
  })

  it('one sentence longer than the cap is still cut at a word, and says so', () => {
    const long = plainErrorReason('word '.repeat(60))
    expect(long.endsWith(' (cut short)')).toBe(true)
    expect(long.length).toBeLessThan(200)
  })

  it('a version number or a host name is not a sentence end', () => {
    const text = `Request to api.example.com with v2.1.300 failed ${'again and again '.repeat(12)}`
    const reason = plainErrorReason(text)
    expect(reason.startsWith('Request to api.example.com with v2.1.300 failed again')).toBe(true)
    expect(reason.endsWith(' (cut short)')).toBe(true)
  })

  // Review finding: a first sentence longer than the cap was cut at a word
  // inside a bracket, and the message went on with the bracket left open.
  const open = (s: string) => (s.match(/[([]/g) ?? []).length - (s.match(/[)\]]/g) ?? []).length

  it('a cut never leaves a bracket open: the text goes back to before the bracket', () => {
    expect(plainErrorReason(`Failed to authenticate (${'word '.repeat(60)}end)`)).toBe('Failed to authenticate (cut short)')
    expect(plainErrorReason(`The service refused the request [${'word '.repeat(60)}end]`)).toBe('The service refused the request (cut short)')
  })

  it('with one bracket inside another, it goes back to before the first one left open', () => {
    expect(plainErrorReason(`Refused by the service (first reason (second reason ${'word '.repeat(60)}end))`)).toBe('Refused by the service (cut short)')
    // The inner one closed inside the cap, the outer one did not.
    expect(plainErrorReason(`Refused by the service (first (second) ${'word '.repeat(60)}end)`)).toBe('Refused by the service (cut short)')
  })

  it('a bracket that closes inside the cap is kept as it is', () => {
    const reason = plainErrorReason(`The request (id 42) was refused ${'again and again '.repeat(12)}`)
    expect(reason.startsWith('The request (id 42) was refused again and again')).toBe(true)
    expect(reason.endsWith(' (cut short)')).toBe(true)
    expect(open(reason)).toBe(0)
  })

  it('a text that opens with its bracket has nothing to go back to: the bracket is closed', () => {
    const reason = plainErrorReason(`(${'word '.repeat(60)}end)`)
    expect(reason.startsWith('(word word')).toBe(true)
    expect(reason.endsWith('word) (cut short)')).toBe(true)
    expect(open(reason)).toBe(0)
    // Two kinds, one inside the other: closed inner first, each with its own mark.
    expect(plainErrorReason(`([${'word '.repeat(60)}end])`).endsWith('word]) (cut short)')).toBe(true)
  })

  it('a closing bracket with none before it changes nothing', () => {
    const reason = plainErrorReason(`one) two ${'word '.repeat(60)}`)
    expect(reason.startsWith('one) two word')).toBe(true)
    expect(reason.endsWith('word (cut short)')).toBe(true)
  })

  it('the sign-in message with a long bracketed first sentence reads whole', () => {
    const e = envelopeError(envelope(`Failed to authenticate (${'word '.repeat(60)}end). Run claude auth login to sign in again.`))!
    expect(e.signIn).toBe(true)
    expect(e.reason).toBe('Failed to authenticate (cut short)')
    const msg = analysisFailureMessage('', e, 'ACCOUNT, the primary account')
    expect(msg).toContain('could not run: Failed to authenticate (cut short). Sign that account in again from its card on the Usage page')
    expect(open(msg)).toBe(0)
  })
})

describe('which account the analysis ran on, and why', () => {
  const profiles = [
    { id: 'profile-a', accountEmail: 'ACCOUNT-A', isPrimary: true },
    { id: 'profile-b', accountEmail: 'ACCOUNT-B' },
    { id: 'profile-c', accountEmail: '' },
  ]

  it('no account chosen, the primary one used: named as the primary account, never as auto-picked', () => {
    const label = claudeAnalysisAccountLabel({ chosen: null, used: 'profile-a', profiles })
    expect(label).toBe('ACCOUNT-A, the primary account')
  })

  it('the owner\'s case: a saved choice whose account was removed shows as the default in Settings, so it is the default here too', () => {
    const label = claudeAnalysisAccountLabel({ chosen: 'profile-removed', used: 'profile-a', profiles })
    expect(label).toBe('ACCOUNT-A, the primary account')
    expect(label).not.toMatch(/auto-picked|no longer available/)
  })

  it('the chosen account used: said as chosen', () => {
    expect(claudeAnalysisAccountLabel({ chosen: 'profile-b', used: 'profile-b', profiles })).toBe('ACCOUNT-B, the account chosen in Settings')
  })

  it('a chosen account that is still listed but could not be used: auto-picked, and only then', () => {
    expect(claudeAnalysisAccountLabel({ chosen: 'profile-b', used: 'profile-a', profiles }))
      .toBe('ACCOUNT-A; auto-picked — your chosen analysis account is no longer available')
  })

  it('no account chosen and no primary one: auto-picked, for that reason', () => {
    const noPrimary = profiles.map((p) => ({ ...p, isPrimary: false }))
    expect(claudeAnalysisAccountLabel({ chosen: null, used: 'profile-b', profiles: noPrimary })).toBe('ACCOUNT-B; auto-picked — no primary account is set')
  })

  // Review finding: "no primary account is set" was said when one was set
  // and could not be used (its folder was missing, so another was picked).
  it('no account chosen and a primary account that could not be used: auto-picked, for that reason, never "no primary account is set"', () => {
    const label = claudeAnalysisAccountLabel({ chosen: null, used: 'profile-b', profiles })
    expect(label).toBe('ACCOUNT-B; auto-picked — the primary account could not be used')
    expect(label).not.toMatch(/no primary account is set/)
  })

  it('a removed choice and a primary account that could not be used: the same', () => {
    expect(claudeAnalysisAccountLabel({ chosen: 'profile-removed', used: 'profile-b', profiles }))
      .toBe('ACCOUNT-B; auto-picked — the primary account could not be used')
  })

  it('an account the list does not have is named by its id, with the reason that is true of the list', () => {
    expect(claudeAnalysisAccountLabel({ chosen: null, used: 'profile-x', profiles })).toBe('profile-x; auto-picked — the primary account could not be used')
    const noPrimary = profiles.map((p) => ({ ...p, isPrimary: false }))
    expect(claudeAnalysisAccountLabel({ chosen: null, used: 'profile-x', profiles: noPrimary })).toBe('profile-x; auto-picked — no primary account is set')
    expect(claudeAnalysisAccountLabel({ chosen: null, used: 'profile-x', profiles: [] })).toBe('profile-x; auto-picked — no primary account is set')
  })

  it('an account with no address yet is named by its id', () => {
    expect(claudeAnalysisAccountLabel({ chosen: 'profile-c', used: 'profile-c', profiles })).toBe('profile-c, the account chosen in Settings')
  })

  it('Codex: the chosen account, the review account, and a fallback from a choice that stands', () => {
    expect(codexAnalysisAccountLabel('Work', 'chosen')).toBe('Work, the account chosen in Settings')
    expect(codexAnalysisAccountLabel('Work', 'default')).toBe('Work, the Codex review account')
    expect(codexAnalysisAccountLabel('Work', 'fell-back')).toBe('Work; auto-picked, your chosen analysis account could not be used')
  })
})

describe('the Codex accounts Settings offers for the analysis (one rule, main and Settings)', () => {
  const offered = { providerId: 'codex', lifecycle: 'active', operationalState: 'ready', unverified: false, external: false } as unknown as AccountView

  it('an active, vouched-for account that reviews can run on is offered', () => {
    expect(sentinelCodexAccountOffered(offered)).toBe(true)
  })

  it.each([
    ['archived', { lifecycle: 'archived' }],
    ['inactive', { lifecycle: 'inactive' }],
    ['blocked', { operationalState: 'blocked' }],
    ['unverified', { unverified: true }],
    ['this computer\'s own sign-in', { external: true }],
    ['one reviews cannot run on', { reviewRefusal: 'platform' }],
    ['a Claude account', { providerId: 'claude' }],
  ])('%s is not', (_name, change) => {
    expect(sentinelCodexAccountOffered({ ...offered, ...change } as unknown as AccountView)).toBe(false)
  })
})
