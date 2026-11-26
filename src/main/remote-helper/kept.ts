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
 * shapes with section 1.1's protocol.ts readRecord and readListing, which
 * refuse every other mix.
 *
 * List mode is asked once per added machine at start-up and when the Machines
 * page opens (no daemon, no polling), and for a left-running entry's liveness;
 * End goes to one holder over a link of its own. The same exec (scripts.ts
 * `sessions`, section 6.3) removes the session folders whose holder is gone
 * and keeps a running one's: a folder a quit left goes at the next start, with
 * no exec added to the quit.
 *
 * This file imports nothing of Electron.
 */
import { readListing, type HolderRecord } from '../session-helper/protocol'
import type { RemoteKeptSession, RemoteMachineSessions } from '../../shared/remote-machines'
import type { RemoteMachineRecord } from './machines'
import { LABEL_RE } from './scripts'
import { afterHashLine, newNonce, notStartedLogLine, readHashLine, readScriptResult, runScript, sshFailure, type SshRunner } from './ssh-exec'

/** Whether a holder runs until it is ended (its record's `lifetime`), not by an away clock. */
export const untilEnded = (r: HolderRecord): boolean => r.lifetime === 'until-ended'

/** What list mode on one machine needs. */
export interface KeptDeps {
  runner: SshRunner
  installId: string
  log: (message: string) => void
}

/** One machine's sessions by list mode, or why they were not read. */
export type KeptListing = { ok: true; sessions: HolderRecord[] } | { ok: false; why: string }

/** List mode on machine `m`, through the launcher's hash check, and the
 *  session folders whose holder is gone removed (6.3; one log line when any
 *  went). */
export async function listKept(d: KeptDeps, m: RemoteMachineRecord): Promise<KeptListing> {
  const target = { host: m.host, port: m.port, user: m.user }
  const nonce = newNonce()
  let r
  try {
    r = await runScript(d.runner, target, 'sessions', [nonce, m.did, d.installId, m.helper.folder, m.helper.sha256])
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
  const listing = line ? readListing(line, 'unix') : null
  if (!listing) return { ok: false, why: `the session helper on ${m.host} did not list its sessions` }
  const swept = readScriptResult(r.stdout, nonce)?.values.get('swept') ?? ''
  if (/^[1-9][0-9]{0,5}$/.test(swept)) d.log(`[remote-helper] ${m.host}: removed ${swept} session folder(s) whose holder is gone`)
  return { ok: true, sessions: listing.sessions }
}

/** A listed session, as the machine's card shows it. The holder's label is
 *  the app session id it was started for (scripts.ts holderLabel), when it
 *  is one. */
export function keptView(r: HolderRecord): RemoteKeptSession {
  const label = r.label
  return {
    sid: r.session,
    appSessionId: LABEL_RE.test(label) && label !== 'tab' ? label : null,
    untilEnded: untilEnded(r),
    attached: r.attached,
    running: r.child === 'running',
  }
}

/** One machine's card answer from its listing. */
export function machineSessions(did: string, l: KeptListing): RemoteMachineSessions {
  return l.ok ? { did, ok: true, sessions: l.sessions.map(keptView) } : { did, ok: false, why: l.why }
}
