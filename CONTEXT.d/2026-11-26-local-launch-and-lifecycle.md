## 2026-11-26 -- One local launch group and one lifecycle object per provider

2.1.3-beta.19 section 2, aicc_planning#439 (seam audit S1's local half and S2).

**Characterised first.** `tests/unit/main/local-launch-characterisation.test.ts`
records, at cc36c7f3, what a local Codex launch does for a table of saved
options (account kinds, exact resume, the resume list, Ask Conductor, plain and
held, each ConPTY choice, folder forms, extra arguments), what a take-over, the
serving of a kept session and its description do, and what each unbind drops.
Its record is `tests/fixtures/local-launch-characterisation.json`; the two
steps after it change neither file.

**The local launch group (2.1.2).** `SessionProvider.localLaunch` (types.ts).
The Codex package implements it by moving the PTY manager's direct branch body
unchanged into `providers/codex/local-launch.ts`; the PTY manager hands it the
session and its records and doors (`LocalLaunchCore`) and names no provider. A
provider whose package has the group is direct; the rows keep only Claude
Code's shell launch until the local cutover. A stand-in third provider
registered as a package starts its own program
(`tests/unit/main/local-launch-third-provider.test.ts`).

**The lifecycle object (2.1.3).** `SessionProvider.lifecycle`, on both
packages: bind, the account a take-over asks for, take over, serve while not
shown, unbind and describe. The provider-specific binding bodies moved out of
`sessions/launch-bindings.ts` into `providers/claude/lifecycle.ts` and
`providers/codex/lifecycle.ts` unchanged. The take-over and the serving ask the
session's provider; the teardown's first part (`unbindLaunchProvider`, was
`unbindCodexLease`) asks the provider whose launch started the session, and
every registered provider's when that is not known or has none. The two
launch-style tests in the launch bindings are gone.

**Decided while building.** The group's `start` runs the moved body, spawn
included, and answers the terminal and its start time, rather than handing the
PTY manager a program to spawn: the body moves unchanged only that way. The
teardown's telemetry and registration parts stay core's: they clean records
the PTY manager keeps (several are Codex's) and move with them at the local
cutover. Tests that stand the registry in get both packages' parts from
`tests/helpers/provider-package-parts.ts`. Step 2.1.4 (the optional members
folded into named groups) was not started: every group it names is read in a
file the plan gives another section this beta.
