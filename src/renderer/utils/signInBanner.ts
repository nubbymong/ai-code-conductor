// The guidance above a sign-in tab (TerminalView, a session with needsLogin).
//
// Two tabs carry it: a new account's (useAddAccount) and a re-auth of an
// existing one (useReauthAccount, `signInAgain`). The re-auth tab used to say
// "Setting up a new account", the wrong words for an account that exists
// (nubbymong/aicc_planning#444). Starting claude in that tab renews a sign-in
// that is still valid by itself; only one that has truly expired needs /login,
// and then as the same account. Either way the tab notices once the account's
// credentials change (the re-auth poll).

/** The banner's text: a re-auth tab's (`signInAgain`) or a new account's. */
export function signInBannerText(signInAgain: boolean): string {
  if (signInAgain) {
    return "Signing this account in again. Run claude here: a sign-in that is still valid renews by itself. If it asks you to sign in, type /login and choose this same account. We'll detect it automatically."
  }
  return "Setting up a new account. Run claude, type /login, and choose the account. We'll detect it automatically."
}
