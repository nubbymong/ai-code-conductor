## 2026-11-13 -- Windows: sessions restored at start find Claude Code without Check again

**What regressed.** Since PR #638 (first shipped in 2.1.1-beta.2) a launch on Windows names Claude Code by its full path or starts nothing; the bare `claude` the session's PowerShell used to resolve is gone on purpose. A tab restored at start was launched before the app's PATH had been brought up to date from the registry (that ran only before a check the user asked for) and before the PowerShell profile had answered, so it said "not found" until Check again.

**The fix.** At start, main walks PATH for Claude Code once, as a launch does (`src/main/claude-start-lookup.ts`).
- **Found** (the users who never had the bug): nothing changes. No launch is held, PATH is not refreshed, and the version probe starts at once, as before the fix.
- **Not found:** main brings its PATH up to date from the registry once (the same `refreshWindowsPath`, same rules), then looks for Claude Code once (the PATH walk, then the PowerShell profile), then runs the version probe. A local Claude launch asked for meanwhile waits for all three, at most `CLAUDE_START_LOOKUP_WAIT_MS` (15 s: a registry read, a profile question of up to 10 s and the version probe fit), as a prepared spawn, then resolves as any launch does: a full path, or the same refusal as before.

A refresh that added folders is counted once more when it ends, so a "not found" kept from a profile question asked while it ran is asked again.

**What else moves on Windows at start, only in the not-found case.**
- Held launches are released once the version probe has answered, not before, so a tab the start releases does not report the version as not yet verified because it was held.
- Every launch asked for while the start still runs waits, each by its own bound, a retry of a refused tab too. The first wait the bound ends is logged once (`[start] Still looking for Claude Code after 15 s`), and so is a walk, a refresh, a lookup or a version probe that fails.
- The accounts service's look for each provider's CLI (what Settings, Accounts and the session dialog show) runs after the refresh and the first lookup, not beside them, so it does not say "missing" until Check again for a CLI the refresh adds, and it asks the PowerShell profile nothing while the registry is read. It does not wait for the version probe, and its wait has the same 15 s bound, so no provider's status stays "not checked yet" for longer; past the bound it looks on the PATH there is, and that is logged.
- While Claude Code is switched off the refresh still runs (it is for every provider); Claude Code is not looked for, by the walk at start or by the lookup.

**Unchanged.** No bare `claude`, no relative path, no new kind of PATH entry accepted. Everything off Windows behaves as before, and so does a Windows start that finds Claude Code on PATH. Check again behaves as before with one difference: when its refresh ends having added folders, a PowerShell profile question asked while that refresh ran is asked once more, since its answer was for the PATH from before.
