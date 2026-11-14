## 2026-11-14 -- Sentinel analysis account message: what the review round changed

The attack pass on the message fix (same day) raised three minor findings in the change. All three are fixed, each with a test that failed first.

**A usage limit that also says how to sign in is a usage limit.** The sign-in words were checked before the limit words, so "You've hit your limit - resets 4am. Please run /login to switch accounts" was reported as signed out and lost its reset time: the reverse of the owner's bug. The sign-in words are now two lists (`src/main/sentinel/sentinel-analysis.ts`). Words that say outright that the sign-in failed (failed to authenticate, a token expired or revoked, not logged in, 401 Unauthorized, authentication_error) always mean a sign-in failure. Words that only tell the user to sign in (run /login, sign in again, claude auth login) mean one unless the text also speaks of a usage limit; then the limit is what went wrong and the full reason, reset time included, is kept. A 401 status is still always a sign-in failure and a 429 always a usage limit. No real CLI text mixing the two was found; this is a guard.

**"No primary account is set" is said only when none is.** With a primary account set whose folder was missing, another account was picked and the message said "auto-picked, no primary account is set". It now says "auto-picked, the primary account could not be used" when the account list has a primary account and another one ran (`src/main/sentinel/sentinel-account.ts`).

**A cut never leaves a bracket open.** A sign-in failure keeps the CLI's first sentence; one longer than 160 characters was cut at a word, and when that fell inside a bracket the message read "Failed to authenticate (word word (cut short). Sign that account in again...". The cut text now goes back to before the first bracket it left open ("Failed to authenticate (cut short)"); when nothing comes before that bracket, the bracket is closed instead. This holds for every reason that is cut, not only a sign-in one.

**Tests.** New cases in `tests/unit/sentinel-account-message.test.ts`; 11 failed before the change. 21 mutants of the changed lines, one at a time, all killed.
