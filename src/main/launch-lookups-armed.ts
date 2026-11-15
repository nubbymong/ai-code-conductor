// Whether main has started, for the lookups a launch makes.
//
// Once main has started (claude-start-lookup.ts startClaudeAtBoot arms it) a
// launch never looks for a program in place on the main process's own thread:
// where no answer is kept it starts the look off the event loop and takes
// "no answer yet" (the launch itself is held for that look first, as a
// prepared spawn: claude-launch-walk.ts, ipc/pty-handlers.ts). Before main
// has started no launch is asked for, and a unit test that drives a launch
// alone holds nothing and has no look to wait for, so it keeps the look in
// place, as before.
//
// A module of its own so the places that read it (providers/claude/spawn.ts,
// spawn-claude-command.ts, claude-cli-probe.ts) do not import the launch
// walk, which imports them.

let armed = false

/** Main has started: from here a launch makes no look in place. */
export function armLaunchLookups(): void {
  armed = true
}

/** Whether main has started (armLaunchLookups). */
export function launchLookupsArmed(): boolean {
  return armed
}

/** Test seam: as before main has started. */
export function _resetLaunchLookupsArmedForTest(): void {
  armed = false
}
