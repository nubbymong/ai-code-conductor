// src/main/first-run-accounts.ts
// Startup orchestration: migrate existing profiles to the canonical layout, then
// guarantee a captured, isolated "primary" account exists so no session ever runs
// on the bare global ~/.claude login (which a /login could otherwise clobber).
import {
  readProfilesStrict, captureGlobalLogin, migrateProfilesToCanonicalLayout,
  setPrimaryProfile, readCanonicalIdentityEmail, healPlaceholderNames,
} from './account-profiles'
import { getDefaultAccountEmail } from './claude-account-identity'
import { canonicaliseEmail } from '../shared/account-chip-color'
import { logWarn } from './debug-logger'

/** Pure decision for tests: capture only when there is no primary yet AND a
 *  global login exists to capture. */
export function decideFirstRunCapture(s: { hasPrimary: boolean; hasGlobalLogin: boolean }): 'capture' | 'none' {
  if (s.hasPrimary) return 'none'
  return s.hasGlobalLogin ? 'capture' : 'none'
}

/** Run once at startup (after config + setup are ready). Idempotent. */
export function runFirstRunCapture(): void {
  // aicc_planning B1: an accounts list that did not read is not "no accounts".
  // Read as an empty list it looked like a first run, so the global login was
  // captured a second time and that copy marked primary. The list is read
  // strictly, once, and that one read answers both questions below (is there
  // a primary, is this login already an account); when it did not read, this
  // start does nothing and the next one tries again.
  const profiles = readProfilesStrict()
  if (profiles === null) {
    logWarn('[profiles] first-run capture skipped: the saved accounts list (profiles.json) could not be read, so no account was captured or marked primary')
    return
  }
  migrateProfilesToCanonicalLayout()
  healPlaceholderNames()
  if (profiles.find((p) => p?.isPrimary)?.id) return
  const globalEmail = getDefaultAccountEmail()
  if (!globalEmail) return // fresh, not yet logged in: capture happens after /login (later task)
  // If a profile already IS this account, just promote it to primary (no duplicate).
  // Fall back to the canonical identity email in case metadata email is blank (e.g. after migration).
  const existing = profiles.find((p) => {
    if (!p) return false
    const email = p.accountEmail || readCanonicalIdentityEmail(p.id)
    return email != null && email !== '' && canonicaliseEmail(email) === canonicaliseEmail(globalEmail)
  })
  if (existing) { setPrimaryProfile(existing.id); return }
  const captured = captureGlobalLogin()
  if (captured) setPrimaryProfile(captured.id)
}
