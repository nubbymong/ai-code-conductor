# Owner decisions, 2026-10-13: WP1 evidence that is unavailable for 2.1.1

**Status: confirmed by the owner on 2026-10-14. OQ1 and SP1's amendment of
WP1.52's 2.1.1 scope were ruled by the owner separately, at about 06:00 BST
the same day (sections OQ1 and SP1).**
At about 02:01 BST on 2026-10-14, after the owner's sitting on the Windows
test VM, the owner was asked in chat "may I record every remaining decision
at its default?", with this list, as the coordinating agent recorded it:

> - the checks skipped tonight are recorded as not run (older Codex version
>   review W8 on 0.153.4, Claude sign-out after restart W11, second-account
>   steps FA.1-FA.5, the keyring rows, the Mac sitting M1-M8);
> - the What's New heading "What's new since 2.1.0" counts as correct
>   (VM.18's heading clause reads "What's new since <from-version>");
> - OpenAI's installer route counts for the Windows "Run it for me" check
>   (OQ2 default);
> - the known limitations are accepted as written (KL1, KL2, KL3);
> - the other wording rulings in the draft decisions file are accepted
>   (AM1, AM2, UA1-UA7, OQ1 = take the fake-key macOS and Linux columns,
>   WP1.2 / row 25 F-L1-2 over-count amendment, WP1.30 non-elevated Windows
>   cases with KL3, WP1.71 rc 0.156.1, keyring: out of 2.1.1's scope
>   because 2.1.1 sets no credential store; UA8 for any host part not run).

The owner answered "Yes". W8, W11 and FA.1 to FA.5 are steps of the owner's
sitting on the Windows test VM, M1 to M8 are the owner's sitting on the
macOS test user, and VM.18 is the release plan's upgrade check. Earlier in
the same sitting the owner had taken a short path through it, and the checks
that path left out are the "checks skipped tonight" (section SP1).

One line of that record is wrong. "OQ1 = take the fake-key macOS and Linux
columns" was the coordinating agent's paraphrase, not part of the question:
the question did not name OQ1, and the draft of this file had listed OQ1 as
an open question with no default. So that answer did not rule OQ1. The
owner ruled it later, at about 06:00 BST on 2026-10-14, in one question
together with SP1's amendment of WP1.52's 2.1.1 scope; section OQ1 quotes
the question and the answer.

So the sections of this file are decisions of the owner, as written below:
UA1 to UA8, AM1 to AM3, KL1 to KL3, KR1, RC1, SP1, WN1, and the rulings on
OQ1 and OQ2. UA1 to UA7, AM1, AM2 and KL1 to KL3 were in the draft the owner
confirmed; AM3, KR1, RC1, SP1, UA8 and WN1 were written afterwards, each
from a line of the list above. Two parts rest on the owner's later ruling,
of about 06:00 BST on 2026-10-14, rather than on that answer: OQ1, with the
lines UA1, UA8, KL3 and SP1 gained for it (each of those lines names OQ1);
and SP1's amendment of WP1.52's 2.1.1 scope, which the first question did
not name. Sections OQ1 and SP1 each quote the later question and answer.
The owner's answer did not cover the stable go (the plan's Q5): nothing is
merged to main or published as stable before the owner says go
(`docs/wp1/evidence/release-qualification.md` section 3.10 records the go).

This record supplements `owner-decisions-2026-09-20.md`,
`owner-decisions-2026-09-26.md` and `owner-decisions-2026-09-27.md`. It
records the owner's decisions of 2026-10-13, made when the owner approved the
2.1.1 stable plan, on which WP1 evidence is not taken for 2.1.1, and the
acceptance text those decisions change. ADR-026
(`architecture/decisions/2026-10-13-adr-026-wp1-evidence-that-cannot-be-taken-is-recorded-unavailable.md`)
is the gate rule these decisions use. The work is tracked privately as #286.

**The decisions.** The owner gave these consents for the 2.1.1 qualification
runs, and no others (the plan's Q3):

- a second ChatGPT identity, consented for the Windows test VM only;
- a disposable Claude account;
- a macOS test user;
- no OpenAI API key;
- everything else is recorded as not run.

Under the plan's rule 10.6, the macOS and Linux second-identity parts, and
any part whose consent was not given, are recorded `unavailable` and listed
at go. No Linux sign-in is taken for the 2.1.1 qualification: no Linux
identity is consented (Q3), and Linux sign-in is moved to after stable
(Linux is experimental).

Sections UA1 to UA7 each name one item, say what is unavailable and why, and
say what is still taken. UA8 names the host parts the owner ruled not run
(the macOS sitting), item by item. Everything else that could be taken is
recorded at the qualified build, as ADR-026 requires. A part not named as
unavailable here is owed in full. Sections AM1 to AM3, KL1 to KL3, KR1, RC1,
SP1 and WN1 change acceptance text, record known limitations or record a
ruling; none of them is an item's `unavailable` decision. OQ1 and OQ2 were
questions, and each records the owner's ruling.

Where a part could have been taken and the owner ruled it not run (SP1,
UA8, and the "Not run" rows added on 2026-10-14 to UA1 to UA4, UA6 and UA7),
the section says so. ADR-026 says the third status never covers a part that could have
been taken but was not run in time, and that the decision record says which:
these parts were not run on the owner's ruling, not for want of a consent,
and the owner confirmed that they are recorded so; for WP1.2's rows 9, 25
and 33 on macOS with fake keys, by the ruling in OQ1.

## UA1. WP1.2: a real Codex-only session on Linux is unavailable

| What | Decision |
| --- | --- |
| Unavailable | On Linux: a real, signed-in Codex-only session, and with it the Linux column of `docs/wp1/evidence/release-qualification.md` section 4 rows 9, 25 and 33 (WP1.2's rows) in a signed-in session. |
| Why | No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). |
| Still taken | On the Windows test VM: a fresh Codex-only setup with the real CLI at 0.153.4 and 0.155.1, a fake key and a loopback model, and a real signed-in session with a consented identity. On macOS: the session with the owner's sign-in on the macOS test user. |
| Not covered here | The macOS and Linux columns of rows 9, 25 and 33 run with fake keys and the loopback fake model, as on Windows. They need no identity, so the reason above does not cover them (OQ1). The Linux columns were taken, on the Linux test host on 2026-10-14 (`docs/wp1/evidence/real-cli-matrix.md`). The macOS columns were not run: see the next row. |
| Not run (2026-10-14) | On macOS, the session with the owner's sign-in on the macOS test user: the macOS sitting was not run, on the owner's ruling (UA8). With it, rows 9, 25 and 33 on macOS with fake keys were not run: a host part not run, under UA8, on the owner's ruling (OQ1). The signed-in session on the Windows test VM was taken at the owner's sitting. |

## UA2. WP1.10: two Codex accounts on macOS and Linux are unavailable

| What | Decision |
| --- | --- |
| Unavailable | The two-account run on macOS and on Linux: two identities, each signed in to its own home, with status and sign-out of one leaving the other unchanged. |
| Why | The second identity is consented for the Windows test VM only. No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). |
| Still taken | The full two-account run on the Windows test VM, with the consented identities. |
| Not run (2026-10-14) | On the Windows test VM, the run with the second consented identity (the sitting's steps FA.1 to FA.5): left out by the owner's short path (SP1), so it is unavailable too. Taken there: two managed Codex accounts, each signed in by the browser sign-in with the same consented identity, both reading signed in and ready. |

## UA3. WP1.11: the native keyring smoke on macOS and Linux is unavailable

| What | Decision |
| --- | --- |
| Unavailable | The native keyring smoke with a second identity on macOS (Keychain) and Linux (Secret Service). |
| Why | The second identity is consented for the Windows test VM only (Q3). |
| Still taken | The pinned-source contract test, and the two-realm smoke on the Windows credential store on the test VM. |
| Not run (2026-10-14) | The two-realm smoke on the Windows credential store, with fake keys, and the target-name reads during the second identity's run: the owner ruled the keyring store out of 2.1.1's scope (KR1), and the short path left both out (SP1), so they are unavailable too. Taken: the pinned-source contract test, and the store check in `docs/wp1/evidence/keyring-smoke.md`. |

## UA4. WP1.20: a disposable identity and the Linux sign-in are unavailable

| What | Decision |
| --- | --- |
| Unavailable | A disposable identity for the browser sign-in, on every OS, and the browser sign-in on Linux. |
| Why | There is no disposable ChatGPT identity for 2.1.1: the identities are the owner's own, consented as listed above. No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). |
| Still taken | The browser sign-in into the selected managed account on the Windows test VM, with a consented identity, and on macOS with the owner's sign-in on the macOS test user. The record is non-secret and says which kind of identity was used. |
| Not run (2026-10-14) | The browser sign-in on macOS: the macOS sitting was not run, on the owner's ruling (UA8). The Windows sign-ins were taken at the owner's sitting. |

## UA5. WP1.32: the real installer smoke on macOS and Linux is unavailable

| What | Decision |
| --- | --- |
| Unavailable | The opt-in real-CLI installer and sign-in smoke run through the app on macOS and on Linux. |
| Why | Running the vendor installer is not among the consents for those hosts. No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). |
| Still taken | The install and sign-in recipes against fakes (automated); on the Windows test VM, the app's own install, taken through OpenAI's installer route, which reached a version class (the npm route there is OQ2), and a real sign-in through the app, the owner's, taken at the owner's sitting on 2026-10-14; and the CI conformance job, which installs the CLI on each OS runner (not through the app). |

## UA6. WP1.64: disposable Codex identities, the API-key flow, and the second-identity flows and codex_review off Windows are unavailable

| What | Decision |
| --- | --- |
| Unavailable | A disposable Codex identity on every OS; the API-key sign-in, status and sign-out; the second-identity flows on macOS and Linux; every credential-bearing flow on Linux; and `codex_review` on a signed-in account with a working model (`docs/wp1/evidence/release-qualification.md` section 4 row 49, WP1.64's row) on macOS and on Linux. |
| Why | The Codex identities are the owner's own, consented as listed above; there is no OpenAI API key; the second identity is consented for the Windows test VM only. No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). On macOS the run is the owner's own Codex sign-in on the macOS test user, set up Codex only; `codex_review` is asked from a signed-in Claude session, and no Claude sign-in on macOS is among the 2.1.1 runs (the disposable Claude account is used on the Windows test VM). |
| Still taken | The real Claude smoke with the disposable Claude account; the real Codex sign-in, status and sign-out with the consented identities on the Windows test VM; one real prompt to a working model; `codex_review` asked from a Claude session on the Windows test VM; the owner's sign-in on the macOS test user. |
| Not run (2026-10-14) | Left out by the owner's short path (SP1), so unavailable too: the disposable Claude account's sign-out and the check that it stays signed out after a relaunch; `codex_review` on Codex 0.153.4; the second consented identity's flows on Windows, with a sign-out through the app; and the owner's sign-in on the macOS test user (UA8). Taken at the owner's sitting on the Windows test VM: the disposable Claude account signed in, in a copy where it was the only Claude account; the Codex sign-ins and their status; one real prompt; `codex_review` on Codex 0.155.1; and a Codex sign-out with Codex's own `codex logout`, of a kept sign-in folder. |

## UA7. WP1.72: an ephemeral identity and the macOS and Linux stores are unavailable

| What | Decision |
| --- | --- |
| Unavailable | An ephemeral identity for the native keyring smoke, on every OS, and the smoke on macOS (Keychain) and Linux (Secret Service). |
| Why | No ephemeral or disposable ChatGPT identity exists for 2.1.1, and there is no OpenAI API key. The second identity is consented for the Windows test VM only. |
| Still taken | The fake keyring tests (automated), and the Windows smoke on the test VM with a consented identity, with verified cleanup and a residue check by target name. |
| Not run (2026-10-14) | The Windows smoke: the owner ruled the keyring store out of 2.1.1's scope (KR1), and the short path left the smoke out (SP1), so it is unavailable too. Taken: the fake keyring tests. |

## UA8. Host parts not run: the macOS sitting

| What | Decision |
| --- | --- |
| Unavailable | The owner's run on the macOS test user (the sitting's steps M1 to M8), and with it these items' macOS parts: WP1.63, the install of the DMG, first launch, Codex found and classed, a session on a managed account's own folder and a clean Quit, then the upgrade from 2.1.0 (and the macOS rollback leg, which is support for WP1.31); WP1.2, the signed-in Codex-only session on macOS, and its rows 9, 25 and 33 on macOS with fake keys (OQ1); WP1.20, the browser sign-in on macOS; WP1.64, the owner's Codex sign-in and sign-out on macOS. |
| Why | The macOS test user was consented and the run could have been taken. The owner ruled it not run: it is among the checks the owner's short path left out (SP1), and the owner confirmed "UA8 for any host part not run" on 2026-10-14. WP1.2's rows 9, 25 and 33 on macOS with fake keys were not in that question: the owner ruled them not run with that sitting later the same day (OQ1). |
| Still taken | On macOS: the DMG's signature, notarization and Gatekeeper checks, and the CI conformance smoke on the macOS runner (WP1.71). The Windows parts of these items in full. On Linux, the packaged run and WP1.2's rows 9, 25 and 33 with fake keys were taken: this section does not cover Linux. |
| How each item uses it | WP1.63 reads `unavailable` on this section; its Linux run is recorded (`docs/wp1/evidence/packaged-smoke.md`). WP1.2, WP1.20 and WP1.64 keep their own sections (UA1, UA4, UA6) as their decision, and each of those names this macOS part as not run. |

## AM1. WP1.73: the release-blocking text, as it reads for 2.1.1

The acceptance item WP1.73 read "All acceptance items block merge; real-CLI
qualification is not deferred". With the consents above, some real-CLI
checks are not taken in 2.1.1, so that text would be false. Following rule
10.6 and Q3, WP1.73 now reads:

> All acceptance items block merge; real-CLI qualification is not deferred,
> except a part an owner decision recorded in this repository says cannot be
> taken, which is recorded unavailable on an item ADR-026 lists, or
> otherwise as a known limitation in release-qualification.md section 3,
> and listed at go.

Where this text and the reviewed WP1 design disagree, this record wins. No
automated requirement changes: every item still blocks the candidate check
until it is recorded (ADR-026, settled point 3).

## AM2. WP1.19: the install outcomes, as ADR-024 decides them

The acceptance item WP1.19 read "Cancel, non-zero exit,
zero-exit-with-no-binary and incompatible-version outcomes are distinct".
Under ADR-024 (owner decision D1, 2026-10-10), an install runs in a visible
terminal tab, and whether the CLI is there is decided by the check after the
command ends, never by its exit code. On the Codex surfaces, a non-zero exit
and a zero exit with no binary are therefore one outcome. For 2.1.1, WP1.19
reads:

> Cancel, a command that ends with no CLI found (whatever its exit code,
> Ctrl+C included), and a CLI of an incompatible version are distinct
> outcomes, decided by the check after the command ends; a zero exit with no
> binary is never success.

Proven by `tests/wp1/install-recipes.test.ts`,
`tests/unit/renderer/onboarding-codex-setup.test.tsx`,
`tests/unit/renderer/providers-card-install-commands.test.tsx` and
`tests/unit/renderer/setup-cli-install.test.tsx` (ADR-026, settled point 6).
Where this text and the reviewed WP1 design disagree, this record wins.

## AM3. WP1.2: row 25's twice-priced turns, accepted for 2.1.1

Row 25 of `docs/wp1/evidence/release-qualification.md` section 4 is one of
WP1.2's rows: Tokenomics reads the managed realms and `~/.codex`, each turn
priced once. Its record (`docs/wp1/evidence/real-cli-matrix.md`, finding
F-L1-2) fails "each turn priced once" in 1 of 6 real rollouts: 3 `token_count`
events there repeat the previous cumulative total exactly, and the index
prices each of them again (0.63% over that rollout's own total). 2.1.0 has
the same rule. A failed part is not a part that could not be taken, so no
`unavailable` section covers it. The owner accepted it as an amendment of
WP1.2's 2.1.1 scope, as U1 in `owner-decisions-2026-09-26.md` amends WP1.5.
For 2.1.1, row 25 reads for WP1.2:

> Tokenomics reads the managed realms and `~/.codex`, and prices each turn
> once, except a `token_count` event that repeats the previous cumulative
> total exactly, which it prices again (known limitation 8 in
> release-qualification.md section 3).

WP1.2 cites this file as evidence when it is recorded. A fix would change a
path outside the binding-neutral ones, so it is not made in 2.1.1.

## KL1. Release-plan checks not taken for 2.1.1, recorded as known limitations

These checks are given by `docs/wp1/evidence/release-qualification.md`
section 4 to automated items, and no file those items cite records them.
They are release completion, not parts of the items (ADR-026, settled point
2). Under Q3 they are recorded as not run and listed at go:

| Check (section 4 row) | Items it relates to | Why not taken |
| --- | --- | --- |
| The API-key sign-in, status and sign-out on every OS (row 4) | WP1.22, WP1.23 | No OpenAI API key (Q3). |
| The ChatGPT sign-in, status and sign-out on Linux (row 4) | WP1.22, WP1.23 | No Linux identity is consented (Q3). |
| Launch, resume and the account picker on Linux (rows 9, 23, 33) | WP1.38, WP1.42 | No Linux identity is consented (Q3). |
| A real install through the app on macOS and Linux (row 3) | WP1.18, WP1.19 | Running the vendor installer is not among the consents for those hosts (Q3). |

## KL2. No-item release-plan checks on Windows not taken in the 2.1.1 qualification window, recorded as known limitations

These no-item checks of `docs/wp1/evidence/release-qualification.md`
section 4 were planned on Windows for 2.1.1. The plan's order for the VM
agent's no-item rows was 1, 23, 21, 48, 64, 74, 12, 13, 27, 50. The agent
ran rows 1, 23, 48 and 12. Rows 13, 21, 27, 50, 64 and 74 could have been
taken and were not run; the table says why for each. Row 18 was the
owner's: it was listed here so that, if it was not recorded by go, it is a
known limitation. It was not taken at the owner's sitting on 2026-10-14, so
it is one. No item cites these rows (the no-item part of
`docs/wp1/evidence/real-cli-matrix.md`), so they are release completion,
not parts of an item (ADR-026, settled point 2). Under Q3 everything not run
is recorded as not run and listed at go.

| Check (section 4 row) | Items it relates to | Why not taken |
| --- | --- | --- |
| Hello Codex on the final build (row 13) | none | Not reached in the window. |
| The session-strip meters: a 0.155.1 rollout fixture from a real session, and a run with a working model (row 18) | none | Not taken at the owner's sitting on 2026-10-14: the prompt to a working model was sent, but the session strip's meters on its tab and the rollout it wrote were not read (`docs/wp1/evidence/real-cli-matrix.md`, row 18). |
| The multi-account footer, two managed accounts live, usage headers from the fake model (row 21) | none | Skipped for a harness gap: its usage-header pills needed more test harness than the time left allowed, so the agent ran row 12 in its place. |
| A subagent rollout indexed without a collision (row 27) | none | Not reached in the window. |
| `claude_review` waiting past 300 s (row 50) | none | Not reached in the window. |
| The partner terminal wording on a live tab, and at a narrow window (row 64) | none | Passed over: the agent ran row 12 in the time left instead. |
| Command buttons, the preset pill, the restart menu and both themes on the real CLI (row 74) | none | Passed over: the agent ran row 12 in the time left instead. |

## KL3. Other checks not taken for 2.1.1, recorded as known limitations

These checks were not taken for 2.1.1, for the reasons given. None is a part
of an item's text as ADR-026 settled point 2 reads it, so none is an item's
`unavailable` decision. Under Q3 they are recorded as not run and listed at
go. The owner may instead have any of them run before go.

The macOS and Linux columns of section 4 rows 9, 25 and 33 (WP1.2's rows)
and row 49 (WP1.64's) are parts of those items, so no known-limitation
section can cover them and they are not here. Their signed-in parts are in
UA1 (Linux) and UA6 (`codex_review` on macOS and Linux). Of rows 9, 25 and
33 with fake keys, the Linux columns were taken and the macOS columns were
not run, on the owner's ruling (OQ1, under UA8).

| Check | Items it relates to | Why not taken |
| --- | --- | --- |
| The macOS and Linux columns of `release-qualification.md` section 4 rows 1, 2, 12, 13, 18, 21, 23, 27, 29, 48, 50, 64 and 74, other than the parts KL1 and the real-CLI conformance job (WP1.71, on every OS) cover | WP1.1, WP1.3, WP1.6, WP1.7 and WP1.60 (row 1); WP1.17, WP1.44 and WP1.49 (row 2); WP1.5 and WP1.43 (row 12); WP1.38 and WP1.42 (row 23); no item for the other rows | The 2.1.1 qualification runs on macOS and Linux are a packaged smoke, an upgrade and a rollback (on macOS also the owner's sign-in on the macOS test user). These columns were not among them, and Q3 records everything else as not run. |
| The four WP1.30 cases that need a Windows process that is not elevated (three in `tests/unit/main/owner-only-folders-real.test.ts`, one in `tests/wp1/codex-realm-isolation.test.ts`) | WP1.30 | The CI runner is elevated, so they skip there by design, and the non-elevated VM run that covers them was not in the 2.1.1 qualification window. Every other WP1.30 case ran on each OS where it applies (`docs/wp1/evidence/ci-matrix.md`). |
| The rollback rehearsal of the published qualification release (set it to draft, confirm the in-app update list no longer offers it, publish it again unchanged) | none | The agent's permission policy refused the change to a public release, and it was not attempted another way. Its pre-checks passed. |

The macOS sitting, among the 2.1.1 qualification runs on macOS in the first
row, was then not run, on the owner's ruling (UA8).

The WP1.30 row was proposed against ADR-026 settled point 2 (no "evidenced
with limits") and settled point 5 (WP1.30 needs no owner decision and no
known limitation for its Windows half). The owner confirmed it on
2026-10-14 with the rest of this file ("WP1.30 non-elevated Windows cases
with KL3"), so WP1.30 reads `evidenced` with these four cases as a known
limitation, and no non-elevated VM run is taken for 2.1.1.

## OQ1. WP1.2's rows 9, 25 and 33 on macOS and Linux, with fake keys: not run on macOS, on the owner's ruling; taken on Linux, by an agent run

This was a question, with no default. The owner's answer of about 02:01 BST
on 2026-10-14 did not rule it: the line "OQ1 = take the fake-key macOS and
Linux columns" in the list quoted at the top of this file was the
coordinating agent's paraphrase, not part of the question. The draft the
owner confirmed said, in UA1 and here, that WP1.2 stays `planned` until OQ1
is settled. The Linux columns were then taken (below). At about 06:00 BST on
2026-10-14 the owner was asked in chat, together with SP1's amendment of
WP1.52's 2.1.1 scope:

> When you skipped the Mac test session, may I also record these as not run?
> - the three macOS checks that use fake keys (rows 9, 25 and 33);
> - 'Sign in again' on the older Codex 0.153.4 and with the keyring store (it
>   was proven once, on Codex 0.155.1).
>
> If you say yes (my default), I record it in your words and carry on.

and then:

> Reply **go**. That also counts as yes to the Mac question: the macOS
> fake-key checks and the extra 'Sign in again' runs get recorded as not run.

The owner answered: "OK both vms are on - go". That is the owner's yes:
WP1.2's rows 9, 25 and 33 on macOS with fake keys are recorded as not run,
with the skipped macOS sitting, under UA8.

| What | Question, and what applies |
| --- | --- |
| The checks | The macOS and Linux columns of `docs/wp1/evidence/release-qualification.md` section 4 rows 9 (launch and resume in the exact account), 25 (Tokenomics reads the managed realms and `~/.codex`) and 33 (resume in the exact realm), run as on Windows: the real CLI, managed accounts signed in with fake keys, and the loopback fake model (`docs/wp1/evidence/real-cli-matrix.md`). |
| Why it was open | They are parts of WP1.2, which cites `real-cli-matrix.md`, so no known-limitation section can cover them (ADR-026, settled point 2). They need no identity, so they could be taken, and ADR-026's third status never covers a part that could have been taken. They were not among the 2.1.1 qualification runs on macOS and Linux. KL1 lists the Linux columns of rows 9 and 33 for WP1.38 and WP1.42, which do not cite that file; for WP1.2, which does, they belong here. |
| What applies on Linux | Taken, by an agent on the Linux test host on 2026-10-14, on the qualification build, with the real CLI, fake keys and the loopback fake model, and recorded in `docs/wp1/evidence/real-cli-matrix.md`: rows 9 and 33 passed, and row 25's index matched its rule on every session, with F-L1-2 reproduced as AM3 accepts it. |
| What applies on macOS | Not run, on the owner's ruling above. The macOS host consented for the 2.1.1 runs is the macOS test user, and the owner's short path left out the sitting on it (SP1). These columns are recorded as a host part not run with that sitting, under UA8, which names them. |
| WP1.2 | Reads `unavailable` on UA1, which names the parts not taken, and cites this file as evidence for AM3. |

## OQ2. Ruled: WP1.32's Windows part, the app's own Codex install

This was a question, with a default. The owner confirmed the default on
2026-10-14 ("OpenAI's installer route counts for the Windows 'Run it for
me' check").

| What | Question and ruling |
| --- | --- |
| The check | WP1.32's Windows part: the opt-in real smoke through the app, Codex's "Run it for me" on Set up Codex in the qualification build, reaching a version class, then a real sign-in (`docs/wp1/evidence/real-cli-matrix.md`, WP1.32). |
| What was taken | In a standard account with no Codex, on a computer where another user installed Node.js. OpenAI's installer route reached a version class: "Codex 0.162.1 found" and "Newer than the versions this app was tested with; it will still be used". The npm route, in two runs, installed Codex 0.162.1 into the account's npm global folder, but the app read "Codex CLI not found" and "The command ended, but Codex was still not found". The cause is proven: that folder is on neither the user's nor the computer's PATH, and with only that folder added to the account's user PATH, and the app started again, the app found Codex and read the same version class. No real sign-in was made. |
| Why it was open | The plan's fallback for this part is an owner decision. Two things need the owner: whether OpenAI's installer route counts as the Windows install smoke, and whether the npm route in an account whose npm global folder is on no PATH is in scope for 2.1.1 or a known limitation of it. Neither is a part that could not be taken, so neither can be recorded `unavailable`. |
| Ruling (the default, confirmed) | OpenAI's installer route is WP1.32's Windows install smoke. The npm route in that account shape is a known limitation of 2.1.1 (`docs/wp1/evidence/release-qualification.md` section 3.8, item 12), with its workaround: use OpenAI's installer on the same page, or add npm's global folder to the user's PATH and run it again. Neither severe nor a regression: 2.1.0 has no "Run it for me". |
| The sign-in | Owed whatever the ruling (UA5, "Still taken"), and taken: the owner's real sign-in through the app (Sign in with ChatGPT) at the owner's sitting on the Windows test VM on 2026-10-14, in a copy of the qualification build with Codex 0.155.1 (`docs/wp1/evidence/real-cli-matrix.md`). |

## KR1. The native keyring store is out of 2.1.1's scope

2.1.1 never sets Codex's credential store: no source file at the qualified
build sets `cli_auth_credentials_store` (`docs/wp1/evidence/keyring-smoke.md`).
A managed account's sign-in folder uses whatever store Codex itself chooses,
and Codex 0.155.1 chose the file store (`auth.json`) at every run recorded
for 2.1.1, the owner's sitting included. A keyring run would set that store
with Codex's own setting, outside the app. The owner ruled the keyring store
out of 2.1.1's scope on 2026-10-14 ("keyring: out of 2.1.1's scope because
2.1.1 sets no credential store"). So:

- the native keyring smoke on Windows is not taken: WP1.11 and WP1.72 read
  `unavailable` on UA3 and UA7, which name it as not run;
- WP1.52's managed re-authentication proof is owed for the file store only
  (SP1).

## RC1. WP1.71: the release-candidate CLI is 0.156.1

The release-candidate legs of WP1.71's conformance smoke ran on Codex 0.156.1,
the newest version tested against the app (the tested ceiling), not a newer
published Codex (`docs/wp1/evidence/real-cli-matrix.md`). The owner
confirmed that choice on 2026-10-14 ("WP1.71 rc 0.156.1").

## SP1. The owner's short path at the Windows sitting, 2026-10-14: checks not run

At the sitting on the Windows test VM the owner took a short path through
the planned steps, and on 2026-10-14 confirmed that the checks it left out
are recorded as not run. Each could have been taken; none was run, on the
owner's ruling.

| Check not run | Items it bears on | Where it is recorded |
| --- | --- | --- |
| Sign in again on account B a second and a third time (the plan's runs on Codex 0.153.4 and with the keyring store), each followed by the old folder's sign-out | WP1.52 | `docs/wp1/evidence/real-cli-matrix.md`, which records the one run taken (Codex 0.155.1, the file store); the keyring store is out of scope (KR1) |
| The second consented identity (the sitting's FA.1 to FA.5): Sign in again with it, the credential-store target names read, a quit and relaunch with B's conversation, a running session switched from A to B, then B signed out and archived while A reads signed in | WP1.10, WP1.11, WP1.52, WP1.64, WP1.72 | UA2, UA3, UA6, UA7 |
| `codex_review` asked from a Claude session on Codex 0.153.4 (the sitting's W8, second run) | WP1.64 | UA6 |
| The disposable Claude account signed out, then still signed out after a relaunch (W11) | WP1.64 | UA6 |
| The native keyring smoke with fake keys in an interactive logon | WP1.11, WP1.72 | UA3, UA7, KR1 |
| The sitting on the macOS test user (M1 to M8), and with it, on the owner's ruling in OQ1, WP1.2's rows 9, 25 and 33 on macOS with fake keys | WP1.2, WP1.20, WP1.63, WP1.64, and the macOS rollback leg (support for WP1.31) | UA8 |

WP1.52 is an automated item, so it may never read `unavailable`. Its reason
owed a VM proof on Codex 0.153.4 and 0.155.1 with the file and keyring
stores. The question of about 02:01 BST asked whether the checks skipped are
"recorded as not run". It named the keyring rows, but neither WP1.52, nor
Sign in again's run on Codex 0.153.4, nor any amendment. So the amendment
was put to the owner on its own, with OQ1, at about 06:00 BST on 2026-10-14:

> When you skipped the Mac test session, may I also record these as not run?
> - the three macOS checks that use fake keys (rows 9, 25 and 33);
> - 'Sign in again' on the older Codex 0.153.4 and with the keyring store (it
>   was proven once, on Codex 0.155.1).
>
> If you say yes (my default), I record it in your words and carry on.

and then:

> Reply **go**. That also counts as yes to the Mac question: the macOS
> fake-key checks and the extra 'Sign in again' runs get recorded as not run.

The owner answered: "OK both vms are on - go". With that ruling and KR1,
WP1.52's VM proof for 2.1.1 is the run taken: Sign in again once, on Codex
0.155.1 with the file store, the old folder then signed out with
`codex logout`, and the replacement still signed in
(`docs/wp1/evidence/real-cli-matrix.md`). Its runs on Codex 0.153.4 and with
the keyring store are recorded as not run. This amends WP1.52's 2.1.1 scope,
as U1 in `owner-decisions-2026-09-26.md` amends WP1.5, and WP1.52 cites this
file as evidence.

## WN1. The What's New heading after an upgrade

The release plan's upgrade check (VM.18) read "the heading names the running
release". The qualification build's heading after an upgrade names the
release the user comes from: "What's new since 2.1.0"
(`docs/wp1/evidence/packaged-smoke.md`, "Upgrade from 2.1.0"). The owner
ruled on 2026-10-14 that this heading is correct: for 2.1.1 the check's
heading clause reads "What's new since <from-version>". No wording change is
made, so the binding head does not move.
