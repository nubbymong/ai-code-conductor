## 2026-11-22 -- A held Claude Code session's PreToolUse goes through the hook mode; the dormant permission hold is deleted

Section C4 of the 2.1.3-beta.14 plan: S16 step 2 (aicc_planning#390) and the
code half of aicc_planning#358. Only with "Claude Code and Codex sessions
through the session helper" on (off by default) for part 1; part 2 applies to
every session.

**What changed.**
- Part 1. `switchHooksToHelper` (session-hooks-writer.ts) now points all nine
  injected events of a held Claude Code session at the helper's hook mode,
  PreToolUse included, so the switched settings file names no gateway URL or
  token. `buildHelperHooksBlock` takes only the hook target. The manager
  passes a PreToolUse event on to the session signals module like any other,
  and its log line says "its hook events go through its holder, PreToolUse
  included". A session not held, or not switched, keeps the gateway entry as
  before.
- Why: Claude Code reads its settings file once (ADR-030 probe P20), so an
  http PreToolUse entry naming one app run's gateway port and token fails at
  every tool call once that run is gone ("PreToolUse:Read hook failed"), and a
  gateway that never answers holds each call 600 s. The hook mode always
  exits 0, prints nothing and ends within 2 s, as the gateway answered `{}` at
  once; it answers no permission.
- Part 2. The gateway's permission hold is gone: `gateActive`,
  `setPermissionGateActive`, the child's `setGate` and `permission-respond`
  messages and its `permission-open` announcement, the responders option and
  registry (src/main/permission-responders.ts), the proxy's
  `resolvePermission`, and the Codex forwarder's marker header with its two
  constants (the hold was its one reader). Every request, PreToolUse and
  PermissionRequest included, is ingested and answered `{}` at once. No
  change a user can see: nothing set the flag, and the one request the hold
  could still catch, a PermissionRequest without the Codex marker, is one no
  settings file the app writes sends (it would have waited 120 s for an answer
  nothing gave).

**Interplay.** A switched file holds no `/hook/` URL any more, so the start-up
sweep's hook strip (boot-cleanup.ts `cleanupStaleHookEntries`) passes over a
stale one; the plan's section C3 has its sweep remove such a file by the hook
mode's shape.

**Docs owed in the aggregate's commit** (plan line 27): ADR-030's parity row
"Permission answers from the app" and the protocol doc's hook-events
paragraph, and the Machines text in src/shared/app-knowledge.ts:167 with its
pinned test (tests/unit/shared/app-knowledge.test.ts:2189-2192); the lines
are in the section's result.
