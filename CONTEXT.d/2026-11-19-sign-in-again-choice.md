## 2026-11-19 -- Sign in again asks which account you mean, with nothing chosen for you

Section C2 of the 2.1.3-beta.11 plan (aicc_planning #289, its option A). A
behaviour change on purpose, in the renderer only.

**Before.** Sign in again on a Codex account opened with a box, "Sign in to the
same account as before.", that started unticked. Left that way, the sign-in
was added as a new account and the old one stayed as it was: the obvious path
left two rows for one sign-in. Only a small, muted hint under the box said so.
The owner's own sitting of 2026-10-14 hit it.

**Now.** The box is a question, "Which account are you signing in to?", with
two answers and neither chosen: "The same account as before" and "A different
account (add it as a new account)". The Sign in (or Continue) button stays
disabled until one is chosen, whatever method is picked. The same account
sends the sign-in again with the explicit yes main requires
(`sameAccount: true`); a different account hands the chosen method to Add
account, as the unticked box did. Each answer keeps a short line under it: the
same account keeps the ticked box's line (an account signed in a different
way waits until you confirm it in Accounts), the different account says this
one stays as it is. The toggling hint is gone.

**Not changed.** Main's check (it still refuses a sign in again without the
yes), the IPC contract, and the Add account dialog's own path. No ADR-009
pass is owed while the change stays in the renderer.

**Docs.** docs/USER_GUIDE.md's Sign in again line described the box and now
describes the question. The Feature Guide's sentence (app-knowledge.ts) and
the tip (tips-library.ts) say "after you confirm it is the same account as
before", which still holds; no test pins the old box's wording there, so they
are left to the release PR's sweep with the fix line.

**Tests.** tests/unit/renderer/accounts-surface.test.tsx, Sign in again: four
new tests (nothing chosen leaves the button disabled for each method family
and choosing a method is not an answer; both answers named in full and the
old box and hint gone; the same account sends the yes; a different account
starts a new account, by API key and by ChatGPT). Run against the old dialog
first, all four failed, the first on the stated reason (the button was
enabled). The other Sign in again tests now answer "The same account as
before" where they ticked the box.
