# Owner decisions, 2026-10-13: WP1 evidence that is unavailable for 2.1.1

**Status: DRAFT, pending the owner's confirmation.** Nothing in this file is
a decision until the owner confirms it at go, section by section. Until then
no item cites a section of it as its `unavailable` decision: every item that
would (WP1.2, WP1.10, WP1.11, WP1.20, WP1.32, WP1.64 and WP1.72) reads
`planned`, and so do WP1.19 (AM2) and WP1.73 (AM1). Sections KL2 and KL3
were added when the 2.1.1 evidence was assembled, from what the qualification
runs did and did not take; they are proposals in the same way. OQ1 and OQ2
were added then too: they are questions for the owner, not decisions (OQ2
states a default the owner can confirm). This line is removed when the owner
confirms the file.

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
say what is still taken. Everything that could be taken is recorded at the
qualified build, as ADR-026 requires. A part not named as unavailable here
is owed in full. Sections AM1, AM2, KL1, KL2 and KL3 change acceptance text or record
known limitations; none of them is an item's `unavailable` decision. OQ1 and
OQ2 are questions still open for the owner's ruling, and decide nothing until
the owner rules; OQ2 states the default it proposes.

## UA1. WP1.2: a real Codex-only session on Linux is unavailable

| What | Decision |
| --- | --- |
| Unavailable | On Linux: a real, signed-in Codex-only session, and with it the Linux column of `docs/wp1/evidence/release-qualification.md` section 4 rows 9, 25 and 33 (WP1.2's rows) in a signed-in session. |
| Why | No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). |
| Still taken | On the Windows test VM: a fresh Codex-only setup with the real CLI at 0.153.4 and 0.155.1, a fake key and a loopback model, and a real signed-in session with a consented identity. On macOS: the session with the owner's sign-in on the macOS test user. |
| Not covered here | The macOS and Linux columns of rows 9, 25 and 33 run with fake keys and the loopback fake model, as on Windows. They need no identity, so this section cannot cover them. They are open for the owner's ruling (OQ1), and WP1.2 stays `planned` until that is settled. |

## UA2. WP1.10: two Codex accounts on macOS and Linux are unavailable

| What | Decision |
| --- | --- |
| Unavailable | The two-account run on macOS and on Linux: two identities, each signed in to its own home, with status and sign-out of one leaving the other unchanged. |
| Why | The second identity is consented for the Windows test VM only. No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). |
| Still taken | The full two-account run on the Windows test VM, with the consented identities. |

## UA3. WP1.11: the native keyring smoke on macOS and Linux is unavailable

| What | Decision |
| --- | --- |
| Unavailable | The native keyring smoke with a second identity on macOS (Keychain) and Linux (Secret Service). |
| Why | The second identity is consented for the Windows test VM only (Q3). |
| Still taken | The pinned-source contract test, and the two-realm smoke on the Windows credential store on the test VM. |

## UA4. WP1.20: a disposable identity and the Linux sign-in are unavailable

| What | Decision |
| --- | --- |
| Unavailable | A disposable identity for the browser sign-in, on every OS, and the browser sign-in on Linux. |
| Why | There is no disposable ChatGPT identity for 2.1.1: the identities are the owner's own, consented as listed above. No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). |
| Still taken | The browser sign-in into the selected managed account on the Windows test VM, with a consented identity, and on macOS with the owner's sign-in on the macOS test user. The record is non-secret and says which kind of identity was used. |

## UA5. WP1.32: the real installer smoke on macOS and Linux is unavailable

| What | Decision |
| --- | --- |
| Unavailable | The opt-in real-CLI installer and sign-in smoke run through the app on macOS and on Linux. |
| Why | Running the vendor installer is not among the consents for those hosts. No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). |
| Still taken | The install and sign-in recipes against fakes (automated); on the Windows test VM, the app's own install, taken through OpenAI's installer route, which reached a version class (the npm route there is OQ2), and the sign-in after it, the owner's, not yet run; and the CI conformance job, which installs the CLI on each OS runner (not through the app). |

## UA6. WP1.64: disposable Codex identities, the API-key flow, and the second-identity flows and codex_review off Windows are unavailable

| What | Decision |
| --- | --- |
| Unavailable | A disposable Codex identity on every OS; the API-key sign-in, status and sign-out; the second-identity flows on macOS and Linux; every credential-bearing flow on Linux; and `codex_review` on a signed-in account with a working model (`docs/wp1/evidence/release-qualification.md` section 4 row 49, WP1.64's row) on macOS and on Linux. |
| Why | The Codex identities are the owner's own, consented as listed above; there is no OpenAI API key; the second identity is consented for the Windows test VM only. No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). On macOS the run is the owner's own Codex sign-in on the macOS test user, set up Codex only; `codex_review` is asked from a signed-in Claude session, and no Claude sign-in on macOS is among the 2.1.1 runs (the disposable Claude account is used on the Windows test VM). |
| Still taken | The real Claude smoke with the disposable Claude account; the real Codex sign-in, status and sign-out with the consented identities on the Windows test VM; one real prompt to a working model; `codex_review` asked from a Claude session on the Windows test VM; the owner's sign-in on the macOS test user. |

## UA7. WP1.72: an ephemeral identity and the macOS and Linux stores are unavailable

| What | Decision |
| --- | --- |
| Unavailable | An ephemeral identity for the native keyring smoke, on every OS, and the smoke on macOS (Keychain) and Linux (Secret Service). |
| Why | No ephemeral or disposable ChatGPT identity exists for 2.1.1, and there is no OpenAI API key. The second identity is consented for the Windows test VM only. |
| Still taken | The fake keyring tests (automated), and the Windows smoke on the test VM with a consented identity, with verified cleanup and a residue check by target name. |

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
taken and were not run; the table says why for each. Row 18 is the
owner's and is still pending: it is listed here so that, if it is not
recorded by go, it is a known limitation, and its line is removed once it
is recorded. No item cites these rows (the no-item part of
`docs/wp1/evidence/real-cli-matrix.md`), so they are release completion,
not parts of an item (ADR-026, settled point 2). Under Q3 everything not run
is recorded as not run and listed at go.

| Check (section 4 row) | Items it relates to | Why not taken |
| --- | --- | --- |
| Hello Codex on the final build (row 13) | none | Not reached in the window. |
| The session-strip meters: a 0.155.1 rollout fixture from a real session, and a run with a working model (row 18) | none | Pending, not yet a limitation: the owner takes it with the prompt to a working model on the Windows test VM (the PENDING block for row 18 in `docs/wp1/evidence/real-cli-matrix.md`). |
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
UA1 (Linux) and UA6 (`codex_review` on macOS and Linux). The macOS and Linux
columns of rows 9, 25 and 33 with fake keys are open for the owner's ruling
(OQ1).

| Check | Items it relates to | Why not taken |
| --- | --- | --- |
| The macOS and Linux columns of `release-qualification.md` section 4 rows 1, 2, 12, 13, 18, 21, 23, 27, 29, 48, 50, 64 and 74, other than the parts KL1 and the real-CLI conformance job (WP1.71, on every OS) cover | WP1.1, WP1.3, WP1.6, WP1.7 and WP1.60 (row 1); WP1.17, WP1.44 and WP1.49 (row 2); WP1.5 and WP1.43 (row 12); WP1.38 and WP1.42 (row 23); no item for the other rows | The 2.1.1 qualification runs on macOS and Linux are a packaged smoke, an upgrade and a rollback (on macOS also the owner's sign-in on the macOS test user). These columns were not among them, and Q3 records everything else as not run. |
| The four WP1.30 cases that need a Windows process that is not elevated (three in `tests/unit/main/owner-only-folders-real.test.ts`, one in `tests/wp1/codex-realm-isolation.test.ts`) | WP1.30 | The CI runner is elevated, so they skip there by design, and the non-elevated VM run that covers them was not in the 2.1.1 qualification window. Every other WP1.30 case ran on each OS where it applies (`docs/wp1/evidence/ci-matrix.md`). |
| The rollback rehearsal of the published qualification release (set it to draft, confirm the in-app update list no longer offers it, publish it again unchanged) | none | The agent's permission policy refused the change to a public release, and it was not attempted another way. Its pre-checks passed. |

## OQ1. Open for the owner's ruling: WP1.2's rows 9, 25 and 33 on macOS and Linux, with fake keys

This is a question, not a decision. It is listed at go with the sections
above.

| What | Open question |
| --- | --- |
| The checks | The macOS and Linux columns of `docs/wp1/evidence/release-qualification.md` section 4 rows 9 (launch and resume in the exact account), 25 (Tokenomics reads the managed realms and `~/.codex`) and 33 (resume in the exact realm), run as on Windows: the real CLI, managed accounts signed in with fake keys, and the loopback fake model (`docs/wp1/evidence/real-cli-matrix.md`). |
| Why it is open | They are parts of WP1.2, which cites `real-cli-matrix.md`, so no known-limitation section can cover them (ADR-026, settled point 2). They need no identity, so they could be taken, and ADR-026's third status never covers a part that could have been taken. They were not among the 2.1.1 qualification runs on macOS and Linux. KL1 lists the Linux columns of rows 9 and 33 for WP1.38 and WP1.42, which do not cite that file; for WP1.2, which does, they belong here. |
| What the owner decides | Either they are taken before go, on the qualification build, and recorded in `real-cli-matrix.md`; or the owner records a ruling on them in this file. Until one of the two, WP1.2 stays `planned`. |

## OQ2. Open for the owner's ruling: WP1.32's Windows part, the app's own Codex install

This is a question, with a default the owner can confirm. It is listed at go
with the sections above. Until the owner rules, it decides nothing.

| What | Open question |
| --- | --- |
| The check | WP1.32's Windows part: the opt-in real smoke through the app, Codex's "Run it for me" on Set up Codex in the qualification build, reaching a version class, then a real sign-in (`docs/wp1/evidence/real-cli-matrix.md`, WP1.32). |
| What was taken | In a standard account with no Codex, on a computer where another user installed Node.js. OpenAI's installer route reached a version class: "Codex 0.162.1 found" and "Newer than the versions this app was tested with; it will still be used". The npm route, in two runs, installed Codex 0.162.1 into the account's npm global folder, but the app read "Codex CLI not found" and "The command ended, but Codex was still not found". The cause is proven: that folder is on neither the user's nor the computer's PATH, and with only that folder added to the account's user PATH, and the app started again, the app found Codex and read the same version class. No real sign-in was made. |
| Why it is open | The plan's fallback for this part is an owner decision. Two things need the owner: whether OpenAI's installer route counts as the Windows install smoke, and whether the npm route in an account whose npm global folder is on no PATH is in scope for 2.1.1 or a known limitation of it. Neither is a part that could not be taken, so neither can be recorded `unavailable`. |
| Default | OpenAI's installer route is WP1.32's Windows install smoke. The npm route in that account shape is a known limitation of 2.1.1 (`docs/wp1/evidence/release-qualification.md` section 3.8, item 12), with its workaround: use OpenAI's installer on the same page, or add npm's global folder to the user's PATH and run it again. Neither severe nor a regression: 2.1.0 has no "Run it for me". |
| Still owed whatever the ruling | The real sign-in after the install on the Windows test VM, the owner's (UA5, "Still taken"). Until it is recorded and this question is ruled, WP1.32 stays `planned`. |
