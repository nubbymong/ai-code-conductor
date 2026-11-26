/**
 * The sessions the session helper keeps on a machine (2.1.3-beta.19 section
 * 1.2; ADR-030 S25's second session kind, D13; protocol change 14).
 *
 * A holder is one of two kinds. A plain SSH tab's has today's away clock (two
 * minutes, scripts.ts REMOTE_AWAY_SECS) and today's record. An SSH Persistent
 * tab's runs until it is ended (`hold --until-ended`): it ends with its CLI,
 * at term.end, or with the host, and its record says so with
 * `"lifetime":"until-ended"` and `"away":null` (section 1.1's contract with
 * this section). List mode prints both kinds; the app reads exactly those two
 * shapes, each other field as strictly as protocol.ts readRecord reads it.
 *
 * Read here, not in protocol.ts, while section 1.1 changes protocol.ts in its
 * own branch: an until-ended record is checked by readRecord as the clock
 * shape it is otherwise, so the same fields pass the same checks before and
 * after 1.1's readRecord takes the second shape itself.
 *
 * List mode is asked once per added machine at start-up and when the Machines
 * page opens (no daemon, no polling), and for a left-running entry's liveness;
 * End goes to one holder over a link of its own.
 *
 * This file imports nothing of Electron.
 */
import { readRecord, type HolderRecord } from '../session-helper/protocol'
import type { RemoteKeptSession, RemoteMachineSessions } from '../../shared/remote-machines'
import type { RemoteMachineRecord } from './machines'
import { LABEL_RE } from './scripts'
import { afterHashLine, newNonce, notStartedLogLine, readHashLine, runScript, sshFailure, type SshRunner } from './ssh-exec'

/** A holder's kind, as its record says it. */
export type HolderLifetime = 'clock' | 'until-ended'

/** A holder's record, and its kind. */
export interface KeptRecord {
  record: HolderRecord
  lifetime: HolderLifetime
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** One record, read strictly: today's clock shape, or the until-ended shape
 *  (today's fields with `away` null, and `lifetime` "until-ended"). Any other
 *  mix (a lifetime with an away clock, another lifetime word, a null away
 *  with no lifetime) is refused: null. */
export function readHolderRecord(value: unknown): KeptRecord | null {
  if (!isObject(value)) return null
  if (!('lifetime' in value)) {
    const r = readRecord(value, 'unix')
    return r ? { record: r, lifetime: 'clock' } : null
  }
  if (value.lifetime !== 'until-ended' || value.away !== null) return null
  const { lifetime: _lifetime, ...rest } = value
  const r = readRecord({ ...rest, away: 1 }, 'unix')
  if (!r) return null
  return { record: { ...r, away: null } as unknown as HolderRecord, lifetime: 'until-ended' }
}

/** List mode's one line (its fields in order), every record read by
 *  readHolderRecord; null when any of it does not read. */
export function readHolderListing(line: string): { sessions: KeptRecord[]; removed: number; skipped: number } | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(v) || JSON.stringify(Object.keys(v)) !== JSON.stringify(['v', 'sessions', 'removed', 'skipped'])) return null
  const whole = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0
  if (v.v !== 1 || !Array.isArray(v.sessions) || !whole(v.removed) || !whole(v.skipped)) return null
  const sessions: KeptRecord[] = []
  for (const s of v.sessions) {
    const r = readHolderRecord(s)
    if (!r) return null
    sessions.push(r)
  }
  return { sessions, removed: v.removed, skipped: v.skipped }
}

/** What list mode on one machine needs. */
export interface KeptDeps {
  runner: SshRunner
  installId: string
  log: (message: string) => void
}

/** One machine's sessions by list mode, or why they were not read. */
export type KeptListing = { ok: true; sessions: KeptRecord[] } | { ok: false; why: string }

/** List mode on machine `m`, through the launcher's hash check. */
export async function listKept(d: KeptDeps, m: RemoteMachineRecord): Promise<KeptListing> {
  const target = { host: m.host, port: m.port, user: m.user }
  const nonce = newNonce()
  let r
  try {
    r = await runScript(d.runner, target, 'list', [nonce, m.did, d.installId, m.helper.folder, m.helper.sha256])
  } catch (err) {
    return { ok: false, why: (err as Error).message }
  }
  if (r.notStarted) d.log(notStartedLogLine(m.host, r.stderr))
  const failed = sshFailure(r)
  if (failed) return { ok: false, why: `${m.host} could not be reached: ${failed}` }
  const hash = readHashLine(r.stdout, nonce)
  if (!hash) return { ok: false, why: `${m.host} did not answer the session helper` }
  if (hash.state !== 'ok') return { ok: false, why: `the session helper file on ${m.host} did not pass its hash check (${hash.state}); press Check` }
  const line = afterHashLine(r.stdout, nonce).split(/\r?\n/).find((l) => l.startsWith('{'))
  const listing = line ? readHolderListing(line) : null
  if (!listing) return { ok: false, why: `the session helper on ${m.host} did not list its sessions` }
  return { ok: true, sessions: listing.sessions }
}

/** A listed session, as the machine's card shows it. The holder's label is
 *  the app session id it was started for (scripts.ts holderLabel), when it
 *  is one. */
export function keptView(k: KeptRecord): RemoteKeptSession {
  const label = k.record.label
  return {
    sid: k.record.session,
    appSessionId: LABEL_RE.test(label) && label !== 'tab' ? label : null,
    untilEnded: k.lifetime === 'until-ended',
    attached: k.record.attached,
    running: k.record.child === 'running',
  }
}

/** One machine's card answer from its listing. */
export function machineSessions(did: string, l: KeptListing): RemoteMachineSessions {
  return l.ok ? { did, ok: true, sessions: l.sessions.map(keptView) } : { did, ok: false, why: l.why }
}
