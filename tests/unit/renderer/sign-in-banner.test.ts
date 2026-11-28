// The banner above a sign-in tab (nubbymong/aicc_planning#444): a re-auth of
// an existing account no longer says "Setting up a new account". Starting
// claude in that tab renews a sign-in that is still valid by itself; only one
// that has truly expired needs /login, and then as the same account.
import { describe, it, expect } from 'vitest'
import { signInBannerText } from '../../../src/renderer/utils/signInBanner'

describe('signInBannerText', () => {
  it('a new account\'s tab keeps its own guidance', () => {
    expect(signInBannerText(false)).toBe("Setting up a new account. Run claude, type /login, and choose the account. We'll detect it automatically.")
  })

  it('a re-auth tab is about this account, not a new one', () => {
    const text = signInBannerText(true)
    expect(text).not.toMatch(/new account/i)
    expect(text).toMatch(/again/)
    expect(text).toMatch(/this same account/)
    // A still-valid sign-in renews by itself: /login only if it asks.
    expect(text).toMatch(/renews by itself/)
    expect(text).toMatch(/if it asks you to sign in, type \/login/i)
  })

  it('plain words: no dashes standing in for punctuation', () => {
    for (const t of [signInBannerText(true), signInBannerText(false)]) expect(t).not.toMatch(/[–—]/)
  })
})

// nubbymong/aicc_planning#444 review P4-1: a duplicate is cleared by signing
// this profile in as its own account, never "this same account" (that keeps
// the duplicate); a wrong-account profile by signing in as its label.
describe('signInBannerText with the reason the card gave', () => {
  it('a duplicate: names the shared account and asks for this profile\'s own, not that one', () => {
    const text = signInBannerText(true, { kind: 'duplicate', account: 'shared@example.test', profileIds: ['p2'] })
    expect(text).toContain('shared@example.test')
    expect(text).toMatch(/the account this profile is for/)
    expect(text).toMatch(/not shared@example\.test/)
    expect(text).not.toMatch(/this same account/)
  })

  it('a wrong account: names both and asks for the labelled one', () => {
    const text = signInBannerText(true, { kind: 'wrong-account', signedInAs: 'other@example.test', labelledAs: 'mine@example.test' })
    expect(text).toMatch(/labelled mine@example\.test/)
    expect(text).toMatch(/signed in as other@example\.test/)
    expect(text).toMatch(/choose mine@example\.test/)
    expect(text).not.toMatch(/this same account/)
  })

  it('no dashes standing in for punctuation in either', () => {
    for (const t of [
      signInBannerText(true, { kind: 'duplicate', account: 'a@example.test', profileIds: ['p2'] }),
      signInBannerText(true, { kind: 'wrong-account', signedInAs: 'a@example.test', labelledAs: 'b@example.test' }),
    ]) expect(t).not.toMatch(/[\u2013\u2014]/)
  })
})
