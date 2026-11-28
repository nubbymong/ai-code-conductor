/**
 * The per-account folder rule (ADR-030 S41), one list for this computer and
 * for the machines an account signs in on (2.1.3-beta.20 section 3.1.3): an
 * account's own config folder keeps its sign-in (`.credentials.json`,
 * `.claude.json`) to itself and links these folders to the shared
 * `~/.claude`, so its conversations, memory, agents, skills, commands and
 * plugins are the same on every account. On this computer
 * account-profiles.ts links them from a profile's home; on a machine the
 * Claude package's remote accounts link them from the account's folder in
 * `~/.aicc/accounts/` (providers/claude/remote-launch.ts).
 *
 * Identity files (.credentials.json, .claude.json, statsig, telemetry,
 * caches) are deliberately NOT here: they stay private per account.
 */
export const SHARED_DIR_NAMES = ['projects', 'memory', 'agents', 'skills', 'commands', 'plugins'] as const
