# Owner decisions, 2026-10-13: WP1 evidence that is unavailable for 2.1.1

**Status: DRAFT, pending the owner's confirmation.** Nothing in this file is
a decision until the owner confirms it at go, section by section. Until then
no item cites a section of it as its `unavailable` decision: every item that
would (WP1.2, WP1.10, WP1.11, WP1.20, WP1.32, WP1.64 and WP1.72) reads
`planned`, and so do WP1.19 (AM2) and WP1.73 (AM1). Sections KL2 and KL3
were added when the 2.1.1 evidence was assembled, from what the qualification
runs did and did not reach; they are proposals in the same way. This line is
removed when the owner confirms the file.

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
known limitations; none of them is an item's `unavailable` decision.

## UA1. WP1.2: a real Codex-only session on Linux is unavailable

| What | Decision |
| --- | --- |
| Unavailable | A real, signed-in Codex-only session on Linux. |
| Why | No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). |
| Still taken | On the Windows test VM: a fresh Codex-only setup with the real CLI at 0.153.4 and 0.155.1, a fake key and a loopback model, and a real signed-in session with a consented identity. On macOS: the session with the owner's sign-in on the macOS test user. |

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
| Still taken | The install and sign-in recipes against fakes (automated), the app's own install and sign-in on the Windows test VM, and the CI conformance job, which installs the CLI on each OS runner (not through the app). |

## UA6. WP1.64: disposable Codex identities, the API-key flow and the second-identity flows off Windows are unavailable

| What | Decision |
| --- | --- |
| Unavailable | A disposable Codex identity on every OS; the API-key sign-in, status and sign-out; the second-identity flows on macOS and Linux; every credential-bearing flow on Linux. |
| Why | The Codex identities are the owner's own, consented as listed above; there is no OpenAI API key; the second identity is consented for the Windows test VM only. No Linux sign-in is taken for the 2.1.1 qualification: no Linux identity is consented (Q3), and Linux sign-in is moved to after stable (Linux is experimental). |
| Still taken | The real Claude smoke with the disposable Claude account; the real Codex sign-in, status and sign-out with the consented identities on the Windows test VM; one real prompt to a working model; the owner's sign-in on the macOS test user. |

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

## KL2. Release-plan checks not reached in the 2.1.1 qualification window, recorded as known limitations

These no-item checks of `docs/wp1/evidence/release-qualification.md`
section 4 were planned on the Windows test VM for 2.1.1 and were not reached.
The VM agent ran the rows in the plan's order, and the window ended before
these. They could have been taken; they were not run. No item cites them
(the no-item part of `docs/wp1/evidence/real-cli-matrix.md`), so they are
release completion, not parts of an item (ADR-026, settled point 2). Under
Q3 everything not run is recorded as not run and listed at go.

| Check (section 4 row) | Items it relates to | Why not taken |
| --- | --- | --- |
| Hello Codex on the final build (row 13) | none | Not reached in the window. |
| The multi-account footer, two managed accounts live, usage headers from the fake model (row 21) | none | Not reached: its usage-header pills needed more harness than the window left. |
| A subagent rollout indexed without a collision (row 27) | none | Not reached in the window. |
| `claude_review` waiting past 300 s (row 50) | none | Not reached in the window. |
| The partner terminal wording on a live tab, and at a narrow window (row 64) | none | Not reached in the window. |
| Command buttons, the preset pill, the restart menu and both themes on the real CLI (row 74) | none | Not reached in the window. |

## KL3. Other checks not taken for 2.1.1, recorded as known limitations

These checks were not taken for 2.1.1, for the reasons given. None is a part
of an item's text as ADR-026 settled point 2 reads it, so none is an item's
`unavailable` decision. Under Q3 they are recorded as not run and listed at
go. The owner may instead have any of them run before go.

| Check | Items it relates to | Why not taken |
| --- | --- | --- |
| The macOS and Linux columns of `release-qualification.md` section 4 rows 1, 2, 9, 12, 13, 18, 21, 23, 25, 27, 29, 33, 48, 49, 50, 64 and 74, other than the parts KL1, the unavailable sections above and the real-CLI conformance job (WP1.71, on every OS) cover | WP1.2, WP1.38, WP1.42 and no-item rows | The 2.1.1 qualification runs on macOS and Linux are a packaged smoke, an upgrade and a rollback (on macOS also the owner's sign-in on the macOS test user). These columns were not among them, and Q3 records everything else as not run. |
| The four WP1.30 cases that need a Windows process that is not elevated (three in `tests/unit/main/owner-only-folders-real.test.ts`, one in `tests/wp1/codex-realm-isolation.test.ts`) | WP1.30 | The CI runner is elevated, so they skip there by design, and the non-elevated VM run that covers them was not in the 2.1.1 qualification window. Every other WP1.30 case ran on each OS where it applies (`docs/wp1/evidence/ci-matrix.md`). |
| The rollback rehearsal of the published qualification release (set it to draft, confirm the in-app update list no longer offers it, publish it again unchanged) | none | The agent's permission policy refused the change to a public release, and it was not attempted another way. Its pre-checks passed. |
