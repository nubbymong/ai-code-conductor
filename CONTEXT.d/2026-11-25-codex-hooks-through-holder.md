## 2026-11-25 -- hooks: a held Codex session's hook events go through its holder (section 5)

2.1.3-beta.18 section 5 (aicc_planning#433, ADR-030 S12's remaining step), on
section 3.1's helper (the hook mode reads its store and session from
AICC_HELPER_STORE and AICC_HELPER_SESSION; a launch may declare `hookKinds`;
a holder that offers `status` takes them). Windows, behind the agent sessions'
switch (off by default).

The launch. Codex keys the trust it records on the hook command's text, so
the command (codexHookCommand) stays byte for byte as it was. The launch a
holder runs for a held Codex session is given, in its environment, the hook
mode's three variables (session-helper/protocol.ts HOOK_MODE_ENV:
AICC_HELPER_PATH, the helper copy; AICC_HELPER_STORE; AICC_HELPER_SESSION) and
`hookKinds` = the six the Codex package declares (SessionProvider
.heldHookKinds, Codex's CODEX_HOOK_EVENTS), only when its holder offers
`hooks` and `status`, the helper copy is known, the Hooks gateway is taking
events and the launch with the variables passes the holder's limits; anything
else keeps today's launch frame and the gateway, with one log line. The usual
start it falls back to keeps the spawn's own environment. A Codex spawn drops
any of the three it inherited (any spelling on Windows): only the session
helper sets them.

The forwarder (scripts/ccc-codex-hook.js). With the three named, it runs
`<helper> hook` with the event on standard input and posts nothing; only when
the helper path's real path is this user's helper copy as the app lays it out
(`<helper folder>/<version>-<12 hex>/aicc-helper[.exe]`, no link at any level
the app made, one name), the store is that folder's `store` and the session
has the helper's shape (plan review finding 10). Some but not all named, or a
check failing: nothing at all. None named: the hook file and the gateway, as
before.

The app's side. Both packages declare SessionProvider.heldHookKinds (Claude
Code: the nine its settings file injects; Codex: its six), so the member adds
no single-provider optional member (17 of 19, the base's 17). app-wiring.ts
makes both hook rows with one factory over the id, hookDeps(provider, how):
'settings' (Claude Code) switches the settings file; 'launch' (Codex) sets
byLaunch and keptOnGateway, the latter because Codex's take-over writes its
hook file again. Every row's kinds come from its package (manager.ts
HelperHookDeps.kinds); the launch is changed only with byLaunch. A held
session's connections report events of its package's kinds only
(connection.ts `hookKinds`; readEventFrame takes the session's kinds, the
nine by default, so section 3.2's remote tabs read as before). The release writes `hooks: 'holder'`
in the kept record of a session whose hook events went through its holder
(Claude Code's too). A Codex take-over with the mark takes its events through
its holder and writes no hook file; one with no mark (kept by 2.1.3-beta.17 or
earlier, or with its hooks on the gateway) is still kept and has its hook file
written again, as before (launch-bindings.ts codexTakeOver,
serveKeptLaunchUnseen); the plan deletes that branch one beta later.

Tests: tests/unit/main/session-helper-codex-hooks.test.ts (new),
tests/unit/scripts/codex-hook-forwarder-helper.test.ts (new, host-safe; a
stand-in file system for the links), real-link cases added to the quarantined
tests/unit/scripts/codex-hook-forwarder.test.ts (CI only), and additions to the
protocol, app-wiring, take-over, update-keep, launch-bindings take-over and
Codex spawn-hooks tests. VM line: owed to section 5's own lane.
