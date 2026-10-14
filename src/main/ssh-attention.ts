// src/main/ssh-attention.ts
//
// The attention signal of a remote SSH Claude session (aicc_planning#93).
//
// A local Claude session raises the attention indicator from its hook events,
// which Claude Code posts to the app's Hooks gateway on 127.0.0.1. An SSH
// session's Claude runs on another machine and cannot reach that listener
// without a reverse tunnel, which some hosts refuse (sshd's AllowTcpForwarding)
// -- so its hooks were never written, and a remote session waiting on the user
// never raised the indicator.
//
// The remote session instead carries its attention events back over the
// session's own terminal, the way the statusline fallback does: the remote
// setup (providers/claude/ssh-shim.ts) gives Claude a small command hook that
// writes one OSC sentinel per event to the session's terminal (the tmux
// client's tty under tmux, otherwise the controlling tty or the pts an ancestor
// holds). pty-manager takes it out of the byte stream before xterm sees it,
// checks it here, and hands it to the attention source as a hook event -- the
// same consumer the local hooks feed. No forward, no listener on the remote
// host, and a host where the hook cannot reach the terminal simply shows no
// indicator.
//
// This module is a leaf (no app imports beyond types), so the remote-script
// generator, the sentinel parser in pty-manager and the attention source can
// all import it without an import cycle.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { HookEvent } from '../shared/hook-types'

/** The sentinel's opening bytes, ahead of its JSON payload. Same OSC family as
 *  the statusline's `\x1b]9999;CMSTATUS=`; ended by BEL. */
export const SSH_ATTENTION_OSC_PREFIX = '\x1b]9999;CMATTN='

// THE lists, for local and remote sessions alike. The attention source builds
// its own sets from the two below (attention-source.ts ATTENTION_NOTIFICATIONS
// and ATTENTION_CLEAR_EVENTS), and the remote setup builds the hook script and
// the remote Claude's hook entries from them (providers/claude/ssh-shim.ts), so
// a type or event added here reaches the local indicator, the remote hook and
// the remote hook registration at once. Add new ones HERE, never to a copy:
// Claude Code keeps adding user-blocking notification types (#274), and a list
// kept in two places is how a remote session stops matching a local one. A
// test pins the attention source's sets to these.

/** The events that clear the indicator: the user or the agent is acting. (The
 *  remote hook sends them only while a raise it sent is still up, see
 *  ssh-shim.ts.) */
export const REMOTE_ATTENTION_CLEAR_EVENTS: readonly string[] = Object.freeze([
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
])

/** The hook events the remote hook is registered for: Notification (which
 *  raises, for the types below) and the clearing events. Nothing else is
 *  sent. */
export const REMOTE_ATTENTION_HOOK_EVENTS: readonly string[] = Object.freeze([
  'Notification', ...REMOTE_ATTENTION_CLEAR_EVENTS,
])

/** Notification types that mean "Claude is blocked waiting on the USER"; each
 *  raises the indicator (#274). The original set was just the idle and
 *  permission prompts, but Claude Code has since added more user-blocking
 *  notifications, and a session sitting on ANY of them is the same state: it
 *  waits, silently, until the user acts.
 *    - permission_prompt      a tool use is awaiting the user's Yes/No
 *    - idle_prompt            Claude finished ~60s ago; awaiting the next prompt
 *    - agent_needs_input      a (sub)agent escalated a decision to the user,
 *                             e.g. a subagent that cannot self-approve a command
 *    - elicitation_dialog     an MCP tool is asking the user a structured question
 *    - elicitation_url_dialog ...via a URL / OAuth-style prompt
 *  Informational notifications (auth_success, agent_completed,
 *  elicitation_complete, elicitation_response) are NOT here: they do not block
 *  the user, so they neither raise nor clear, and the remote hook does not send
 *  them. */
export const REMOTE_ATTENTION_NOTIFICATIONS: readonly string[] = Object.freeze([
  'permission_prompt', 'idle_prompt', 'agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog',
])

/** A payload longer than this is not one the remote hook writes (its four
 *  short fields), so it is dropped unread. The stream parser in pty-manager
 *  (extractSshOscSentinels) also stops reading an attention sentinel past
 *  this length and shows what follows as terminal output. */
export const SSH_ATTENTION_MAX_PAYLOAD = 512

/** The session id as the remote files and the hook carry it: the same
 *  sanitising every remote per-session name uses (ssh-shim.ts safeSid). */
export function remoteSafeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** Minted once per app process and never written anywhere: the remote
 *  attention key of a spawn is derived from its nonce with it. */
const ATTENTION_KEY_SECRET = randomBytes(32)

/**
 * The attention key of the spawn whose nonce is `nonce`: what the remote setup
 * writes to the owner-only ~/.claude/ccc-attn-<sid>.key and the remote hook
 * puts in every sentinel it sends.
 *
 * The spawn's nonce itself is printed in plain text to the terminal by the
 * remote setup and the tmux staging steps (their completion lines carry it),
 * so it is not the key. The key is an HMAC of the nonce under a secret that
 * stays in this process, so the nonce alone does not give the key, and a new
 * spawn (a new nonce) gets a new key. 64 hex characters, inside the hook's
 * [A-Za-z0-9]{1,128} check.
 *
 * What still carries the key: the remote setup script holds it, and that
 * script is typed to the remote shell base64-encoded inside one command line
 * (getRemoteSetupCommand). The remote tty echoes that line before `clear`
 * runs, so the key is in the terminal stream one base64 decode away, and the
 * remote shell's or tmux's history can keep the line. Like the 0600 key file,
 * those are open to the same remote user only. No printed line carries the key
 * in plain text.
 */
export function remoteAttentionKey(nonce: string): string {
  return createHmac('sha256', ATTENTION_KEY_SECRET).update('ccc-ssh-attention-key\0' + nonce).digest('hex')
}

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * The hook event a sentinel payload stands for, or null when it is not one
 * this session's own remote hook wrote.
 *
 * The payload is lifted out of an SSH byte stream, so the remote decides what
 * is in it. It is taken only when it carries THIS spawn's attention key
 * (remoteAttentionKey of the spawn's nonce, written to the remote in an
 * owner-only file by this connection's setup, and new for every spawn) and
 * names THIS session. A sentinel made from text printed in plain into the
 * terminal (a file, a build log, another program, or the setup's own
 * completion line with its nonce) does not carry that key, so it can neither
 * raise nor clear the indicator, for this session or any other. (The typed
 * setup command does carry the key, base64-encoded; see remoteAttentionKey
 * for who can read that.) Only the four
 * event names and the five raising notification types are accepted; the event
 * built here carries nothing else.
 */
export function parseSshAttentionPayload(
  json: string,
  sessionId: string,
  nonce: string | undefined,
  now: number = Date.now(),
): HookEvent | null {
  if (typeof nonce !== 'string' || nonce.length === 0) return null
  if (typeof json !== 'string' || json.length === 0 || json.length > SSH_ATTENTION_MAX_PAYLOAD) return null
  let v: unknown
  try { v = JSON.parse(json) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const { s, n, e, t } = v as Record<string, unknown>
  if (typeof n !== 'string' || !sameKey(n, remoteAttentionKey(nonce))) return null
  if (s !== remoteSafeSessionId(sessionId)) return null
  if (typeof e !== 'string' || !REMOTE_ATTENTION_HOOK_EVENTS.includes(e)) return null
  if (e === 'Notification') {
    if (typeof t !== 'string' || !REMOTE_ATTENTION_NOTIFICATIONS.includes(t)) return null
    return { sessionId, event: e, payload: { notification_type: t }, ts: now }
  }
  return { sessionId, event: e, payload: {}, ts: now }
}

/** Where a remote attention event goes: the attention source registers itself
 *  here (startAttentionSource). Null until then, and in tests that do not. */
let sink: ((e: HookEvent) => void) | null = null

/** Register (or, with null, drop) the consumer of remote attention events. */
export function setRemoteAttentionSink(fn: ((e: HookEvent) => void) | null): void {
  sink = fn
}

/** Hand one checked remote attention event to the consumer. Never throws: a
 *  consumer fault must not break the terminal stream it was parsed from. */
export function deliverRemoteAttention(e: HookEvent): void {
  try { sink?.(e) } catch { /* the indicator is best-effort; the stream is not */ }
}
