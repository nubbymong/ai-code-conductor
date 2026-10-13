// Allow Multi Spawn: THE rule, and the words for it, shared by the renderer's
// launch surfaces and main's launch gate (P3.13, row 72).
//
// A saved config that is not a Multi Spawn config runs ONE copy at a time: it
// cannot start while another session of it is live. The renderer asks the rule
// so a button can say why it is disabled (hooks/useLaunchConfig.ts); main asks
// it at pty:spawn (src/main/launch-one-at-a-time.ts), so a renderer that forgot
// to ask, a stale render or a second path cannot start the second copy either.
// One definition, so the two cannot drift.

/**
 * True when a launch is refused: another copy of the config is live and the
 * config is not a Multi Spawn config.
 *
 * Deliberately `!== true`: the stored field is tri-state (undefined: never
 * chosen; false: declined; true: on), and every state but `true` -- a
 * hand-edited "yes" included -- runs one at a time. Only the startup migration
 * tells undefined from false (renderer/utils/multiSpawn.ts).
 */
export function isOneAtATimeBlocked(allowMultiSpawn: unknown, otherLiveCopies: number): boolean {
  return otherLiveCopies > 0 && allowMultiSpawn !== true
}

/** Popover copy for a launch refused by the rule (bold head + body). */
export function alreadyRunningCopy(label: string): { headline: string; body: string } {
  return {
    headline: `${label} is already running.`,
    body: "It isn't a Multi Spawn config, so it runs one at a time.",
  }
}

/** What main says when it refuses a launch for this rule: the popover's words,
 *  then what to do. A terminal tab shows it as "Not started. <this, without its
 *  last full stop>, then Restart this tab." (refusedTabText). */
export function alreadyRunningRefusalMessage(label: string): string {
  const copy = alreadyRunningCopy(label)
  return `${copy.headline} ${copy.body} Close the other copy, or turn on Allow Multi Spawn for it.`
}

/** What main says when it refuses the partner shell of an SSH session it
 *  cannot place beside a running session of its own (#86): the session has
 *  not started in this run, or has started since with another connection. A
 *  terminal tab shows it as "Not started. <this, without its last full stop>,
 *  then Restart this tab." (refusedTabText). */
export const PARTNER_NEEDS_SESSION_MESSAGE = 'The partner shell opens on the host once its session is running. Start or restart the session.'

/** The partner terminal of a session is a plain shell started under its own
 *  PTY id, `<session id>` plus this: the renderer names it (App.tsx,
 *  useRestartSession.ts, ptyTracker.ts) and main recognises it, so the shell
 *  of a config's session is never counted as another copy of the config. */
export const PARTNER_PTY_SUFFIX = '-partner'

export function isPartnerPtyId(sessionId: string): boolean {
  return sessionId.endsWith(PARTNER_PTY_SUFFIX)
}

/** The session a partner terminal's PTY id belongs to, or null for an id that
 *  is not a partner's. */
export function parentOfPartnerPtyId(ptyId: string): string | null {
  if (!isPartnerPtyId(ptyId)) return null
  const parent = ptyId.slice(0, -PARTNER_PTY_SUFFIX.length)
  return parent === '' ? null : parent
}

/** The ssh fields a session's partner shell does NOT take from the session
 *  (#86): no post-connect command and no container runtime (the partner is a
 *  plain shell on the host itself), no reconnect flag (a partner never
 *  reattaches), and its own persistence setting, which is always off. */
const NOT_THE_PARTNERS = new Set(['postCommand', 'runtime', 'dockerContainer', 'reconnect', 'detachable'])

/** What every ssh block has; the rest is carried as it is. */
interface SshBlockLike {
  host: string
  port: number
  username: string
  remotePath: string
}

export type PartnerSsh<T extends SshBlockLike> =
  Omit<T, 'postCommand' | 'runtime' | 'dockerContainer' | 'reconnect' | 'detachable'> & { detachable: false }

/**
 * The ssh block the partner shell of an SSH session connects with (#86): the
 * session's own (host, port, user, remote path and every other field it has),
 * as a PLAIN connection: no post-connect command, no container runtime, and
 * persistence (tmux) off. The renderer starts the partner with exactly this
 * (components/PartnerTerminalPane.tsx), and main recognises it by exactly this
 * (launch-one-at-a-time.ts, isPartnerSshOf), so the two cannot drift.
 */
export function partnerSshOf<T extends SshBlockLike>(sessionSsh: T): PartnerSsh<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(sessionSsh)) {
    if (value === undefined || NOT_THE_PARTNERS.has(key)) continue
    out[key] = value
  }
  out.detachable = false
  return out as PartnerSsh<T>
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

/** Field for field: the same keys (a key holding undefined is no key) and the
 *  same values, nested plain objects compared the same way. Anything else (an
 *  array, a function, a class instance) never matches. */
function sameBlock(a: unknown, b: unknown): boolean {
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const keysOf = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined).sort()
  const ka = keysOf(a)
  const kb = keysOf(b)
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every((k) => {
    const x = a[k]
    const y = b[k]
    if (x !== null && typeof x === 'object') return sameBlock(x, y)
    return x === y
  })
}

/**
 * Whether `partnerSsh` is the partner block of the session whose ssh block was
 * `sessionSsh`: field for field what partnerSshOf makes of it. The only thing
 * a spawn adds on its own is the reconnect flag (TerminalView, from the tab's
 * own history; a partner has none), so a partner block saying reconnect is not
 * a partner's. Pure: main asks it of its OWN record of the session's spawn.
 */
export function isPartnerSshOf(sessionSsh: unknown, partnerSsh: unknown): boolean {
  if (!isPlainObject(sessionSsh) || !isPlainObject(partnerSsh)) return false
  if (partnerSsh.reconnect !== undefined && partnerSsh.reconnect !== false) return false
  const asked: Record<string, unknown> = { ...partnerSsh }
  delete asked.reconnect
  const s = sessionSsh
  if (typeof s.host !== 'string' || typeof s.port !== 'number' || typeof s.username !== 'string' || typeof s.remotePath !== 'string') return false
  return sameBlock(partnerSshOf(s as unknown as SshBlockLike), asked)
}
