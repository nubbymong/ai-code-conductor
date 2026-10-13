# Keyring smoke: native credential stores (WP1.11, WP1.72)

This file is the evidence WP1.11 ("Keyring-backed Codex auth stays isolated by CODEX_HOME on the pinned CLI") and
WP1.72 ("Keyring tests inject a fake keyring; native keyring smoke uses an ephemeral identity with verified cleanup and
residue check") cite in `tests/wp1/traceability.json`. Their automated halves are `tests/wp1/codex-pinned-source-contract.test.ts`
and `tests/wp1/fake-keyring.test.ts`, which run in CI at the head below (`ci-matrix.md`). This file records the native
smoke.

Every check here is taken at d1525759a7a42d941beeff601af3415fddd8afdd, the squash merge of PR #644 on beta and the commit
`release/v2.1.1` points at (tree `12310fe71f3706f624e3905f8b92f06f099cdc3f`), on its qualification build `v2.1.1-beta`
(release run 38409628911).

**Status: not recorded yet.** Only the store check below has run. The native smoke is two PENDING blocks. WP1.11 and
WP1.72 stay `planned` until both are recorded.

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

So a keyring smoke of 2.1.1 sets the keyring store with Codex's own setting, given outside the app, and the record says
so. Commands: `git grep cli_auth_credentials_store d1525759a7a42d941beeff601af3415fddd8afdd -- src/`; on the VM,
`codex.exe -c cli_auth_credentials_store="bogus" login status`, `codex.exe login --with-api-key` (fake key on stdin),
`codex.exe login status` and `codex.exe -c cli_auth_credentials_store="keyring" login --with-api-key`, each with
`CODEX_HOME` set to a throwaway folder, an explicit minimal environment and a dead proxy; `cmdkey /list` before and
after.

## The native smoke on Windows

> **PENDING: the two-realm smoke with fake keys.** On the Windows test VM, as its administrator test account in an
> interactive logon (the agent's network logon cannot reach the Windows credential store): two throwaway `CODEX_HOME`
> folders, each signed in with a fake key through Codex's keyring store. The record reads the credential-store target
> names, by name only, after each step: two of ours with both signed in, one after the first signs out, none after the
> second. Cleanup is verified and the residue check is by target name. Not run yet: it needs the owner to sign in to
> that account on the VM first.

> **PENDING: the two-identity run with the owner's consented identities.** During the owner's two-account run
> (`real-cli-matrix.md`, WP1.10): after the second identity signs in, the target names of ours are read (by name only);
> after it signs out and its account is archived, they are read again, then once more after cleanup, with zero of ours
> left. Each folder's store is recorded as observed (`auth.json` present: file; none, with a credential-store entry:
> keyring), and how the keyring store was set. Not run yet.

The identity in these runs is not ephemeral: the fake-key realms carry no identity, and the consented identities are the
owner's own. That part is expected to be unavailable (below).

## macOS and Linux

Not run. Expected unavailable, pending the owner's confirmation:
- WP1.11: the native keyring smoke with a second identity on macOS (Keychain) and Linux (Secret Service),
  `docs/wp1/owner-decisions-2026-10-13.md#UA3`.
- WP1.72: an ephemeral identity on every OS, and the smoke on macOS (Keychain) and Linux (Secret Service),
  `docs/wp1/owner-decisions-2026-10-13.md#UA7`.
