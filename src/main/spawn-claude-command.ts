/**
 * spawn-claude-command.ts — pure builder for the Claude launch command string.
 *
 * Extracted verbatim from pty-manager.ts's Claude branch (the shell command
 * written into the PTY after spawn) so it can be unit-tested WITHOUT node-pty /
 * Electron. No default export (project convention). No side effects except
 * the Windows node lookup (pickerNodeOnWindows, warmPickerNodeOnWindows: a
 * look in PATH's folders and the answer it keeps) and one log line when the
 * resume list is skipped.
 *
 * Behaviour contract:
 *   - When `resumeUuid` is ABSENT the produced string matches the pre-refactor
 *     inline construction (picker / picker-fallback / direct) EXCEPT for the
 *     binary and picker paths, which are now single-quoted rather than
 *     double-quoted. That is a deliberate security change, not drift: inside
 *     double quotes PowerShell expands `$(...)` and POSIX expands `$(...)` and
 *     backticks, and these values are PATHS whose contents a directory name
 *     decides. On Windows the user's extra CLI arguments are single-quoted
 *     word by word too (claudeUserArgsOnLine), so PowerShell reads nothing
 *     in them. Byte-identity holds for every other part of the line.
 *   - When `resumeUuid` is PRESENT the resume-picker branch is BYPASSED and the
 *     command launches Claude directly with `--resume <uuid>` FIRST, before
 *     --settings / --mcp-config / --agents etc. (mirrors the ordering in
 *     scripts/resume-picker.js:299 — the resume verb must come first).
 *
 * The cwd-override decision (whether a resume target exists + all the fail-open
 * existence checks) lives in the CALLER (pty-manager). This function only knows
 * "given a uuid (or not), produce the command".
 *
 * One answer comes from this machine rather than the caller: whether Windows
 * finds node, which runs the resume list, at a path the line can start it by
 * (pickerNodeFor, which reads pickerNodeOnWindows; pickerNodeFound gives the
 * same answer as a yes or no). Without it a fresh session starts Claude Code
 * directly, and the log says why. On macOS
 * and Linux the session's own shell is asked instead, on the line itself, and
 * the session says why (RESUME_LIST_SKIPPED_NOTICE).
 */

import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import { UUID_RE, claudeProjectDirName, type ClaudeLaunchFolderOptions } from './logging/transcript-discovery'
import { CMD_EXE_LINE_LIMIT, PS_LEGACY_ARGUMENT_PASSING, agentsRef, askPromptRef, startsAsExe, windowsCommandLineLimit } from './terminal-launch-line'
import { escapeForCwdQuote, quoteArgForShell } from '../shared/shell-quote'
import { findOnWindowsPath, findOnWindowsPathAsync, windowsEnvValue } from './windows-programs'
import { logInfo } from './debug-logger'

export interface BuildClaudeLaunchCommandOptions {
  /** 'win32' produces a PowerShell command; anything else produces a POSIX sh command. */
  platform: 'win32' | 'posix' | string
  /** The (already account/worktree-resolved) directory to cd into before launch. */
  cwd: string
  /** Resolved claude binary path/command (resolveClaudeForPty().cmd). */
  claudeBin: string
  /** Pre-built extra flag string (e.g. ` --effort high --settings '...' --mcp-config '...'`). */
  extraFlags: string
  /** Pre-built --agents flag string (empty when no agents, and always empty
   *  when `agentsFromEnv` is set). */
  agentsFlag: string
  /**
   * Windows: the agent templates ride the session's environment (AGENTS_ENV,
   * set to agentsEnvValue for claudeLaunchProgram's program before the spawn)
   * and the line carries only `--agents ${env:CCC_AGENTS}`, in the place
   * `agentsFlag` takes, after PS_LEGACY_ARGUMENT_PASSING at its start. A
   * boolean, as `askPrompt` is: the templates never reach this builder as
   * text. Elsewhere it is ignored and `agentsFlag` carries them.
   */
  agentsFromEnv?: boolean
  /**
   * Windows, with `agentsFromEnv`: the length of AGENTS_ENV's value. The line
   * is refused, with the reason, when the command line its program would be
   * handed is longer than Windows lets that program have
   * (windowsCommandLineLimit): such a launch would start nothing.
   */
  agentsValueLength?: number
  /**
   * The user's own extra CLI arguments for this session, as the session's
   * rule passed them (claudeExtraArgsProblem, src/shared/extra-args.ts).
   * Placed after every option of the app's own (claudeUserArgsOnLine).
   * Absent or blank: none.
   */
  userArgs?: string
  /** Whether the resume-picker branch would normally run (restored sessions). */
  useResumePicker: boolean
  /** Resolved resume-picker.js path, or null when not deployed. */
  pickerScript: string | null
  /**
   * When set, BYPASS the picker and launch `claude --resume <uuid>` directly.
   * The caller has already validated the uuid + transcript/companion/cwd
   * existence; this builder trusts it. Absent => golden no-resume behaviour.
   */
  resumeUuid?: string
  /**
   * Ask Conductor: append Claude's opening prompt as a POSITIONAL argument,
   * passed by REFERENCE to the CCC_ASK_PROMPT env var (see askPromptRef). This
   * is a boolean, not the text: the question must never reach this builder as a
   * string, because anything that arrives here is interpolated into a line the
   * shell parses. Keeping the value out of the type makes that impossible to get
   * wrong rather than merely documented.
   *
   * Positional, so it goes AFTER every flag — `claude [options] [prompt]`.
   * Ignored on the resume path, which has a conversation to continue and no use
   * for an opening prompt.
   */
  askPrompt?: boolean
  /**
   * The session this line is for, named in the log line a skipped resume
   * list writes (CLAUDE_RESUME_LIST_SKIPPED_NO_NODE) when it is a plain id
   * (SESSION_ID_IN_LOG_RE). Nothing else reads it. Absent: the log line
   * names no session.
   */
  sessionId?: string
}

/** A session id the log may name as it is: letters, digits, `-` and `_`. */
const SESSION_ID_IN_LOG_RE = /^[A-Za-z0-9_-]{1,128}$/

// Moved to src/shared/shell-quote.ts (shared with provider core); re-exported
// here so every existing import of quoteArgForShell keeps working.
export { quoteArgForShell }

/**
 * Build the whole `--model <value>` flag, quoted, or '' when there is no model.
 *
 * Exists so the CALL SITES have nothing to get wrong. The #144 bug was not a
 * broken quoting helper -- there wasn't one -- it was two emission sites that
 * interpolated the raw value. A helper that returns only the escaped value
 * still lets a site write `--model ${options.model}` and typecheck cleanly,
 * which is exactly how the first regression guard for this bug turned out to be
 * vacuous (reverting both sites left the suite green). Returning the entire
 * flag removes that degree of freedom, and `checkedModelFlag` in
 * tests/unit/spawn-model-flag-quoting.test.ts asserts no site bypasses it.
 */
export function modelFlag(model: string | undefined | null, isWin32: boolean): string {
  if (!model) return ''
  return `--model ${quoteArgForShell(model, isWin32)}`
}

// ---------------------------------------------------------------------------
// resolveResumeLaunch — pure resume-launch decision (T8b, bug #5 review)
// ---------------------------------------------------------------------------

/** A captured resume target: the conversation uuid + the cwd it ran in. */
export interface ResumeTarget {
  uuid: string
  cwd: string
}

/**
 * Injectable deps for {@link resolveResumeLaunch}. Production passes thin
 * wrappers over node fs/os; tests pass in-memory fakes. Keeping this pure makes
 * the CRITICAL deleted-worktree gate fully unit-testable WITHOUT touching disk.
 */
export interface ResolveResumeLaunchDeps {
  existsSync: (p: string) => boolean
  /** Must throw (or be guarded by the caller) when the path does not exist. */
  statSync: (p: string) => { isDirectory: () => boolean }
  homedir: () => string
  mangleCwdToProjectDir: (cwd: string) => string
  /** Canonical `~/.claude/projects` root (homedir-based; per-account homes are junctions to it). */
  projectsRoot: string
  /**
   * Best-effort: ensure the `<projectDir>/<uuid>/` companion dir exists so the
   * CLI can resume a DIRECT-WORK conversation that never spawned a
   * subagent/workflow (and therefore has no companion dir of its own). Called
   * AFTER the transcript gate passes; its failure must NOT drop the resume (the
   * transcript is real — we still launch `--resume`). Side-effecting; injected so
   * the decision logic stays unit-testable. Production wraps companion-dir.ts.
   */
  ensureCompanionDir: (projectDir: string, uuid: string) => void
}

/**
 * A resume target's cwd as the launch would use it: a leading `~` expanded
 * against `home` (the OS does not expand it on Windows), anything else made
 * absolute. NOT `resolveCwd()`, which collapses a missing path to the home
 * directory -- the exact retargeting the resume gate exists to prevent.
 *
 * One function, three callers: `resolveResumeLaunch`, `recoverOrphanResumeLaunch`
 * and the project-settings gate in pty-manager, which must gate the directory
 * an exact resume will actually run in and so has to spell it the same way.
 */
/**
 * The worktree paths in `git worktree list --porcelain` output, in order.
 * Mirrors the parser in scripts/resume-picker.js, which builds the picker's
 * candidate list from the same command: the directories the picker may
 * relaunch the CLI in are exactly these, and the project-settings gate must
 * gate every one of them before a managed picker launch (adversarial final
 * pass, MAJOR). Tolerant of CRLF and of a missing trailing blank line.
 */
export function parseWorktreePaths(porcelainText: string): string[] {
  const out: string[] = []
  for (const rawLine of String(porcelainText ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('worktree ')) {
      const p = line.slice('worktree '.length).trim()
      if (p) out.push(p)
    }
  }
  return out
}

export function expandResumeTargetCwd(cwd: string, home: string): string {
  if (cwd === '~') return home
  if (cwd.startsWith('~/') || cwd.startsWith('~\\')) return nodePath.join(home, cwd.slice(2))
  return nodePath.resolve(cwd)
}

/**
 * Decide whether to launch `claude --resume <uuid>` with an overridden cwd.
 *
 * Encapsulates the path/cwd existence gate (extracted from the old inline block
 * in pty-manager.spawnPty). The provider / discoveryOn gating stays in the
 * caller — this function is concerned ONLY with paths.
 *
 * CRITICAL (Fix 1 — deleted-worktree regression guard): the gate stats the
 * RAW captured cwd directly (after `~` expansion). It NEVER routes through a
 * homedir-fallback resolver, so when the worktree the conversation ran in has
 * been deleted, the stat misses → this returns null → the caller falls back to
 * the picker / direct launch. We never launch `--resume` from os.homedir()
 * unless the captured cwd genuinely IS the homedir.
 *
 * Returns `{ resumeUuid, claudeCwd }` only when ALL hold:
 *   - target present + has a uuid + a cwd;
 *   - the raw cwd (with `~` expanded) exists AND is a directory;
 *   - the transcript file `projectsRoot/<mangle(cwd)>/<uuid>.jsonl` exists.
 * Returns null on ANY miss or error (fail-open).
 *
 * The companion dir `projectsRoot/<mangle(cwd)>/<uuid>` is NO LONGER a
 * precondition: a direct-work conversation never got one from the CLI but is
 * still resumable, so we ENSURE it (best-effort, via deps.ensureCompanionDir)
 * after the transcript gate rather than gating on it.
 *
 * `claudeCwd` is the resolved (absolute, `~`-expanded) launch directory.
 */
export function resolveResumeLaunch(
  target: ResumeTarget | undefined,
  deps: ResolveResumeLaunchDeps,
): { resumeUuid: string; claudeCwd: string } | null {
  try {
    if (!target || !target.uuid || !target.cwd) return null

    // Defense-in-depth (FIX 4): re-validate the uuid against the canonical UUID
    // format BEFORE it is interpolated UNQUOTED into the spawn shell command. The
    // caller is expected to have validated already; this preserves the builder's
    // "caller validated" invariant and the fail-open rule even if it didn't.
    if (!UUID_RE.test(target.uuid)) return null

    // Expand a leading `~` ourselves (the OS does not on Windows). We do NOT
    // use resolveCwd(): it silently collapses a missing path to homedir, which
    // is exactly the bug this gate prevents.
    const expanded = expandResumeTargetCwd(target.cwd, deps.homedir())

    // Stat the RAW (expanded) cwd directly — the regression guard. A deleted
    // worktree misses here and we fall back; we never silently retarget homedir.
    if (!deps.existsSync(expanded)) return null
    if (!deps.statSync(expanded).isDirectory()) return null

    const projDir = nodePath.join(deps.projectsRoot, deps.mangleCwdToProjectDir(target.cwd))
    const transcriptPath = nodePath.join(projDir, `${target.uuid}.jsonl`)
    // The transcript MUST exist — without it there is no conversation to resume.
    if (!deps.existsSync(transcriptPath)) return null

    // The companion dir is NO LONGER a precondition. A conversation worked on
    // directly (no subagent/workflow) never got one from the CLI, yet it is a
    // real, resumable conversation. Ensure it exists (best-effort) so
    // `claude --resume` can find it. A failure here must NOT drop the resume —
    // the transcript is real; we still launch and let the CLI/fresh-fallback cope.
    try { deps.ensureCompanionDir(projDir, target.uuid) } catch { /* best-effort */ }

    return { resumeUuid: target.uuid, claudeCwd: expanded }
  } catch {
    // Fail-open: any unexpected error drops resume and falls back.
    return null
  }
}

// ---------------------------------------------------------------------------
// recoverOrphanResumeLaunch — resume a conversation whose worktree cwd is gone (#535)
// ---------------------------------------------------------------------------

/**
 * Injectable deps for {@link recoverOrphanResumeLaunch}. Production wraps node
 * fs/os + path-utils; tests pass in-memory fakes so the relocation logic is
 * unit-testable WITHOUT touching disk.
 */
export interface RecoverOrphanDeps {
  existsSync: (p: string) => boolean
  statSync: (p: string) => { isDirectory: () => boolean }
  /** Recursively create a directory (mkdir -p). */
  mkdirp: (dir: string) => void
  /** Move a file (rename); may throw on cross-device, caller falls back to copy. */
  renameFile: (src: string, dst: string) => void
  /** Copy a file (cross-device fallback for renameFile). */
  copyFile: (src: string, dst: string) => void
  /** Best-effort unlink; must not throw fatally. */
  removeFile: (p: string) => void
  /** Current process id — makes the copy-fallback temp name unique. */
  pid: () => number
  /** Non-fatal diagnostic (e.g. a source that could not be removed post-copy). */
  warn: (msg: string) => void
  homedir: () => string
  mangleCwdToProjectDir: (cwd: string) => string
  /** Canonical `~/.claude/projects` root. */
  projectsRoot: string
  /** True when `cwd` IS or is an ANCESTOR of the user's home dir — never relocate there. */
  isHomeOrAncestor: (cwd: string) => boolean
  ensureCompanionDir: (projectDir: string, uuid: string) => void
}

/**
 * Recover a resume whose ORIGINAL cwd (a git worktree) has been deleted (#535).
 *
 * {@link resolveResumeLaunch} deliberately returns null when the captured cwd
 * is gone — it never retargets homedir. But a session that ran in a worktree
 * created by session-guard / the loop system (ADR-012 / #522) has its transcript
 * written under the worktree's mangled project folder, which SURVIVES the
 * worktree deletion (the `~/.claude/projects/<mangle>/…` tree is a separate
 * location from the git worktree on disk). The conversation is therefore intact
 * but unreachable: `claude --resume <uuid>` looks in `<mangle(launchCwd)>/`, and
 * no surviving cwd mangles to the dead worktree's folder.
 *
 * This recovers it by RELOCATING the orphaned `<uuid>.jsonl` into the surviving
 * cwd's (the session's configured repo root) mangled folder, then resuming there.
 *
 * Applies ONLY to the genuine orphan case, and fails CLOSED to null (→ caller's
 * fresh fallback) on anything else. ALL must hold:
 *   - target present, uuid matches the canonical UUID format;
 *   - the target's RAW cwd is MISSING (this is what makes it an orphan — if it
 *     exists, resolveResumeLaunch's null was for another reason; do not relocate);
 *   - `survivingCwd` exists, is a directory, and is NOT home or an ancestor of it
 *     (never relocate a transcript into ~/.claude/projects/<mangle(home)>);
 *   - the orphan transcript `projectsRoot/<mangle(targetCwd)>/<uuid>.jsonl` exists
 *     and resolves INSIDE projectsRoot (containment — defense in depth);
 *   - the destination path also resolves INSIDE projectsRoot.
 *
 * Collision rule (adversarial review #535): if a transcript ALREADY exists at
 * the destination, that IS the conversation for this uuid in this project —
 * resume it IN PLACE and NEVER overwrite it. The orphan source path is derived
 * from `target.cwd` (transcript content, not a trusted value), so a size-compare
 * "keep-larger" overwrite would let a planted duplicate clobber a live, possibly
 * different conversation. Relocation only ever writes into an EMPTY dest slot.
 *
 * Returns `{ resumeUuid, claudeCwd }` (claudeCwd = the surviving cwd) or null.
 */
export function recoverOrphanResumeLaunch(
  target: ResumeTarget | undefined,
  survivingCwd: string,
  deps: RecoverOrphanDeps,
): { resumeUuid: string; claudeCwd: string } | null {
  try {
    if (!target || !target.uuid || !target.cwd) return null
    if (!UUID_RE.test(target.uuid)) return null
    if (!survivingCwd) return null

    // Expand a leading `~` in the target cwd the same way resolveResumeLaunch does.
    const rawTargetCwd = expandResumeTargetCwd(target.cwd, deps.homedir())

    // ORPHAN GATE: recovery applies ONLY when the original cwd is gone. If it
    // still exists, resolveResumeLaunch failed for another reason (e.g. the
    // transcript was pruned) and relocating would be wrong.
    if (deps.existsSync(rawTargetCwd)) return null

    // The surviving cwd must be a real directory and MUST NOT be home/an ancestor.
    const survivingResolved = nodePath.resolve(survivingCwd)
    if (!deps.existsSync(survivingResolved)) return null
    if (!deps.statSync(survivingResolved).isDirectory()) return null
    if (deps.isHomeOrAncestor(survivingResolved)) return null

    const rootWithSep = deps.projectsRoot.endsWith(nodePath.sep) ? deps.projectsRoot : deps.projectsRoot + nodePath.sep
    const contained = (p: string): boolean => p === deps.projectsRoot || p.startsWith(rootWithSep)

    const orphanDir = nodePath.resolve(nodePath.join(deps.projectsRoot, deps.mangleCwdToProjectDir(target.cwd)))
    const orphanTranscript = nodePath.join(orphanDir, `${target.uuid}.jsonl`)
    if (!contained(orphanDir)) return null
    if (!deps.existsSync(orphanTranscript)) return null

    const destDir = nodePath.resolve(nodePath.join(deps.projectsRoot, deps.mangleCwdToProjectDir(survivingResolved)))
    const destTranscript = nodePath.join(destDir, `${target.uuid}.jsonl`)
    if (!contained(destDir)) return null

    // Relocate ONLY into an empty destination slot. If the source already sits
    // in the destination folder (the surviving cwd mangles to the same place), or
    // a transcript for this uuid already exists there, resume in place and move
    // nothing — never overwrite a live transcript (see the collision rule above).
    if (destTranscript !== orphanTranscript && !deps.existsSync(destTranscript)) {
      deps.mkdirp(destDir)
      relocate(orphanTranscript, destTranscript, deps)
    }

    try { deps.ensureCompanionDir(destDir, target.uuid) } catch { /* best-effort */ }

    return { resumeUuid: target.uuid, claudeCwd: survivingResolved }
  } catch {
    return null
  }
}

/**
 * Move src→dst. Caller guarantees dst does not yet exist.
 *
 * Prefer an atomic same-name rename. On cross-device (EXDEV) or a locked source,
 * copy to a SAME-DIRECTORY temp sibling and rename THAT into place — so a partial
 * copy never lands at the `<uuid>.jsonl` name the heuristic binder scans (adv
 * review #535). The temp is a sibling of dst, so the final rename is same-device.
 * On any copy failure the partial temp is removed before the error propagates
 * (the outer catch in recoverOrphanResumeLaunch then fails the recovery closed).
 * A source that cannot be unlinked after a successful copy is a non-fatal leak —
 * warn, do not throw (resume already has a correct destination).
 */
function relocate(src: string, dst: string, deps: RecoverOrphanDeps): void {
  try {
    deps.renameFile(src, dst)
    return
  } catch {
    // fall through to the copy fallback
  }
  const tmp = `${dst}.partial-${deps.pid()}`
  try {
    deps.copyFile(src, tmp)
    deps.renameFile(tmp, dst)
  } catch (e) {
    try { deps.removeFile(tmp) } catch { /* best-effort cleanup */ }
    throw e
  }
  try {
    deps.removeFile(src)
  } catch {
    deps.warn(`[resume] orphan recovery: copied transcript to ${dst} but could not remove the source ${src} (left in place)`)
  }
}

// ---------------------------------------------------------------------------
// buildResumeTranscriptPath — deterministic resume-bind path (Part A)
// ---------------------------------------------------------------------------

/**
 * Construct the canonical transcript path for a KNOWN resume target so the
 * caller (pty-manager) can bind it IMMEDIATELY at spawn, without waiting for the
 * exact sources (hooks / statusline) or the heuristic fallback. This closes the
 * boot-time race that left the FIRST resumed session unbound (`nt=0`).
 *
 *   <homedir>/.claude/projects/<mangle(launchCwd)>/<uuid>.jsonl
 *
 * `launchCwd` must be the cwd the conversation ACTUALLY runs in (the
 * resolveResumeLaunch `claudeCwd`), since that is what Claude CLI mangles into
 * the project-folder name (P3.16a round 2, Q1: the name Claude Code gives it,
 * claudeProjectDirName). The uuid is re-validated against the canonical UUID
 * format (defense-in-depth) — a non-UUID stem or empty cwd returns null so the
 * caller simply skips the deterministic bind (the heuristic still covers it).
 *
 * `homedir` and `launchFolder` are injectable for testing; production passes
 * os.homedir and reads the real folder.
 */
export function buildResumeTranscriptPath(
  launchCwd: string,
  uuid: string,
  homedir: () => string = () => nodeOs.homedir(),
  launchFolder?: ClaudeLaunchFolderOptions,
): string | null {
  if (!launchCwd || !uuid || !UUID_RE.test(uuid)) return null
  return nodePath.join(homedir(), '.claude', 'projects', claudeProjectDirName(launchCwd, launchFolder), `${uuid}.jsonl`)
}

/** A folder cmd.exe cannot start in: a share or a device path (two leading
 *  slashes of either kind). Claude Code's npm launcher (claude.cmd) runs
 *  under cmd.exe, so it is never started there. */
const CMD_EXE_NETWORK_FOLDER_RE = /^[\\/]{2}/
/** Why a launch through Claude Code's npm launcher in such a folder is
 *  refused (the resume picker says the same, scripts/resume-picker.js). */
export const CLAUDE_NETWORK_FOLDER_REFUSAL = 'Cannot start Claude Code in a network folder through its npm launcher: open the folder from a mapped drive letter, or install the native Claude Code.'

/**
 * The user's extra CLI arguments as a launch line carries them: each word
 * after a space, or '' when there are none. On Windows the line is read by
 * PowerShell, and each word is single-quoted (quoteArgForShell), so PowerShell
 * hands Claude Code each word exactly as written and reads nothing in it: no
 * comma joining words into a list, no number, no operator. Elsewhere a POSIX
 * shell reads the words as they are, as the rule that passed them expects
 * (it matches each word with its backslashes removed).
 */
export function claudeUserArgsOnLine(userArgs: string | undefined, isWin32: boolean): string {
  const words = (userArgs ?? '').split(' ').filter((w) => w !== '')
  return words.map((w) => ` ${isWin32 ? quoteArgForShell(w, true) : w}`).join('')
}

/** What the log says when a fresh session on Windows starts Claude Code
 *  directly because no node was found to run the resume list. */
export const CLAUDE_RESUME_LIST_SKIPPED_NO_NODE = 'Node.js was not found in a folder PATH names (node.exe), so the resume list was skipped and Claude Code starts directly'

/** What the log says when a fresh session on Windows starts Claude Code
 *  directly because the node.exe found is at a path the line does not start
 *  a program from (PICKER_NODE_UNSTARTABLE_RE). Never the path itself. */
export const CLAUDE_RESUME_LIST_SKIPPED_NODE_PATH = 'Node.js was found, but its folder path holds [ or ], which a launch line does not start a program from, so the resume list was skipped and Claude Code starts directly. Install Node.js in a folder without [ or ] to use the resume list'

/** What a macOS or Linux session prints, in the session itself, when its
 *  shell finds no node and Claude Code starts without the resume list
 *  (buildClaudeLaunchCommand). ASCII, with no single quote: the line carries
 *  it single-quoted. */
export const RESUME_LIST_SKIPPED_NOTICE = 'Node.js was not found, so the resume list was skipped.'

/** The variable a line that starts the resume picker names its Claude Code
 *  in (claudeBin, quoted for the session's shell), so the picker starts the
 *  same one (scripts/resume-picker.js forwardedClaudeCmd, which checks it).
 *  Set in the session's shell, so what the line starts inherits it too. */
export const CLAUDE_BIN_ENV = 'CCC_CLAUDE_BIN'

/** The file a Windows line's resume picker runs on: node.exe, looked for in
 *  the folders PATH names in full (pickerNodeOnWindows).
 *
 *  The line starts it by the full path that lookup returned, single-quoted
 *  as the line quotes every path, after PowerShell's call operator
 *  (`& 'C:\Program Files\nodejs\node.exe' '<picker>' ...`), so that the
 *  file the app found is the program that runs. The session's PowerShell
 *  runs the user's profile after the app kept PATH to fully qualified
 *  folders, and a program started by a name is looked up by PowerShell's
 *  own rules (functions and aliases of that name, PATHEXT, and the PATH the
 *  profile leaves, relative entries included); a program started by its
 *  full path is not. Two exceptions remain, measured with Windows
 *  PowerShell 5.1 and PowerShell 7.6:
 *   - a function or alias named by the whole path itself still comes first,
 *     which only the user's own profile could define, as for every path a
 *     launch line starts;
 *   - Windows PowerShell 5.1, the session shell (login-shell.ts
 *     localSessionShell), reads `[` and `]` in that path as a wildcard
 *     pattern before it tries the path as written, so it may not start the
 *     file the app found. PowerShell 7 runs the path as written. Escaping
 *     them is no answer: PowerShell 7 then finds nothing. So a found path
 *     holding either is never put on the line (PICKER_NODE_UNSTARTABLE_RE,
 *     windowsPickerNode): the line starts Claude Code directly, and the log
 *     says why.
 *  It is an `.exe` file, which PowerShell starts itself, so cmd.exe never
 *  reads the picker's line. */
const PICKER_NODE_FILE = 'node.exe'

/** What in a program's path a Windows line will not start it from: `[` or
 *  `]`, which Windows PowerShell 5.1 reads as a wildcard pattern in the path
 *  of a program it is told to start with `&` (PICKER_NODE_FILE). Windows
 *  file names cannot hold the other wildcard characters, `*` and `?`. A
 *  backtick, PowerShell's wildcard escape, was measured in a path without
 *  brackets in Windows PowerShell 5.1 and PowerShell 7: both start the path
 *  as written, so it is not refused. With brackets the path is refused for
 *  them. `&` has no literal-path form, so this holds for both programs a
 *  line starts: the found node.exe (windowsPickerNode) and Claude Code on a
 *  line that starts it itself (CLAUDE_BIN_BRACKETS_REFUSAL). */
const PICKER_NODE_UNSTARTABLE_RE = /[[\]]/

/** Why a Windows line that starts Claude Code itself (no resume list) is
 *  refused when Claude Code's path holds `[` or `]`
 *  (PICKER_NODE_UNSTARTABLE_RE). A line that starts the resume list only
 *  names that path in a variable, which nothing reads as a pattern, and the
 *  picker starts it without PowerShell, so that line is not refused. */
export const CLAUDE_BIN_BRACKETS_REFUSAL = 'Cannot start Claude Code: its path holds [ or ], which a launch line does not start a program from. Install Claude Code in a folder without [ or ].'

/** A fully qualified Windows folder, a drive (`C:\`) or a share
 *  (`\\server\share`), as a regular expression's text that PowerShell's
 *  `-match` (.NET) and JavaScript read alike: the app's own rule
 *  (src/main/providers/windows-path-names.ts
 *  windowsPathFolderIsFullyQualified), which a parity test holds it to.
 *  Single-quoted on the line, where PowerShell reads every backslash as
 *  written; it holds no single quote. */
export const FULLY_QUALIFIED_FOLDER_PATTERN = '^(?:[A-Za-z]:[\\\\/]|[\\\\/]{2}[^\\\\/?.][^\\\\/]*[\\\\/][^\\\\/]+)'

/**
 * The statements a Windows line runs just before it starts Claude Code
 * itself by anything but an `.exe` file (npm's claude.cmd, a claude.bat; a
 * claude.ps1 is held to the same rule, as in "Lines cmd.exe reads" below).
 * Such a launcher starts further programs by a bare name: npm's starts
 * `node` through cmd.exe. The session started with PATH kept to its fully
 * qualified folders and NoDefaultCurrentDirectoryInExePath set
 * (withFullyQualifiedProgramLookup, src/main/providers/claude/spawn.ts), and
 * the user's PowerShell profile runs after that, so the line applies the
 * app's rule again, in the session, after the profile:
 *  - every PATH entry trimmed, one pair of surrounding double quotes dropped
 *    and trimmed again, and only a fully qualified folder kept, a drive or a
 *    share (FULLY_QUALIFIED_FOLDER_PATTERN, the app's
 *    windowsPathFolderIsFullyQualified); with none kept, PATH is removed;
 *  - NoDefaultCurrentDirectoryInExePath set, so cmd.exe looks for a program
 *    only in the folders PATH names.
 * Written with PowerShell operators only (`-split`, `-replace`, `-match`,
 * `-join`, each on the whole array), with no variable of its own and no
 * command, so nothing a profile defines can stand in for a step of it, on
 * Windows PowerShell 5.1 and PowerShell 7 alike. Statements for the
 * session's PowerShell, before the program: no part of the command line the
 * program is handed, so the agent templates' length budget does not count
 * them, and cmd.exe never reads them as text.
 */
export const LAUNCHER_PROGRAM_LOOKUP = `$env:Path = @($env:Path -split ';' -replace '^\\s+|\\s+$' -replace '^"(.*)"$', '$1' -replace '^\\s+|\\s+$' -match '${FULLY_QUALIFIED_FOLDER_PATTERN}') -join ';'; $env:NoDefaultCurrentDirectoryInExePath = '1'; `

/** How long an answer about node.exe is used under the same PATH, found or
 *  not: the window the Claude Code lookup reuses its answer for
 *  (CLAUDE_LOOKUP_REUSE_MS, claude-cli-probe.ts). The CLI check, every 30 s,
 *  gives a new one (warmPickerNodeOnWindows). */
export const PICKER_NODE_REUSE_MS = 60_000

/** The last answer about node.exe: under which PATH, the full path found
 *  (null when none was), and when (a monotonic clock, so a change of the
 *  system time moves nothing). */
let pickerNodeAnswer: { path: string; exe: string | null; at: number } | null = null
/** The look warmPickerNodeOnWindows has in flight, so a slow one (a PATH
 *  folder on a share that does not answer) is never joined by another. */
let pickerNodeWarming: Promise<void> | null = null

/** The answer kept for `pathValue` when it is less than PICKER_NODE_REUSE_MS
 *  old (the full path, or null for none); undefined when there is none. */
function recentPickerNodeAnswer(pathValue: string, now: number): string | null | undefined {
  const last = pickerNodeAnswer
  if (!last || last.path !== pathValue) return undefined
  const age = now - last.at
  return age >= 0 && age < PICKER_NODE_REUSE_MS ? last.exe : undefined
}

/**
 * Windows: looks for node.exe in the folders `env`'s PATH names in full, one
 * stat at a time off the event loop (findOnWindowsPathAsync), and keeps the
 * answer, the full path found or none, for pickerNodeOnWindows. The CLI
 * check calls it beside its own look for
 * Claude Code (ipc/cli-handlers.ts), so a launch normally reads a recent
 * answer and walks no PATH on the main process. Only one look runs at a time;
 * a call while one is in flight gets that one. Elsewhere: nothing.
 */
export function warmPickerNodeOnWindows(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  if (pickerNodeWarming) return pickerNodeWarming
  const pathValue = windowsEnvValue(env, 'PATH') ?? ''
  const run: Promise<void> = findOnWindowsPathAsync([PICKER_NODE_FILE], env)
    .then(
      (exe) => { pickerNodeAnswer = { path: pathValue, exe, at: performance.now() } },
      () => { /* no answer: a launch looks for itself */ },
    )
    // Only this look's own mark: one started after a reset is left in flight.
    .finally(() => { if (pickerNodeWarming === run) pickerNodeWarming = null })
  pickerNodeWarming = run
  return run
}

/**
 * Windows: the full path of node.exe, which runs the resume list, in a folder
 * this process's PATH names in full (the walk the install tab's check makes
 * for it), or null when none holds it. Asked of this machine, the one the
 * session runs on. A Windows launch line starts the resume picker with
 * exactly this path (PICKER_NODE_FILE), so what the session's PowerShell
 * profile does to PATH, or defines, does not change which node runs, save
 * the two exceptions PICKER_NODE_FILE names; a path Windows PowerShell 5.1
 * would read as a pattern is never started (windowsPickerNode). Starts no
 * process. The answer is
 * the one kept for this PATH when it is less than PICKER_NODE_REUSE_MS old
 * (normally the CLI check's, warmPickerNodeOnWindows); only without one is
 * PATH walked here, on the main process (findOnWindowsPath), and that answer
 * kept in turn.
 *
 * One launch asks twice: for the program its agent templates' value is
 * written for (claudeLaunchProgram), then for the line
 * (buildClaudeLaunchCommand), in one synchronous run with no await between,
 * so no look off the event loop can land between them. Both get the same
 * answer unless the kept one runs out in the milliseconds between the two
 * questions and node.exe appeared or went in those same milliseconds. A
 * changed PATH is asked again at once.
 *
 * What is seen while the app runs: node.exe removed, or put into a folder
 * this process's PATH already names, within a minute. Not a fresh install of
 * Node.js: its installer adds its folder to PATH in the registry, and this
 * process's PATH is the one it started with. The user sees the new install
 * after restarting the app, or after Check again where the app shows it
 * (or the check the app runs after an install ends), which reads the
 * registry and adds the new folder (windows-path-refresh.ts). After either,
 * PATH reads differently and the next launch asks again.
 */
function pickerNodeOnWindows(): string | null {
  const pathValue = windowsEnvValue(process.env, 'PATH') ?? ''
  const now = performance.now()
  const recent = recentPickerNodeAnswer(pathValue, now)
  if (recent !== undefined) return recent
  const exe = findOnWindowsPath([PICKER_NODE_FILE], process.env)
  pickerNodeAnswer = { path: pathValue, exe, at: now }
  return exe
}

/** The node.exe a Windows launch line starts the resume picker with: the
 *  path pickerNodeOnWindows found (`exe`), or null with what the log says
 *  instead (`skipped`): none found, or one at a path the line does not start
 *  a program from (PICKER_NODE_UNSTARTABLE_RE). */
function windowsPickerNode(): { exe: string; skipped: null } | { exe: null; skipped: string } {
  const exe = pickerNodeOnWindows()
  if (exe === null) return { exe: null, skipped: CLAUDE_RESUME_LIST_SKIPPED_NO_NODE }
  if (PICKER_NODE_UNSTARTABLE_RE.test(exe)) return { exe: null, skipped: CLAUDE_RESUME_LIST_SKIPPED_NODE_PATH }
  return { exe, skipped: null }
}

/**
 * Whether node, which runs the resume list, is found where a Claude session's
 * launch line would start it: on Windows, node.exe in a folder this
 * process's PATH names in full, at a path the line starts it by
 * (windowsPickerNode). Elsewhere: true. A session there starts in the user's
 * login shell, whose own files build its PATH (Homebrew's, nvm's), so the
 * line asks that shell itself (buildClaudeLaunchCommand). A yes or no view
 * of the answer a launch reads (pickerNodeFor); no launch calls it. Only
 * tests read it now (src/main/ipc/cli-handlers.ts names it in a comment),
 * so a change to the launch's answer goes in windowsPickerNode, never here.
 */
export function pickerNodeFound(): boolean {
  if (process.platform !== 'win32') return true
  return windowsPickerNode().exe !== null
}

/** Test seam: forget the kept answer and any look in flight (one still
 *  running lands its answer when it ends). */
export function _resetPickerNodeFoundForTest(): void {
  pickerNodeAnswer = null
  pickerNodeWarming = null
}

/** What decides whether a launch line starts the resume picker, and the
 *  platform the line is for (this machine's when not given; the builder
 *  always gives its own). */
type PickerLaunchOptions = Pick<BuildClaudeLaunchCommandOptions, 'useResumePicker' | 'pickerScript' | 'resumeUuid'> & { platform?: string }

/** The node a launch line starts the resume picker with (`node`), or null
 *  when the line starts Claude Code itself (no picker asked for or deployed,
 *  an exact resume, or no node it can start the picker with). A Windows
 *  line: the full path of the node.exe the app found (windowsPickerNode),
 *  the program it starts; when there is none it can start, `skipped` is
 *  what the log says. Elsewhere `node`, which the session's own shell looks
 *  up. */
function pickerNodeFor(opts: PickerLaunchOptions): { node: string | null; skipped: string | null } {
  if (opts.resumeUuid || !opts.useResumePicker || !opts.pickerScript) return { node: null, skipped: null }
  if ((opts.platform ?? process.platform) !== 'win32') return { node: 'node', skipped: null }
  const found = windowsPickerNode()
  return { node: found.exe, skipped: found.skipped }
}

/** Whether the launch line starts the resume picker (on Windows by the full
 *  path of the node.exe the app found, elsewhere by node as the session's
 *  shell finds it) rather than Claude Code itself. One answer for the
 *  builder and for the program whose agent templates' value is chosen
 *  before the spawn (claudeLaunchProgram). Never when no node is found that
 *  the line can start it with. */
export function launchStartsPicker(opts: PickerLaunchOptions): boolean {
  return pickerNodeFor(opts).node !== null
}

/** The program a Claude launch line starts: `node` when it runs the resume
 *  picker, otherwise Claude Code (`claudeBin`). On Windows the agent
 *  templates' value is written for this program (agentsEnvValue), and its
 *  command line is held to this program's limit (windowsCommandLineLimit).
 *  There the picker line starts node.exe by the full path the app found
 *  (PICKER_NODE_FILE); `node` still names it here because the picker may
 *  hand the line on to a batch launcher through cmd.exe, whose limit
 *  applies. */
export function claudeLaunchProgram(opts: Pick<BuildClaudeLaunchCommandOptions, 'claudeBin'> & PickerLaunchOptions): string {
  return launchStartsPicker(opts) ? 'node' : opts.claudeBin
}

/** One agent template, as a session's options carry it (pty:spawn's schema). */
export interface ClaudeAgentTemplate {
  name: string
  description: string
  prompt: string
  model?: string
  tools?: string[]
}

/** How every refusal of a session's agent templates starts. */
const AGENTS_REFUSAL = 'Cannot start Claude Code with these agent templates'

/**
 * The value Claude Code's `--agents` takes, from a session's templates: ONE
 * JSON object keyed by agent name, each name holding its description and
 * prompt, and its model and tools when given; nothing else
 * (`{"reviewer": {"description": "...", "prompt": "..."}}`, as
 * `claude --help` gives it). Claude Code checks the whole set when it starts,
 * and one template it does not take costs every template: it stops with an
 * error, or starts with none of them. So such a set is refused here, before
 * anything starts, naming the template by its place in the list: one with no
 * name, a name that starts with `-`, a name an earlier template has, no
 * description, or a blank model.
 */
export function claudeAgentsObject(templates: readonly ClaudeAgentTemplate[]): Record<string, Omit<ClaudeAgentTemplate, 'name'>> {
  const seen = new Map<string, number>()
  const entries: Array<[string, Omit<ClaudeAgentTemplate, 'name'>]> = []
  templates.forEach(({ name, description, prompt, model, tools }, i) => {
    const n = i + 1
    if (typeof name !== 'string' || name === '') throw new Error(`${AGENTS_REFUSAL}: template ${n} has no name.`)
    if (name.startsWith('-')) throw new Error(`${AGENTS_REFUSAL}: the name of template ${n} starts with a hyphen.`)
    const first = seen.get(name)
    if (first !== undefined) throw new Error(`${AGENTS_REFUSAL}: templates ${first} and ${n} have the same name.`)
    seen.set(name, n)
    if (typeof description !== 'string' || description === '') throw new Error(`${AGENTS_REFUSAL}: template ${n} has no description.`)
    if (model !== undefined && model.trim() === '') throw new Error(`${AGENTS_REFUSAL}: template ${n} names a blank model.`)
    entries.push([name, { description, prompt, ...(model !== undefined ? { model } : {}), ...(tools !== undefined ? { tools } : {}) }])
  })
  // Every name becomes the object's own key, `__proto__` included.
  return Object.fromEntries(entries)
}

/** Room on a Windows program's command line for what comes before its
 *  arguments besides its own path: how cmd.exe starts, and, on a line cmd.exe
 *  reads, what npm's launcher writes in place of its own name (node, and
 *  Claude Code's script under the launcher's folder, for which the length
 *  also counts Claude Code's path once more). */
export const AGENTS_LAUNCHER_ROOM = 256

/** Why a launch whose agent templates make the program's command line longer
 *  than Windows allows is refused (`length` and `limit` in characters). */
export function agentsTooLongRefusal(length: number, limit: number, program: string): string {
  const npm = /\.(cmd|bat)$/i.test(program) ? ', or install the native Claude Code' : ''
  return `${AGENTS_REFUSAL}: they make Claude Code's command line about ${length} characters long, and Windows allows ${limit} there. Shorten the templates${npm}.`
}

// ---------------------------------------------------------------------------
// Lines cmd.exe reads (Windows)
// ---------------------------------------------------------------------------
//
// A Windows launch line is read by PowerShell, which hands its program one
// command line. When that program is a batch file (npm's claude.cmd, a
// claude.bat) Windows runs it through cmd.exe, which reads that command line
// again, and so does the launcher when it passes its arguments on. PowerShell
// wraps an argument in double quotes only when it holds a space, and writes
// it verbatim otherwise. So on a line that starts Claude Code by anything but
// an `.exe` file, every argument written as text is checked: nothing in it
// may be read as more than text by cmd.exe. Such a line also sets the
// session's program lookup again just before the launcher
// (LAUNCHER_PROGRAM_LOOKUP), so what the launcher starts by a bare name is
// found only in a folder PATH names in full.
//
// The resume picker's line is not such a line: it starts node.exe by the full
// path the app found (PICKER_NODE_FILE), an `.exe` file PowerShell starts
// itself, so cmd.exe never reads it. When the picker starts a batch launcher
// it quotes for cmd.exe itself, and refuses what it cannot quote
// (scripts/resume-picker.js buildSpawnTarget).
//
// A claude.ps1 (an npm install folder can hold one) is checked as a
// batch launcher would be, although PowerShell runs it itself: an edge npm
// does not create alone (it writes claude.cmd beside it), kept fail-closed.

/** What cmd.exe reads as more than text anywhere, inside its quotes too: a
 *  double quote (it turns cmd.exe's quote state), `%` (it expands variables
 *  inside quotes as well) and control characters. Not `!`: cmd.exe reads it
 *  only with delayed expansion on, which is off unless turned on in the
 *  registry, and npm's launcher does not turn it on (the resume picker takes
 *  the same view, buildSpawnTarget). With it turned on, a `!NAME!` in an
 *  argument is replaced by that variable of the user's own environment on
 *  the way to Claude Code, so "as written" holds only with it off. */
const CMD_READS_ANYWHERE_RE = /["%\p{Cc}]/u
/** What cmd.exe reads as more than text outside its quotes, where an
 *  argument without a space stays. */
const CMD_READS_UNQUOTED_RE = /[&|<>^()]/
/** What PowerShell reads outside single quotes: a variable or an escape, so
 *  such a word's value is not its text. */
const PS_READS_BARE_RE = /[$`]/
/** A batch launcher path cmd.exe or the launcher itself would re-read, as the
 *  resume picker and the version check refuse it: `" % & ^` or a control
 *  character. Parentheses and spaces are fine (Program Files (x86)). */
const CMD_LAUNCHER_PATH_UNSAFE_RE = /["%&^\p{Cc}]/u
/** Every character PowerShell takes as a single-quote delimiter
 *  (escapeForCwdQuote doubles each of them inside a quoted value). */
const PS_SINGLE_QUOTES = '\u0027\u2018\u2019\u201A\u201B'

/** One argument of a Windows launch line: its text as PowerShell hands it on,
 *  and what of it was written outside single quotes. */
interface LineWord { text: string; bare: string }

/** The arguments in `line`, a run of words this builder writes for
 *  PowerShell: each bare or single-quoted (a doubled delimiter inside quotes
 *  is one literal), separated by spaces. */
function powerShellWords(line: string): LineWord[] {
  const words: LineWord[] = []
  let cur: LineWord | null = null
  let quote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (PS_SINGLE_QUOTES.includes(c)) {
        if (i + 1 < line.length && PS_SINGLE_QUOTES.includes(line[i + 1])) { cur!.text += line[i + 1]; i++ } else quote = false
      } else cur!.text += c
      continue
    }
    if (c === ' ') { if (cur) words.push(cur); cur = null; continue }
    if (!cur) cur = { text: '', bare: '' }
    if (PS_SINGLE_QUOTES.includes(c)) { quote = true; continue }
    cur.text += c
    cur.bare += c
  }
  if (cur) words.push(cur)
  return words
}

/** What a refused argument is called: the option it is the value of, when
 *  the word before it (or its own `--name=` part) names one. */
function argumentName(words: readonly LineWord[], i: number): string {
  const option = (w: LineWord | undefined): string | null => {
    const m = w ? /^(--[a-z][a-z0-9-]*)(=|$)/.exec(w.text) : null
    return m ? m[1] : null
  }
  const own = option(words[i])
  if (own && words[i].text.includes('=')) return `the value of ${own}`
  if (own) return `the option ${own}`
  const before = option(words[i - 1])
  return before ? `the value of ${before}` : 'an argument'
}

/** How a refusal of a line cmd.exe would read starts. */
const NPM_LAUNCHER_REFUSAL = 'Cannot start Claude Code through its npm launcher'

/** Why a Windows line that starts Claude Code through a program cmd.exe may
 *  read is refused, or null: the batch launcher's own path (`launcher`, when
 *  the line starts one), and each argument (`args`, words of this builder's
 *  text). */
function cmdReadLineRefusal(launcher: string | null, args: string): string | null {
  if (launcher !== null && CMD_LAUNCHER_PATH_UNSAFE_RE.test(launcher)) {
    return `${NPM_LAUNCHER_REFUSAL}: cmd.exe would read a character in the launcher's own path as more than text (" % & ^ or a control character). Install the native Claude Code, or install the npm one in a folder without those characters.`
  }
  const words = powerShellWords(args)
  for (let i = 0; i < words.length; i++) {
    const { text, bare } = words[i]
    const unsafe = CMD_READS_ANYWHERE_RE.test(text) || PS_READS_BARE_RE.test(bare) || (!text.includes(' ') && CMD_READS_UNQUOTED_RE.test(text))
    if (!unsafe) continue
    return `${NPM_LAUNCHER_REFUSAL}: ${argumentName(words, i)} holds a character cmd.exe would read as more than text (" or % or a control character anywhere, or one of & | < > ^ ( ) in a value without a space). Install the native Claude Code, or keep these characters out of the folders the app uses.`
  }
  return null
}

export function buildClaudeLaunchCommand(opts: BuildClaudeLaunchCommandOptions): string {
  const { cwd, claudeBin, useResumePicker, pickerScript, resumeUuid } = opts
  const isWin32 = opts.platform === 'win32'
  // Windows, templates in the environment: the line names the variable, and
  // starts by having PowerShell pass arguments the one way agentsEnvValue
  // writes them for (PS_LEGACY_ARGUMENT_PASSING).
  const agentsFromEnv = isWin32 && opts.agentsFromEnv === true
  if (agentsFromEnv && opts.agentsFlag) throw new Error('buildClaudeLaunchCommand: agentsFlag and agentsFromEnv are exclusive')
  const agentsFlag = agentsFromEnv ? ` --agents ${agentsRef()}` : opts.agentsFlag
  const lead = agentsFromEnv ? `${PS_LEGACY_ARGUMENT_PASSING}; ` : ''
  // The app's own options, then the user's words: an option among them that
  // takes a value can never take one of the app's options as that value.
  const extraFlags = `${opts.extraFlags}${claudeUserArgsOnLine(opts.userArgs, isWin32)}`
  // Every line below that starts Claude Code itself starts it in `cwd`: an
  // npm launcher there is refused, with the reason, when cmd.exe cannot start
  // in that folder. The picker line starts node, which can; the picker
  // refuses its own launch there. `pickerNode`: the node the picker line
  // starts (on Windows the full path the app found), asked once per line;
  // `pickerSkipped`: on Windows, why there is none (the log line).
  const { node: pickerNode, skipped: pickerSkipped } = pickerNodeFor(opts)
  const startsPicker = pickerNode !== null
  if (isWin32 && !startsPicker && /\.(cmd|bat)$/i.test(claudeBin) && typeof cwd === 'string' && CMD_EXE_NETWORK_FOLDER_RE.test(cwd)) {
    throw new Error(CLAUDE_NETWORK_FOLDER_REFUSAL)
  }
  // Windows, a line that starts Claude Code itself: `& '<claudeBin>'`, which
  // Windows PowerShell 5.1 reads as a pattern when the path holds `[` or `]`
  // (PICKER_NODE_UNSTARTABLE_RE), so such a path is refused with the reason.
  if (isWin32 && !startsPicker && PICKER_NODE_UNSTARTABLE_RE.test(claudeBin)) {
    throw new Error(CLAUDE_BIN_BRACKETS_REFUSAL)
  }
  // Positional opening prompt, by env reference — never the text itself.
  // Trailing position: `claude [options] [prompt]`.
  //
  // `--` first, because the question is free text and a question that IS a flag
  // is otherwise a flag. Without it, `--settings=C:\evil.json` typed as a
  // question binds `--settings`: the trailing space askPromptEnvValue adds lands
  // in the VALUE half of an `--opt=value` form, so it does not save us there.
  // `claude` honours the separator (`claude --print -- "--nonexistent-flag …"`
  // answers the prompt instead of erroring on an unknown option — verified
  // against the installed CLI, not assumed of its parser).
  const promptArg = opts.askPrompt ? ` -- ${askPromptRef(isWin32)}` : ''
  const escapedCwd = escapeForCwdQuote(cwd, isWin32)
  // SINGLE-quoted, not double.
  //
  // `& "${claudeBin}"` looked safe because a binary path is not user text —
  // but it IS a path, and it comes from the resources directory or a `where`
  // lookup, so a directory name decides its contents. Inside DOUBLE quotes
  // both shells expand: PowerShell evaluates `$(...)` and POSIX evaluates
  // `$(...)` and backticks, at runtime, and both were verified executing.
  // Single quotes are literal in PowerShell and POSIX alike, and `& 'name'` /
  // `'name' args` still invoke a bare command name, a spaced path and an
  // absolute path exactly as before.
  const quotedBin = `'${escapeForCwdQuote(claudeBin, isWin32)}'`
  // Same shape of value (it also lives under the resources directory), and it
  // was being escaped by two hand-inlined copies of the helper — which is
  // precisely how it would have kept the old behaviour after the helper was
  // fixed. One helper, one call site each.
  const quotedPicker = pickerScript ? `'${escapeForCwdQuote(pickerScript, isWin32)}'` : null
  // Windows, a line that starts Claude Code itself by a program cmd.exe may
  // read (see "Lines cmd.exe reads" above): a batch launcher's own path, and
  // every argument the line writes as text (the options and the user's
  // words; not the agent templates' reference, whose value agentsEnvValue
  // writes for this program, nor the resume id, a checked uuid), must be
  // read by cmd.exe as text. Otherwise the launch is refused, with the
  // reason, before anything starts. The opening question's reference
  // (askPromptRef) is not checked here either: its value is the user's own
  // question, in which cmd.exe may still expand a `%` (askPromptEnvValue
  // says why it is left so). The picker's line starts node.exe by its full
  // path, an `.exe` cmd.exe never reads, and is not checked here.
  // opts.agentsFlag is '' whenever the templates ride the environment.
  if (isWin32 && !startsPicker && !startsAsExe(claudeBin)) {
    const refused = cmdReadLineRefusal(/\.(cmd|bat)$/i.test(claudeBin) ? claudeBin : null, `${opts.agentsFlag}${extraFlags}`)
    if (refused) throw new Error(refused)
  }
  // Every Windows line: `run` is the program and its arguments. With the
  // templates in the environment, the command line the program is handed
  // (`run` with the reference expanded, and room for what cmd.exe and npm's
  // launcher add) must fit what Windows lets that program have; otherwise the
  // launch would start nothing, so it is refused with the reason.
  // `pre`: statements before the program, for the session's PowerShell only
  // (they are no part of what the program is handed). `measured`: the
  // program and its arguments as the length is counted, `run` unless given.
  // The session folder is named to Set-Location by -LiteralPath, which takes
  // the folder as written, `[ ]` included, in Windows PowerShell 5.1 and
  // PowerShell 7, as the terminal tab's line does (pty-manager.ts).
  const windowsLine = (run: string, pre = '', measured = run): string => {
    if (agentsFromEnv && opts.agentsValueLength !== undefined) {
      // claudeLaunchProgram's answer, from this build's one look for node.
      const program = startsPicker ? 'node' : claudeBin
      const limit = windowsCommandLineLimit(program)
      // A line cmd.exe reads may name the launcher's folder once more.
      const again = limit === CMD_EXE_LINE_LIMIT ? claudeBin.length : 0
      const length = measured.length - agentsRef().length + opts.agentsValueLength + AGENTS_LAUNCHER_ROOM + again
      if (length > limit) throw new Error(agentsTooLongRefusal(length, limit, program))
    }
    return `${lead}Set-Location -LiteralPath '${escapedCwd}'; ${pre}${run}; exit`
  }
  // The picker starts the Claude Code this line would start itself
  // (CLAUDE_BIN_ENV), as an exact resume and a Restart do: the installed one
  // (resolveClaudeBinary; a version pinned in an older release is not used).
  // Set in the session's own shell, single-quoted there: the picker reads it,
  // and what the line starts inherits it.
  const claudeBinForPicker = `$env:${CLAUDE_BIN_ENV} = ${quotedBin}; `
  // Windows, a line that starts Claude Code itself (`& '<claudeBin>'`), on
  // every route that does (fresh, Ask Conductor, exact resume, and each
  // fallback from the resume list): by anything but an `.exe` file, the
  // session's lookup is set again first (LAUNCHER_PROGRAM_LOOKUP), after the
  // user's profile ran, so a program the launcher starts by a bare name
  // (npm's `node`) is found only in a folder PATH names in full. As `pre`,
  // outside the length counted for the agent templates. An `.exe` line is as
  // before.
  const windowsDirectLine = (run: string): string => windowsLine(run, startsAsExe(claudeBin) ? '' : LAUNCHER_PROGRAM_LOOKUP)

  // RESUME path: bypass the picker, launch claude directly with --resume first.
  // The --resume verb must precede every other flag (resume-picker.js:299), so
  // it is injected before agentsFlag/extraFlags here.
  if (resumeUuid) {
    // Re-validated HERE, not trusted from the caller. The uuid is the one value
    // on this line that is interpolated UNQUOTED, and every current caller does
    // gate it with the same anchored regex — but "the caller checks" is a
    // comment, not a boundary, and this function is exported. Anchored, so a
    // uuid with a trailing `; …` is refused rather than launched.
    if (!UUID_RE.test(resumeUuid)) throw new Error('buildClaudeLaunchCommand: resumeUuid is not a uuid')
    const resumeFlag = ` --resume ${resumeUuid}`
    return isWin32
      ? windowsDirectLine(`& ${quotedBin}${resumeFlag}${agentsFlag}${extraFlags}`)
      : `cd '${escapedCwd}' && ${quotedBin}${resumeFlag}${agentsFlag}${extraFlags}; exit`
  }

  // No-resume behaviour. P1.1: the picker-script branch forwards agentsFlag too
  // (it previously appended only extraFlags, silently dropping --agents on a
  // restored session). resume-picker.js forwards its own argv to
  // `claude --resume <id> ...`, so the flag survives the launch.
  if (useResumePicker) {
    // Windows: the picker only when node is found to run it, at a path the
    // line starts it by (startsPicker, the answer claudeLaunchProgram gave),
    // started by that full path (pickerNode, PICKER_NODE_FILE),
    // single-quoted as every path on the line is; otherwise Claude Code
    // directly, by the line built when the picker is not deployed, and the
    // log says why (pickerSkipped), never naming the path. The length is counted
    // as it was when the line named node by its file name: node's own path
    // is in no command line the picker hands on, so it costs the agent
    // templates nothing.
    if (quotedPicker && isWin32) {
      if (pickerNode !== null) {
        const pickerArgs = `${quotedPicker}${agentsFlag}${extraFlags}`
        return windowsLine(`& '${escapeForCwdQuote(pickerNode, true)}' ${pickerArgs}`, claudeBinForPicker, `${PICKER_NODE_FILE} ${pickerArgs}`)
      }
      // Built before the log line: a launch refused for another reason
      // starts nothing, and its log says only why it was refused.
      const direct = windowsDirectLine(`& ${quotedBin}${agentsFlag}${extraFlags}`)
      const id = typeof opts.sessionId === 'string' && SESSION_ID_IN_LOG_RE.test(opts.sessionId) ? ` ${opts.sessionId}:` : ''
      logInfo(`[spawn-claude]${id} ${pickerSkipped ?? CLAUDE_RESUME_LIST_SKIPPED_NO_NODE}`)
      return direct
    }
    // macOS and Linux: only the session's shell knows whether node is there
    // (its own files build its PATH, nvm's .zshrc included, and an app
    // started from the Finder or the Dock has launchd's minimal one), so the
    // line asks it. First it names Claude Code (CLAUDE_BIN_ENV), once: the
    // picker reads it, and Claude Code started directly inherits it, which
    // changes nothing for it. The `if` only picks the program (`set --`): the
    // picker by `node`, the command beta.2 typed; otherwise Claude Code, by
    // that name, after one line in the session saying why. The options
    // follow once, after `"$@"`. The launcher is
    // always of the sh family (shFamilyLoginShell), and every word the user
    // adds is an argument there, never a command (claudeUserArgsOnLine). A
    // failed `cd` starts nothing, as before.
    //
    // Length: the line is typed into a shell that may still be reading its
    // own files (eager nvm makes that slow), so the terminal may hold it in
    // canonical mode, where macOS keeps at most 1024 bytes (MAX_CANON) and a
    // longer line is cut, leaving the shell at a continuation prompt. So the
    // line is the beta.2 line plus a fixed length and Claude Code's path once,
    // never the options again; spawn-claude-no-node.test.ts holds that fixed
    // length to its measured value.
    //
    // Found means what `"$@"` can start by the name node: a node on PATH, or
    // a shell function named node (a lazy nvm loader, which puts node on PATH
    // the first time it runs), which a command name from `"$@"` still goes
    // through, as beta.2's typed `node` did. Never an alias: a command name
    // from `"$@"` does not go through one, so a node that is only an alias
    // (`alias node=nodejs`) would print "node: command not found" and close
    // the session. So the line drops any alias named node in the session's
    // own shell (harmless: the line ends in exit) before `command -v node`
    // asks; an alias-only node then counts as not found, and the session says
    // so and starts Claude Code directly. An alias in front of a node on PATH
    // does not hide that node.
    if (quotedPicker && !isWin32) {
      return `cd '${escapedCwd}' && export ${CLAUDE_BIN_ENV}=${quotedBin} && if { unalias node; command -v node; } >/dev/null 2>&1; then set -- node ${quotedPicker}; else printf '%s\\n' '${RESUME_LIST_SKIPPED_NOTICE}'; set -- "$${CLAUDE_BIN_ENV}"; fi && "$@"${agentsFlag}${extraFlags}; exit`
    }
    // Fallback: no picker script found, launch Claude directly.
    return isWin32
      ? windowsDirectLine(`& ${quotedBin}${agentsFlag}${extraFlags}`)
      : `cd '${escapedCwd}' && ${quotedBin}${agentsFlag}${extraFlags}; exit`
  }

  return isWin32
    ? windowsDirectLine(`& ${quotedBin}${agentsFlag}${extraFlags}${promptArg}`)
    : `cd '${escapedCwd}' && ${quotedBin}${agentsFlag}${extraFlags}${promptArg}; exit`
}
