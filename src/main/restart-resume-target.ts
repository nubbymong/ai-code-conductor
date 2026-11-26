/**
 * T8b (bug #5): the conversation a Claude Code tab's Restart or Switch
 * account carries on with, read off the transcript binder.
 *
 * In-session Restart / Switch account REUSE the session id: the renderer's
 * kill (`pty:kill`, reason 'restart') comes first, then the spawn. The old
 * run's end clears the binder's bind for the id (endRun, at its exit), so the
 * spawn reads the live conversation's resume target at its top, before its
 * own kill (pty-manager.ts spawnPty), and that works while the old CLI is
 * still winding down. A HELD session (the session helper on this computer)
 * ends at once: its exit reaches the app about 20 ms after the Restart's kill,
 * before the spawn, so the spawn found the bind cleared and showed the list of
 * earlier conversations (2.1.3-beta.19 fix round; on published beta.18 too:
 * 'Killing PTY' 05:53:18.682Z, 'PTY exited ... code 1' 18.704Z, 'Spawning
 * PTY' 18.724Z, 'resume=none'). So a Restart's kill reads it too, before the
 * session is killed, and the spawn that follows takes that one when the
 * binder no longer holds one. Only for a run whose spawn could read one (a
 * Claude Code session on this computer, not a terminal, not over SSH: the
 * binder tracks those transcripts only). A close drops what a Restart kept;
 * the next spawn of the id takes it, once, whatever it is.
 *
 * Fail-open everywhere: a miss leaves no target and the spawn falls back to
 * its usual behaviour.
 */
import { getTranscriptBinder } from './logging/logging-service'
import { isExactBindSourceActive } from './hooks'
import { resolveResumeTargetFromTranscript } from './logging/transcript-discovery'
import { logWarn } from './debug-logger'

export interface ResumeTarget { uuid: string; cwd: string }

/** Each session's latest run: whether its spawn could read a target. */
const readableRuns = new Map<string, boolean>()
/** What a Restart's kill read, by session id, until the next spawn of the id takes it. */
const keptByRestart = new Map<string, ResumeTarget>()

/** The conversation the binder holds for the session now; null when none. */
function readNow(sessionId: string): ResumeTarget | null {
  try {
    // #480: resume ONLY from an EXACT (authenticated) bind. The previous
    // getLatestTranscriptPath() also returned heuristic binds — a newest-file
    // scan of the shared per-repo transcript folder — which resumed a SIBLING
    // card's conversation when several cards ran in one repo. An exact-only
    // capture means "resume the conversation the hook confirmed for THIS
    // session, or start fresh"; a fresh start beats reopening a stranger.
    const binder = getTranscriptBinder()
    let latest = binder?.getExactResumeTarget(sessionId) ?? null
    // Hooks-off fallback: when no EXACT source can ever arrive (hooks disabled
    // or gateway down), fall back to the heuristic bind and WARN. In that
    // degraded config there is no authenticated source, so best-effort resume
    // beats never resuming — but it can cross if cards share a repo folder.
    if (!latest && !isExactBindSourceActive()) {
      latest = binder?.getLatestTranscriptPath(sessionId) ?? null
      if (latest) {
        logWarn(`[pty] #480 hooks-off resume fallback for ${sessionId}: hooks inactive, using heuristic bind ${latest} (best-effort; may cross if multiple cards share this repo)`)
      }
    }
    return latest ? resolveResumeTargetFromTranscript(latest) : null
  } catch (err) {
    logWarn(`[pty] T8b resume-target capture failed for ${sessionId}: ${(err as Error)?.message ?? err}`)
    return null
  }
}

/**
 * The spawn's capture, at its top, before its own kill: the target the
 * binder holds now, else the one the Restart's kill before it read (a held
 * session's exit came in between). `readable`: this spawn is of a Claude Code
 * session on this computer, not a terminal, not over SSH; otherwise none.
 * What a Restart kept is taken either way, and the run's kind remembered for
 * its own Restart.
 */
export function captureResumeTarget(sessionId: string, readable: boolean): ResumeTarget | null {
  const kept = keptByRestart.get(sessionId) ?? null
  keptByRestart.delete(sessionId)
  readableRuns.set(sessionId, readable)
  if (!readable) return null
  return readNow(sessionId) ?? kept
}

/**
 * A kill of the session (pty-manager.ts killPty). A Restart's reads the
 * target now, before the session is killed, when its run's spawn could read
 * one; a close drops what was kept and forgets the run; any other kill (a
 * spawn's own, a quit) drops what was kept.
 */
export function noteKillForResume(sessionId: string, reason: 'restart' | 'close' | undefined): void {
  keptByRestart.delete(sessionId)
  if (reason === 'close') { readableRuns.delete(sessionId); return }
  if (reason !== 'restart' || readableRuns.get(sessionId) !== true) return
  const target = readNow(sessionId)
  if (target) keptByRestart.set(sessionId, target)
}
