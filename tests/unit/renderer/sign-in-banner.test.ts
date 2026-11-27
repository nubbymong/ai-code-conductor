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
