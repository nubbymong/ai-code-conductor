// The guidance above a sign-in tab (TerminalView, a session with needsLogin).
//
// Two tabs carry it: a new account's (useAddAccount) and a re-auth of an
// existing one (useReauthAccount, `signInAgain`). The re-auth tab used to say
// "Setting up a new account", the wrong words for an account that exists
// (nubbymong/aicc_planning#444). Starting claude in that tab renews a sign-in
// that is still valid by itself; only one that has truly expired needs /login,
// and then as the same account. Either way the tab notices once the account's
// credentials change (the re-auth poll).
//
// When the Account usage card opened the tab for a duplicate or wrong-account
// profile (`problem`), "the same account" is the wrong advice: a duplicate is
// cleared by signing this profile in as its own account, a wrong-account one
// by signing it in as the account its label names.

import type { UsageSignInProblem } from '../../shared/usage-types'

/** The banner's text: a re-auth tab's (`signInAgain`, with the card's reason
 *  when it gave one) or a new account's. */
export function signInBannerText(signInAgain: boolean, problem?: UsageSignInProblem | null): string {
  if (signInAgain && problem?.kind === 'duplicate') {
    return `This profile is signed in to ${problem.account}, the same account as another profile. Run claude here, type /login, and choose the account this profile is for, not ${problem.account}. We'll detect it automatically.`
  }
  if (signInAgain && problem?.kind === 'wrong-account') {
    return `This profile is labelled ${problem.labelledAs} but is signed in as ${problem.signedInAs}. Run claude here, type /login, and choose ${problem.labelledAs}. We'll detect it automatically.`
  }
  if (signInAgain) {
    return "Signing this account in again. Run claude here: a sign-in that is still valid renews by itself. If it asks you to sign in, type /login and choose this same account. We'll detect it automatically."
  }
  return "Setting up a new account. Run claude, type /login, and choose the account. We'll detect it automatically."
}
