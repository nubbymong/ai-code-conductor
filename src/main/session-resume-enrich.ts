/**
 * session-resume-enrich.ts — main-side exact-conversation resume enrichment (#397).
 *
 * The renderer persists `session-state.json` from several call sites (the graceful
 * Save-&-Close, the debounced autosave, the account flush, the GitHub per-session
 * flush). Before #397 only ONE of them — Save-&-Close — enriched each session with
 * its exact-conversation resume target ({resumeUuid, resumeCwd}); every other
 * writer wrote a NON-enriched record, and the debounced autosave could even fire
 * after the enriched save and clobber it. So any non-graceful exit left a file
 * that, on the next launch, fell back to the terminal resume PICKER instead of
 * resuming the exact conversation.
 *
 * The transcript binder that knows each session's latest conversation lives in the
 * MAIN process. So enrichment belongs here, at the single `session:save` IPC choke
 * point, not spread across the renderer's writers: run it once in main and EVERY
 * writer persists a resumable record for free, and the clobber race dissolves
 * (there is no longer a non-enriched writer to clobber with).
 *
 * Pure + dependency-injected so it is unit-testable without the Electron ABI or a
 * live binder (the repo's spawn-claude-command / resume-picker convention).
 */
import type { SessionState } from './session-state'

export interface ResumeEnrichDeps {
  /**
   * #480: the binder's EXACT (authenticated) transcript path for a session, or
   * null. This is the source of truth — never the heuristic newest-file scan,
   * which cross-attributes conversations among cards that share one repo folder.
   */
  getExactResumeTarget: (sessionId: string) => string | null
  /**
   * #480: the heuristic-inclusive latest path, used ONLY as the hooks-off
   * fallback (when no exact source can ever arrive).
   */
  getLatestTranscriptPath: (sessionId: string) => string | null
  /**
   * #480: is an exact bind possible (hooks enabled)? When false, fall back to the
   * heuristic path so a hooks-off user still gets a resumable record.
   */
  isExactBindSourceActive: () => boolean
  /**
   * aicc_planning#104: is a transcript binder running (logging was on at
   * start)? With none, no session is ever bound, so main never learns that one
   * moved to another conversation, and a session with no bind is not given the
   * target it was last saved with. Absent: treated as no binder.
   */
  isBinderAvailable?: () => boolean
  /**
   * aicc_planning#104: the transcript path of the session's latest EXACT bind
   * this app run, kept after the bind itself is gone (the CLI exited or
   * crashed with the tab still open, or a Restart's next run has not bound
   * yet), or null when it has had none. Read only when the session has no
   * live bind. Absent: treated as none.
   */
  getLastExactResumeTarget?: (sessionId: string) => string | null
  /** Derive {uuid, cwd} from a transcript path, or null on any failure. */
  resolveResumeTargetFromTranscript: (transcriptPath: string) => { uuid: string; cwd: string } | null
  /**
   * P3.5: the conversation a non-Claude (Codex) tab is on, as its provider
   * keeps it in main (pty-manager's kept conversation: the one its status
   * line claimed, or the one an exact resume started), or null. Absent: such
   * tabs are left as they are.
   */
  getProviderResumeTarget?: (sessionId: string) => { uuid: string; cwd: string } | null | undefined
  /**
   * P3.6: the conversations whose claim was not certain (pty-manager), saved
   * with the state so a relaunch that resumes one keeps it from being carried
   * by a Switch account. Only those a saved session is on are written.
   */
  getUncertainProviderConversations?: () => string[]
  /**
   * P3.7: each conversation's running time, as main keeps it
   * (conversation-running-time.ts), saved with the state at every save,
   * whichever tabs are open (a closed tab's conversation can be resumed
   * later), so a session's Duration carries on across a relaunch. After a
   * clear they are written on their own (session-durability.ts, fixer 9 A1).
   */
  getConversationRunningTimes?: () => Array<{ id: string; ms: number; until: number; gaps?: Array<{ from: number; to: number }>; gapMs?: number }>
}

/** A conversation id, as every resume target must carry (the spawn schema's form). */
const CONVERSATION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

type ResumeTarget = { uuid: string; cwd: string }

/** A target main may carry forward: a conversation id and a directory, else null. */
function carriableTarget(uuid: unknown, cwd: unknown): ResumeTarget | null {
  return typeof uuid === 'string' && CONVERSATION_ID_RE.test(uuid) && typeof cwd === 'string' && cwd !== ''
    ? { uuid, cwd }
    : null
}

/**
 * The conversation a transcript path names, read from its file name
 * (`<uuid>.jsonl`, as resolveResumeTargetFromTranscript reads it) without
 * opening the file, or null when the name is not a conversation id.
 */
function conversationIdOfTranscript(transcriptPath: string): string | null {
  const name = transcriptPath.split(/[\\/]/).pop() ?? ''
  if (!name.endsWith('.jsonl')) return null
  const id = name.slice(0, -'.jsonl'.length)
  return CONVERSATION_ID_RE.test(id) ? id : null
}

/** Each Claude session's target in the state saved before this one, by id. */
function previousClaudeTargets(previous: SessionState | null | undefined): Map<string, ResumeTarget> {
  const out = new Map<string, ResumeTarget>()
  try {
    if (!previous || !Array.isArray(previous.sessions)) return out
    for (const p of previous.sessions) {
      if (!p || p.shellOnly || (p.provider ?? 'claude') !== 'claude' || typeof p.id !== 'string') continue
      const t = carriableTarget(p.resumeUuid, p.resumeCwd)
      if (t) out.set(p.id, t)
    }
  } catch {
    // Main's earlier state could not be read: nothing is carried forward.
    out.clear()
  }
  return out
}

/**
 * Enrich a SessionState IN PLACE with each Claude session's exact-conversation
 * resume target, read from the live transcript binder.
 *
 * aicc_planning#104: when no lookup gives a Claude session a target, it is saved
 * with the one it CARRIES: its record's own (a restored record before its spawn
 * takes it, or the renderer's own lookup at Save and close), else the one it
 * had in `previous`, the state main saved before this one (the durability
 * core's cache). The renderer's record carries no target once the spawn has
 * taken it, so before this one failed lookup (a transcript head that could not
 * be read, a binder that had not bound yet) saved the session with none, and
 * the next launch started it fresh. Main sees every save and every bind, so a
 * session keeps the conversation it is on whichever writer saves it, a session
 * started this run included.
 *
 * The session's bind says which conversation it is on: the live bind, else
 * (the CLI exited or crashed with the tab still open, or a Restart's next run
 * has not bound yet) the last exact bind main saw for it this run
 * (getLastExactResumeTarget; the durability core drops it once no save holds
 * the session). Either is read the same way. Its head gives the target. When
 * the head cannot be read, the carried target is saved only if it is the
 * conversation the bind names by its file name; one that is not (the session
 * moved on with /clear or /resume) is dropped and the session is saved with
 * none, the resume picker at the next launch, as before #104. So no save
 * brings back a conversation the session left for one main saw it bind. (A
 * bind whose file name is not a conversation id says nothing, and is treated
 * as no bind.)
 *
 * A session with no exact bind this run (a restored session before its first
 * bind) is saved with what it carries: its own target, else the one it was
 * last saved with, the latter only while a binder runs and the hooks setting
 * is on, so that its first move would normally reach main as a bind. The
 * setting is no proof that the hooks deliver: a restored session whose hooks
 * and status line never report can still be saved with the conversation it
 * was restored on after a move main never saw. With logging off at start, or
 * the hooks off, a record with no target of its own is saved with none, as
 * before #104.
 *
 * FAIL-SAFE throughout:
 *   - A null binder (logging disabled) leaves each record with what it carries.
 *   - Shell-only sessions are skipped; non-Claude (Codex) sessions never read
 *     the binder, which only tracks local Claude transcripts: P3.5 stamps them
 *     from their provider's kept conversation (getProviderResumeTarget), a
 *     conversation id only.
 *   - Never throws: a per-session failure leaves that one record unchanged.
 *
 * Returns the same object (mutated) for call-site convenience.
 */
export function enrichSessionStateWithResumeTargets(
  state: SessionState,
  deps: ResumeEnrichDeps,
  previous?: SessionState | null,
): SessionState {
  if (!state || !Array.isArray(state.sessions)) return state
  // Read before the loop: on an exit flush `previous` is this same state.
  const previousTargets = previousClaudeTargets(previous)
  for (const s of state.sessions) {
    try {
      if (!s || s.shellOnly) continue
      if ((s.provider ?? 'claude') !== 'claude') {
        const kept = deps.getProviderResumeTarget?.(s.id)
        if (kept && typeof kept.uuid === 'string' && CONVERSATION_ID_RE.test(kept.uuid) && typeof kept.cwd === 'string' && kept.cwd) {
          s.resumeUuid = kept.uuid
          s.resumeCwd = kept.cwd
        }
        continue
      }
      // aicc_planning#104: what this session carries if no lookup gives it a target.
      const ownTarget = !!s.resumeUuid || !!s.resumeCwd
      const carried = ownTarget ? carriableTarget(s.resumeUuid, s.resumeCwd) : previousTargets.get(s.id) ?? null
      // #480: EXACT bind only — this must not persist a heuristic (cross-prone)
      // guess. The hooks-off fallback re-enables the heuristic only when no
      // authenticated source can arrive.
      let latest = deps.getExactResumeTarget(s.id)
      if (!latest && !deps.isExactBindSourceActive()) {
        latest = deps.getLatestTranscriptPath(s.id)
      }
      // aicc_planning#104: no live bind (the CLI exited or crashed, or a
      // Restart's next run has not bound yet): the session's last exact bind
      // this run stands in for it and is read the same way, so neither what
      // the record carries (on an exit flush, main's own earlier target) nor
      // the target it was last saved with can bring back a conversation the
      // session left with /clear or /resume for one main saw it bind.
      if (!latest) latest = deps.getLastExactResumeTarget?.(s.id) ?? null
      if (latest) {
        const target = deps.resolveResumeTargetFromTranscript(latest)
        if (target && target.uuid && target.cwd) {
          s.resumeUuid = target.uuid
          s.resumeCwd = target.cwd
          continue
        }
        // The head could not be read, but the file name still says which
        // conversation the session is on: carry only that one.
        const bound = conversationIdOfTranscript(latest)
        if (bound) {
          if (carried && carried.uuid.toLowerCase() === bound.toLowerCase()) {
            s.resumeUuid = carried.uuid
            s.resumeCwd = carried.cwd
          } else {
            delete s.resumeUuid
            delete s.resumeCwd
          }
          continue
        }
      }
      // No exact bind this run (a restored session before its first bind), or
      // one that names no conversation: a record with a target of its own
      // keeps it as it is. One with none takes the one it was last saved with,
      // but only while a binder runs and the hooks setting is on, so that the
      // session's first move would normally reach main as a bind and from then
      // on decide above. Otherwise the record keeps none, as before #104.
      if (!ownTarget && carried && deps.isBinderAvailable?.() === true && deps.isExactBindSourceActive()) {
        s.resumeUuid = carried.uuid
        s.resumeCwd = carried.cwd
      }
    } catch {
      // best-effort: leave this record exactly as it was
    }
  }
  if (deps.getUncertainProviderConversations) {
    let all: string[] | null = null
    try {
      const got = deps.getUncertainProviderConversations()
      all = Array.isArray(got) ? got.filter((id): id is string => typeof id === 'string') : null
    } catch {
      // Main cannot say: the list stays as it was.
      all = null
    }
    if (all) {
      try {
        const on = new Set(state.sessions.map((s) => (s && typeof s.resumeUuid === 'string' ? s.resumeUuid.toLowerCase() : '')).filter(Boolean))
        const kept = all.filter((id) => on.has(id.toLowerCase()))
        if (kept.length) state.codexUncertainConversations = kept
        else delete state.codexUncertainConversations
      } catch {
        // The saved sessions could not be read (ADR-009 round 2, C8): main's
        // own list, whole, never what the renderer sent.
        state.codexUncertainConversations = all
      }
    }
  }
  if (deps.getConversationRunningTimes) {
    // Main's own list, never what the renderer sent: when main cannot give
    // one (its getter throws or answers with no list), none is written and
    // the renderer's is dropped. Unlike the uncertain list above, which keeps
    // the state's own copy when its getter throws.
    let times: unknown = null
    try {
      times = deps.getConversationRunningTimes()
    } catch {
      times = null
    }
    if (Array.isArray(times) && times.length) state.conversationRunningTimes = times
    else delete state.conversationRunningTimes
  }
  return state
}
