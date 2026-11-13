## 2026-11-13 -- Windows: sessions restored at start find Claude Code without Check again

**What regressed.** Since PR #638 (first shipped in 2.1.1-beta.2) a launch on Windows names Claude Code by its full path or starts nothing; the bare `claude` the session's PowerShell used to resolve is gone on purpose. A tab restored at start was launched before the app's PATH had been brought up to date from the registry (that ran only before a check the user asked for) and before the PowerShell profile had answered, so it said "not found" until Check again.

**The fix.** At start, main brings its PATH up to date from the registry once (the same `refreshWindowsPath`, same rules), then looks for Claude Code once, then runs the version probe (`src/main/claude-start-lookup.ts`). A local Claude launch asked for meanwhile waits for both, at most `CLAUDE_START_LOOKUP_WAIT_MS` (5 s), as a prepared spawn, then resolves as any launch does: a full path, or the same refusal as before. A refresh that added folders is counted once more when it ends, so a "not found" kept from a profile question asked while it ran is asked again.

**Unchanged.** No bare `claude`, no relative path, no new kind of PATH entry accepted. Check again, and everything off Windows, behave as before.
