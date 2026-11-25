## 2026-11-25 -- remote: the helper tab's launch comes from the provider package

2.1.3-beta.18 section 2 (aicc_planning#430). The launch of an SSH tab through
the session helper was built in core: the arguments and the CLI's variables in
`src/main/remote-helper/index.ts` (remoteCliArgs, remoteCliEnv) and the program
with its fallback path in `session.ts` (remoteLaunchSpec). They are now the
Claude package's (`providers/claude/remote-launch.ts`), behind one optional
group on SessionProvider, `remoteLaunch` (providers/types.ts
ProviderRemoteLaunch): `hostReads(options, machine)` names the host files the
package needs read first, and `launch(options, machine, helper, reads)` gives
`{ program, args, env, files, statusKeep, hookKeep }`. Claude's reads, files and
keep-lists are empty; section 3.2 fills them. Core asks the group through the
registry by the tab's provider id (absent: DEFAULT_PROVIDER_ID, a new constant
in shared/providers/ids.ts), keeps ssh, the upload, routing, frames, the `-il`
wrapper, the host account's variables, LANG, TERM and COLORFGBG, and sends the
tab the usual way, with one log line, when the provider has no group, the
group asks for a host read or gives a file (this build does neither yet), or
its variables name one core sets.

Same launch byte for byte: a characterisation test compares d0be048e's code
with the new path over 13,000 rows (options, settings, theme, machines,
folders), argv, folder and environment in order. A scan of
`src/main/remote-helper` for CLI flags, CLI variables and a path to a
provider's CLI reads 10 at d0be048e (index.ts 4 flags and 5 variables,
session.ts 1 path) and 0 now. The machine record's `claudePath`, the probe's
`command -v claude` and route.ts's Claude Code tab rule are left as they were.
