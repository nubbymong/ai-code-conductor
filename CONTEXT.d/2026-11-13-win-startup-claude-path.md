## 2026-11-13 -- Windows: sessions restored at start find Claude Code without Check again

**What regressed.** Since PR #638 (first shipped in 2.1.1-beta.2) a launch on Windows names Claude Code by its full path or starts nothing; the bare `claude` the session's PowerShell used to resolve is gone on purpose. A tab restored at start was launched before the app's PATH had been brought up to date from the registry (that ran only before a check the user asked for) and before the PowerShell profile had answered, so it said "not found" until Check again.

**The fix.** At start, main brings its PATH up to date from the registry once (the same `refreshWindowsPath`, same rules), then looks for Claude Code once, then runs the version probe (`src/main/claude-start-lookup.ts`). A local Claude launch asked for meanwhile waits for both, at most `CLAUDE_START_LOOKUP_WAIT_MS` (5 s), as a prepared spawn, then resolves as any launch does: a full path, or the same refusal as before. A refresh that added folders is counted once more when it ends, so a "not found" kept from a profile question asked while it ran is asked again.

**What else moves on Windows at start.**
- The accounts service's look for each provider's CLI (what Settings, Accounts and the session dialog show) runs after the refresh and the first lookup, not beside them, so it does not say "missing" until Check again for a CLI the refresh adds, and it asks the PowerShell profile nothing while the registry is read.
- The version probe runs after the refresh and the first lookup, not at once, so it runs the Claude Code a launch names. A launch the start releases is under way before the probe has answered, so its report says the version is not yet verified, as for any launch that comes before the probe's answer.
- Once one launch has waited out the bound, later launches do not wait again while the start still runs. That first one is logged (`[start] Claude Code lookup still running after 5 s`), and so is a refresh or a lookup that fails.
- While Claude Code is switched off the refresh still runs (it is for every provider); Claude Code is not looked for.

**Unchanged.** No bare `claude`, no relative path, no new kind of PATH entry accepted. Everything off Windows behaves as before. Check again behaves as before with one difference: when its refresh ends having added folders, a PowerShell profile question asked while that refresh ran is asked once more, since its answer was for the PATH from before.
