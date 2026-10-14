# Keyring smoke: native credential stores (WP1.11, WP1.72)

This file is the evidence WP1.11 ("Keyring-backed Codex auth stays isolated by CODEX_HOME on the pinned CLI") and
WP1.72 ("Keyring tests inject a fake keyring; native keyring smoke uses an ephemeral identity with verified cleanup and
residue check") cite in `tests/wp1/traceability.json`. Their automated halves are `tests/wp1/codex-pinned-source-contract.test.ts`
and `tests/wp1/fake-keyring.test.ts`, which run in CI at the head below (`ci-matrix.md`). This file records the native
smoke.

Every check here is taken at d1525759a7a42d941beeff601af3415fddd8afdd, the squash merge of PR #644 on beta and the commit
`release/v2.1.1` points at (tree `12310fe71f3706f624e3905f8b92f06f099cdc3f`), on its qualification build `v2.1.1-beta`
(release run 38409628911).

**Status: recorded. The native keyring smoke was not run, on the owner's decisions of 2026-10-14.** The store check
below ran. The owner ruled the native keyring store out of 2.1.1's scope, because 2.1.1 never sets Codex's credential
store (`docs/wp1/owner-decisions-2026-10-13.md#KR1`), and the owner's short path at the Windows sitting left both
Windows runs out (`docs/wp1/owner-decisions-2026-10-13.md#SP1`). WP1.11 and WP1.72 read `unavailable` on the owner's
sections for them (below).

## Which store 2.1.1 uses (agent, 2026-10-13)

Read from the code at the head and probed on the Windows test VM, in its standard test account, with Codex 0.155.1 and
a fake API key in throwaway `CODEX_HOME` folders (no real sign-in):

- **2.1.1 never chooses Codex's credential store.** No source file at the head sets `cli_auth_credentials_store`. A
  managed account's folder is created empty before `codex login` runs in it, and Sign in again carries over only the
  conversation history, not `config.toml`. The store is therefore whatever Codex itself chooses for that folder.
- **Codex 0.155.1's own choice was the file store.** Its default `codex login --with-api-key` wrote `auth.json` in the
  folder, in a throwaway-home probe and in the app's own "Use an API key" sign-in during the packaged smoke
  (`packaged-smoke.md`). Neither run was in a logon that could reach the Windows credential store, so these runs do not
  tell the file store from an automatic fallback to it.
- **Codex's own setting reaches `login`.** `-c cli_auth_credentials_store="bogus"` is refused with the accepted values
  `file`, `keyring`, `auto` and `ephemeral`. With `-c cli_auth_credentials_store="keyring"`, `login` tries the keyring
  and, in the agent's network logon, fails with "failed to load secrets key from keyring". The credential store held no
  entry of ours before or after.

At the owner's sitting on the Windows test VM (2026-10-14, an interactive logon), both of a managed account's sign-in
folders held `auth.json`, the file store, on Codex 0.155.1, after the owner's browser sign-ins through the app
(`real-cli-matrix.md`, the managed re-authentication proof).

So a keyring smoke of 2.1.1 would set the keyring store with Codex's own setting, given outside the app. Commands: `git grep cli_auth_credentials_store d1525759a7a42d941beeff601af3415fddd8afdd -- src/`; on the VM,
`codex.exe -c cli_auth_credentials_store="bogus" login status`, `codex.exe login --with-api-key` (fake key on stdin),
`codex.exe login status` and `codex.exe -c cli_auth_credentials_store="keyring" login --with-api-key`, each with
`CODEX_HOME` set to a throwaway folder, an explicit minimal environment and a dead proxy; `cmdkey /list` before and
after.

## The native smoke on Windows: not run

Both Windows runs were planned and could have been taken. Neither was run, on the owner's decisions of 2026-10-14: the
keyring store is out of 2.1.1's scope (`docs/wp1/owner-decisions-2026-10-13.md#KR1`), and the owner's short path left
both out (`docs/wp1/owner-decisions-2026-10-13.md#SP1`).

- **The two-realm smoke with fake keys.** On the Windows test VM, as its administrator test account in an interactive
  logon (the agent's network logon cannot reach the Windows credential store): two throwaway `CODEX_HOME` folders, each
  signed in with a fake key through Codex's keyring store, and the credential-store target names read by name only
  after each step (two of ours, then one, then none), with cleanup verified. Not run.
- **The target-name reads during the two-identity run.** During the owner's two-account run with the second consented
  identity: the target names of ours read after it signs in, after it signs out and its account is archived, and after
  cleanup. Not run: the second identity's run was not run (`real-cli-matrix.md`, WP1.10).

The identity in these runs would not have been ephemeral: the fake-key realms carry no identity, and the consented
identities are the owner's own.

## What is unavailable (confirmed by the owner on 2026-10-14)

- WP1.11: the native keyring smoke with a second identity on macOS (Keychain) and Linux (Secret Service), and the
  Windows smoke above: `docs/wp1/owner-decisions-2026-10-13.md#UA3`.
- WP1.72: an ephemeral identity on every OS, the smoke on macOS (Keychain) and Linux (Secret Service), and the Windows
  smoke above: `docs/wp1/owner-decisions-2026-10-13.md#UA7`.

Taken for both: their automated halves in CI at the head (`tests/wp1/codex-pinned-source-contract.test.ts`,
`tests/wp1/fake-keyring.test.ts`) and the store check above.
