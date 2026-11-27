/**
 * Sign in on this machine (2.1.3-beta.20 section 3; ADR-030 D7, Standard
 * login on a remote machine): the accounts of this computer as they are
 * signed in on each Linux machine added on the Machines page.
 *
 * An account signs in on a machine in a folder of its own there,
 * `~/.aicc/accounts/<profile id>/` (scripts.ts `account`: owner-only, the
 * app's marker, links into `~/.claude` for everything but the sign-in), by
 * the CLI's own sign-in in a helper tab (section 3.1.4). The machine's own
 * sign-in (`~/.claude`) counts as an account's when it names that account
 * (section 3.1.5). One exec reads every sign-in there (`accounts`, through
 * the helper's field mode, which prints only the fields on its list: the
 * account, plan, tier and expiry, never a token), at Check, at the start-up
 * list, at the end of a sign-in tab and at each launch of a helper tab on an
 * account (section 3.1.6), and before and after a sign-out (to decide, then
 * to show the result); nothing polls. An attach to a session kept for a tab
 * reads too, for display only: it never stops the attach. What a read found is kept per
 * machine for the run, and each account's state is worked out from it and
 * this computer's accounts when asked (`machineAccounts`), so an account
 * added since reads right without a new exec.
 *
 * A launch on an account (section 3.1.7, accountBinding): signed in in its
 * own folder, the CLI runs with that folder as its config folder; signed in
 * as the machine's own sign-in, on the machine's own folder; otherwise
 * nothing is spawned and the tab's notice says why (HostLaunchRefusal). A
 * folder signed in as another account is marked, never used.
 *
 * Sign out (section 3.1.8, signOutOnMachine): the CLI's own sign-out in the
 * account's folder, then that folder goes, and only it; the machine's own
 * sign-in only after the user confirmed it (Q5), and its folder stays.
 *
 * Everything a machine reports is untrusted display text: each value is
 * checked here before it lands in a shape, and none is put on a command line.
 * This file imports nothing of Electron.
 */
import type { RemoteAccounts } from '../providers/types'
import type { HostAccountSignIn, HostAccountsState, HostAdoptResult, HostLaunchRefusal, HostMachineAccounts, HostSignInFacts, HostSignInState } from '../../shared/host-accounts'
import { HOST_ACCOUNTS_FOLDER, NOT_HELD_ACCOUNT, folderOfStart, hostAccountNamer, joinNames, sentenceStart } from '../../shared/host-accounts'
import { canonicaliseEmail } from '../../shared/account-chip-color'
import { stripSpoofableText } from '../../shared/safe-text'
import { ACCOUNT_PROFILE_RE, HOST_READ_MAX } from './scripts'
import { afterHashLine, markedLines, newNonce, notStartedLogLine, readHashLine, readScriptResult, runScript, sshFailure, type SshRunner, type SshTarget } from './ssh-exec'
import { refusalText, type RemoteMachineRecord } from './machines'

/** Where an exec runs, and where its log lines go. */
export interface HostAccountsContext {
  runner: SshRunner
  installId: string
  log: (message: string) => void
  now?: () => number
}

/** One of this computer's accounts, as the provider package lists it. */
export type HostProfile = { id: string; accountEmail?: string; name?: string }

/** What one read found: the machine's own sign-in (null: none), each
 *  account folder's there that holds this install's marker, by profile id,
 *  and the folders the app on another computer made there (`elsewhere`:
 *  not read, never touched). */
export interface SignInsRead {
  own: HostSignInFacts | null
  folders: Map<string, HostSignInFacts>
  elsewhere: Set<string>
  /** Round 2 (R1): the folders among `folders` with the marker of the
   *  builds before the install id was in it. */
  old: Set<string>
}

/** The machine a script runs on, as ssh reaches it. */
const targetOf = (m: Pick<RemoteMachineRecord, 'host' | 'port' | 'user'>): SshTarget => ({ host: m.host, port: m.port, user: m.user })

/** A control or format character (a bidi override included), anywhere. */
const UNSAFE_RE = /[\p{Cc}\p{Cf}]/u
/** An account the way a sign-in names it: one address, no space. */
const IDENTITY_RE = /^[^\s@]{1,128}@[^\s@]{1,253}$/
/** A plan or tier word. */
const WORD_RE = /^[A-Za-z0-9_.-]{1,64}$/
/** The largest integer the field mode prints: 2^53 - 1. */
const MAX_INTEGER = Number.MAX_SAFE_INTEGER
/** The longest line a field read prints that is read: 8 keys of 1 KiB, with room. */
const FIELD_LINE_MAX = 16 * 1024

/** The account a sign-in names, when it reads as one: an address with no
 *  space, control or format character, at most 254 characters. */
export function identityOf(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 254 && IDENTITY_RE.test(v) && !UNSAFE_RE.test(v) ? v : null
}
const wordOf = (v: unknown): string | null => (typeof v === 'string' && WORD_RE.test(v) ? v : null)
const integerOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_INTEGER ? v : null)

/** One sign-in's facts from its two field reads (each the helper's object,
 *  or null when its file was not read). `credentials`: its credentials file
 *  names a sign-in (an expiry). */
export function factsOf(id: Record<string, unknown> | null, cr: Record<string, unknown> | null, keys: RemoteAccounts['keys']): HostSignInFacts {
  const expiresAt = integerOf(cr?.[keys.expiresAt])
  return {
    identity: identityOf(id?.[keys.identity]),
    plan: wordOf(cr?.[keys.plan]),
    tier: wordOf(cr?.[keys.tier]),
    expiresAt,
    credentials: expiresAt !== null,
  }
}

/** One field read's object, or null for none: the line after its header,
 *  when it is one JSON object of at most FIELD_LINE_MAX characters. */
function objectLine(line: string | undefined): Record<string, unknown> | null {
  if (!line || !line.startsWith('{') || line.length > FIELD_LINE_MAX) return null
  try {
    const v: unknown = JSON.parse(line)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * What the `accounts` exec printed after the launcher's hash line: after
 * each `AICC-FIELD <nonce> <own or profile id> <id or cr>` header, the
 * helper's object for that file, or nothing. A slot that is not `own` or a
 * profile id of the app's shape, a part that is not `id` or `cr`, and a
 * header seen twice are left out. The machine's own sign-in is null when
 * neither of its files named anything. `AICC-FIELD <nonce> <profile id>
 * elsewhere`: that folder is another computer's (its marker names another
 * install), and nothing of it is read.
 */
export function readSignIns(stdout: string, nonce: string, keys: RemoteAccounts['keys']): SignInsRead {
  const prefix = `AICC-FIELD ${nonce} `
  const lines = afterHashLine(stdout, nonce).split(/\r?\n/)
  const got = new Map<string, { id?: Record<string, unknown> | null; cr?: Record<string, unknown> | null }>()
  const elsewhere = new Set<string>()
  const old = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(prefix)) continue
    const [slot, part, more] = lines[i].slice(prefix.length).split(' ')
    if (more === undefined && part === 'elsewhere' && ACCOUNT_PROFILE_RE.test(slot ?? '')) { elsewhere.add(slot); continue }
    if (more === undefined && part === 'old' && ACCOUNT_PROFILE_RE.test(slot ?? '')) { old.add(slot); continue }
    if (more !== undefined || (slot !== 'own' && !ACCOUNT_PROFILE_RE.test(slot ?? '')) || (part !== 'id' && part !== 'cr')) continue
    const entry = got.get(slot) ?? {}
    if (entry[part] !== undefined) continue
    entry[part] = objectLine(lines[i + 1])
    got.set(slot, entry)
  }
  const ownRead = got.get('own')
  const own = ownRead ? factsOf(ownRead.id ?? null, ownRead.cr ?? null, keys) : null
  const folders = new Map<string, HostSignInFacts>()
  for (const [slot, e] of got) if (slot !== 'own' && !elsewhere.has(slot)) folders.set(slot, factsOf(e.id ?? null, e.cr ?? null, keys))
  for (const slot of old) if (!folders.has(slot)) old.delete(slot)
  return { own: own && (own.identity !== null || own.credentials) ? own : null, folders, elsewhere, old }
}

/** The two emails name the same account (compared as the account chips compare them). */
const sameAccount = (email: string | undefined, identity: string | null): boolean =>
  !!email && !!identity && canonicaliseEmail(email) === canonicaliseEmail(identity)

/**
 * One account's state on a machine (sections 3.1.4 and 3.1.5) from a read:
 * - its own folder signed in (credentials there) as this account:
 *   `signed-in-here`; as another account, or as one the folder does not
 *   name (so it cannot be told to be this one): `someone-else`, marked and
 *   never used;
 * - else the machine's own sign-in as this account: `machine-own`;
 * - else `not-signed-in`.
 * An account this computer knows no email for is never matched: its folder
 * signed in reads `someone-else`, and the machine's own sign-in is not taken
 * for it.
 */
export function signInStateOf(email: string | undefined, folder: HostSignInFacts | undefined, own: HostSignInFacts | null): Pick<HostAccountSignIn, 'state' | 'facts' | 'folder'> {
  if (folder?.credentials) {
    return sameAccount(email, folder.identity)
      ? { state: 'signed-in-here', facts: folder, folder: true }
      : { state: 'someone-else', facts: folder, folder: true }
  }
  if (own?.credentials && sameAccount(email, own.identity)) return { state: 'machine-own', facts: own, folder: !!folder }
  return { state: 'not-signed-in', facts: null, folder: !!folder }
}

/** What the last read of each machine found, or why it did not answer, by
 *  device id, for the run; and the last read that answered, for Remove's
 *  account list when the machine no longer answers. */
const lastRead = new Map<string, { at: number; read: SignInsRead } | { at: number; why: string }>()
const lastAnswer = new Map<string, { at: number; read: SignInsRead }>()
let listener: ((m: HostMachineAccounts) => void) | null = null

/** Where each read's result goes (the renderer's push), or null for nowhere. */
export function setHostAccountsListener(fn: ((m: HostMachineAccounts) => void) | null): void {
  listener = fn
}

/** A machine removed: its reads are forgotten. */
export function forgetHostAccounts(did: string): void {
  lastRead.delete(did)
  lastAnswer.delete(did)
}

/** For tests: every read forgotten. */
export function _resetHostAccountsForTest(): void {
  lastRead.clear()
  lastAnswer.clear()
  listener = null
}

/**
 * One machine's accounts from its last read and this computer's accounts
 * now (`profiles`, in their order; an id of another shape is left out).
 * Never read this run: every account `not-read`, `readAt` null. A read that
 * did not answer: every account `not-read`, with `why`; an account's folder
 * as the last read that answered found it. `others`: this install's folders
 * of accounts this computer no longer holds; `elsewhere` (2.1.3-beta.20 fix
 * round, MAJOR-1): the folders the app on another computer made there,
 * which this computer never signs out or removes.
 */
export function machineAccounts(did: string, profiles: readonly HostProfile[]): HostMachineAccounts {
  const accounts = profiles.filter((p) => ACCOUNT_PROFILE_RE.test(p.id))
  const held = new Set(accounts.map((p) => p.id))
  const last = lastRead.get(did)
  if (!last) return { did, readAt: null, ok: false, own: null, accounts: accounts.map((p) => ({ profileId: p.id, state: 'not-read', facts: null, folder: false })), others: [], elsewhere: [], mayBeEarlierInstall: false, oldMarker: [] }
  if ('why' in last) {
    const answered = lastAnswer.get(did)?.read
    const known = answered?.folders
    return {
      did, readAt: last.at, ok: false, why: last.why, own: null,
      accounts: accounts.map((p) => ({ profileId: p.id, state: 'not-read', facts: null, folder: known?.has(p.id) ?? false })),
      ...foldersElsewhere(answered, held),
    }
  }
  const { own, folders } = last.read
  return {
    did, readAt: last.at, ok: true, own,
    accounts: accounts.map((p) => ({ profileId: p.id, ...signInStateOf(p.accountEmail, folders.get(p.id), own) })),
    ...foldersElsewhere(last.read, held),
  }
}

/**
 * A read's folders that are not one of this computer's accounts' (round 2,
 * R1): `others`, this install's folders of accounts it no longer holds;
 * `oldMarker`, folders with the marker of the builds before the install id
 * was in it, for ids this computer does not hold (one for an id it holds is
 * its own, and reads as that account's); `elsewhere`, another install's,
 * with `mayBeEarlierInstall` when every one of them is named by an id this
 * computer holds (its own from an earlier install whose id was lost, most
 * likely: Adopt is offered, on the user's choice only).
 */
export function foldersElsewhere(read: SignInsRead | undefined, held: ReadonlySet<string>): Pick<HostMachineAccounts, 'others' | 'elsewhere' | 'mayBeEarlierInstall' | 'oldMarker'> {
  if (!read) return { others: [], elsewhere: [], mayBeEarlierInstall: false, oldMarker: [] }
  const elsewhere = [...read.elsewhere].sort()
  return {
    others: [...read.folders.keys()].filter((id) => !held.has(id) && !read.old.has(id)).sort(),
    elsewhere,
    mayBeEarlierInstall: elsewhere.length > 0 && elsewhere.every((id) => held.has(id)),
    oldMarker: [...read.old].filter((id) => !held.has(id)).sort(),
  }
}

/** Every machine named, as machineAccounts gives each (MACHINES_REMOTE_ACCOUNTS: no exec). */
export function hostAccountsState(dids: readonly string[], profiles: readonly HostProfile[]): HostAccountsState {
  return { machines: dids.map((did) => machineAccounts(did, profiles)) }
}

/** The values the `accounts` script takes after its nonce, device id and install id. */
export function accountsValues(m: Pick<RemoteMachineRecord, 'helper'>, via: RemoteAccounts): string[] {
  return [
    m.helper.folder, m.helper.sha256,
    via.files.own.identity, via.files.own.credentials, via.files.folder.identity, via.files.folder.credentials,
    via.keys.identity, [via.keys.plan, via.keys.tier, via.keys.expiresAt].join(','),
  ]
}

/**
 * Section 3.1.6: one exec reads every sign-in on machine `m` (the `accounts`
 * script), records what it found (or why it did not answer) for the run,
 * and tells the listener the machine's accounts. Never throws.
 */
export async function readMachineAccounts(ctx: HostAccountsContext, m: RemoteMachineRecord, via: RemoteAccounts): Promise<HostMachineAccounts> {
  const at = ctx.now?.() ?? Date.now()
  const answered = await runAccountsRead(ctx, m, via)
  if (answered.ok) {
    lastRead.set(m.did, { at, read: answered.read })
    lastAnswer.set(m.did, { at, read: answered.read })
  } else {
    lastRead.set(m.did, { at, why: answered.why })
    ctx.log(`[remote-helper] the accounts on ${m.host} were not read (${answered.why})`)
  }
  let profiles: readonly HostProfile[] = []
  try {
    profiles = await via.profiles()
  } catch (err) {
    ctx.log(`[remote-helper] this computer's accounts did not read (${(err as Error).message})`)
  }
  const out = machineAccounts(m.did, profiles)
  try { listener?.(out) } catch { /* the listener's own */ }
  return out
}

async function runAccountsRead(ctx: HostAccountsContext, m: RemoteMachineRecord, via: RemoteAccounts): Promise<{ ok: true; read: SignInsRead } | { ok: false; why: string }> {
  try {
    const nonce = newNonce()
    const r = await runScript(ctx.runner, targetOf(m), 'accounts', [nonce, m.did, ctx.installId, ...accountsValues(m, via)])
    if (r.notStarted) ctx.log(notStartedLogLine(m.host, r.stderr))
    const failed = sshFailure(r)
    if (failed) return { ok: false, why: `${m.host} could not be reached: ${failed}` }
    const result = readScriptResult(r.stdout, nonce)
    if (result && !result.ok) return { ok: false, why: `${m.host} did not read its accounts: ${refusalText(result.refused)}; press Check on the Machines page` }
    const hash = readHashLine(r.stdout, nonce)
    if (!hash) return { ok: false, why: 'the session helper there did not answer; press Check on the Machines page' }
    if (hash.state !== 'ok') return { ok: false, why: `the session helper file there did not pass its hash check (${hash.state}); press Check on the Machines page` }
    if (!result) return { ok: false, why: 'the read there did not finish' }
    return { ok: true, read: readSignIns(r.stdout, nonce, via.keys) }
  } catch (err) {
    return { ok: false, why: (err as Error).message }
  }
}

/** An account's folder on machine `m`: absolute, under the home folder its check read. */
export function accountFolder(m: Pick<RemoteMachineRecord, 'home'>, profileId: string): string {
  if (!ACCOUNT_PROFILE_RE.test(profileId)) throw new Error('that is not an account id the app makes')
  return `${m.home.replace(/\/+$/, '')}/${HOST_ACCOUNTS_FOLDER}/${profileId}`
}

/** How a launch on an account runs on a machine (section 3.1.7): in the
 *  account's own folder there, on the machine's own sign-in, or not at all. */
export type AccountBinding =
  | { via: 'folder'; configDir: string }
  | { via: 'own' }
  | { refused: HostLaunchRefusal }

/** The account aliases the app's settings hold (Settings, Accounts: a name
 *  for an account, keyed by its email), as the renderer names accounts by
 *  them; undefined when there are none. Only string values are kept. */
export function accountAliasesOf(settings: Readonly<Record<string, unknown>> | null | undefined): Record<string, string> | undefined {
  const raw = settings?.accountAliases
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = Object.create(null)
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v
  return out
}

/**
 * How main's answers name an account by its profile id. Final review round 2
 * (F2-1): by the renderer's rule, since the Machines page shows main's
 * answers word for word: its name on this computer, else its alias
 * (`aliases`, accountAliasesOf), else its email, else NAMELESS_ACCOUNT, for
 * which a sentence it starts takes a capital (sentenceStart). Round 3
 * (F3-1): the one shared namer (hostAccountNamer), so an id this computer
 * does not hold reads NOT_HELD_ACCOUNT, never its profile id.
 */
export function accountNamer(profiles: readonly HostProfile[], aliases?: Readonly<Record<string, string>>): (profileId: string) => string {
  const nameOf = hostAccountNamer(profiles, aliases)
  return (id) => stripSpoofableText(nameOf(id), 120)
}

/**
 * Section 3.1.7: the config's account decides. `accounts` is the machine's
 * read at this launch. Signed in in its own folder: the folder. Signed in as
 * the machine's own sign-in: the machine's own folder. Otherwise the tab
 * starts nothing, and the refusal says why and lists the accounts that are
 * signed in there (the notice's other choice). `profiles` null: this
 * computer's accounts did not read, which the refusal says as such
 * (2.1.3-beta.20 fix round, NIT-11), never as an account gone. `aliases`:
 * the app's account aliases (accountAliasesOf), so the account is named as
 * the renderer names it (final review round 2, F2-1).
 */
export function accountBinding(accounts: HostMachineAccounts, profileId: string, m: Pick<RemoteMachineRecord, 'home' | 'did'>, name: string, profiles: readonly HostProfile[] | null, aliases?: Readonly<Record<string, string>>): AccountBinding {
  const a = accounts.accounts.find((x) => x.profileId === profileId)
  if (a?.state === 'signed-in-here') return { via: 'folder', configDir: accountFolder(m, profileId) }
  if (a?.state === 'machine-own') return { via: 'own' }
  const who = accountNamer(profiles ?? [], aliases)(profileId)
  const Who = sentenceStart(who)
  // "Work's folder"; the app's own words for an account take no possessive.
  const whoseFolder = folderOfStart(who)
  const signedInThere = accounts.accounts.filter((x) => x.state === 'signed-in-here' || x.state === 'machine-own').map((x) => x.profileId)
  const base = { did: m.did, machineName: name, profileId, signedInThere }
  if (profiles === null) {
    return { refused: { ...base, state: 'not-read', text: 'This computer\'s accounts could not be read, so this tab started nothing. Restart it to try again.' } }
  }
  if (!accounts.ok) {
    return { refused: { ...base, state: 'not-read', text: `The accounts on ${name} could not be read (${accounts.why ?? 'no answer'}), so this tab started nothing. Press Check on the Machines page, then Restart.` } }
  }
  // Final review round 3 (F3-1): named as every surface names an account this
  // computer does not hold, never by its profile id; nothing here signs it in.
  if (!profiles.some((p) => p.id === profileId)) {
    return { refused: { ...base, state: 'not-signed-in', text: `This tab is on ${NOT_HELD_ACCOUNT}, so it started nothing. Start it on an account that is signed in on ${name}.` } }
  }
  if (a?.state === 'someone-else') {
    const identity = a.facts?.identity ?? null
    const as = identity ? `as ${stripSpoofableText(identity, 254)}, another account` : 'as an account it does not name'
    return { refused: { ...base, state: 'someone-else', ...(identity ? { identity } : {}), text: `${Who} on ${name} is signed in ${as}, so this tab started nothing. Sign it out on the Machines page, then sign it in again as ${who}.` } }
  }
  // Phase 5 round 3 (R3-1): one rule for Adopt, here, in Adopt itself and on
  // every renderer surface: only while EVERY folder there with another
  // install's mark is for one of this computer's accounts
  // (mayBeEarlierInstall). One for an account it does not hold shows another
  // computer's app uses that login, so this one is taken as that computer's.
  if (accounts.elsewhere?.includes(profileId) && accounts.mayBeEarlierInstall === true) {
    return { refused: { ...base, state: 'not-signed-in', adoptable: true, text: `${whoseFolder} on ${name} carries another install's mark, so this tab started nothing. It may be this computer's own from an earlier install of the app: if so, choose Adopt on the machine's card on the Machines page; if it is the app's on another computer, start this tab on an account signed in there.` } }
  }
  if (accounts.elsewhere?.includes(profileId)) {
    return { refused: { ...base, state: 'not-signed-in', text: `${whoseFolder} on ${name} is used by the app on another computer, so this tab started nothing. Start this tab on an account signed in there, or sign ${who} in there from that computer.` } }
  }
  return { refused: { ...base, state: 'not-signed-in', text: `${Who} is not signed in on ${name}, so this tab started nothing. Sign it in on that machine from the Machines page, or start this tab on an account that is signed in there.` } }
}

/** The settings copy as `account` takes it: `keep`, `0` (none) or its size,
 *  and its bytes. Throws for a copy larger than a host read can be. */
export function settingsInput(settings: string | null | 'keep'): { value: string; stdin?: Buffer } {
  if (settings === 'keep') return { value: 'keep' }
  if (settings === null || settings === '') return { value: '0' }
  const bytes = Buffer.from(settings, 'utf8')
  if (bytes.length > HOST_READ_MAX * 2) throw new Error('the account\'s settings copy is larger than the app sends')
  return { value: String(bytes.length), stdin: bytes }
}

/**
 * Section 3.1.3: the account's folder on machine `m`, made (`make`, at its
 * sign-in) or brought up to date (`refresh`, at a launch on it: it makes
 * nothing, and a folder that is not there answers `gone`): its links into
 * the CLI's own folder (the provider's links) and its settings copy. Never
 * throws.
 */
export async function prepareAccountFolder(ctx: HostAccountsContext, m: RemoteMachineRecord, via: RemoteAccounts, profileId: string, mode: 'make' | 'refresh' | 'adopt', settings: string | null | 'keep'): Promise<{ ok: true; own: string[]; adopted?: 'old' | 'elsewhere' } | { ok: false; why: string; gone?: true; refused?: string }> {
  try {
    const { value, stdin } = settingsInput(settings)
    const name = via.settingsCopy([]).name
    const nonce = newNonce()
    const values = [nonce, m.did, ctx.installId, profileId, mode, via.links.home, via.links.folders.join(','), via.links.files.join(','), name, value]
    const r = await runScript(ctx.runner, targetOf(m), 'account', values, stdin ? { stdin } : {})
    if (r.notStarted) ctx.log(notStartedLogLine(m.host, r.stderr))
    const failed = sshFailure(r)
    if (failed) return { ok: false, why: `${m.host} could not be reached: ${failed}` }
    const result = readScriptResult(r.stdout, nonce)
    if (!result) return { ok: false, why: `${m.host} did not answer the session helper's write of the account's folder` }
    if (!result.ok) return { ok: false, why: `the account's folder on ${m.host} was not ${mode === 'make' ? 'made' : mode === 'adopt' ? 'adopted' : 'brought up to date'}: ${refusalText(result.refused)}`, ...(result.refused ? { refused: result.refused } : {}) }
    if (result.values.get('gone') === 'yes') return { ok: false, why: `the account's folder on ${m.host} is not there any more`, gone: true }
    // `own <name>`: a real folder or file where a link goes, left as it is.
    const own = r.stdout.split(/\r?\n/).filter((l) => l.startsWith(`AICC-RESULT ${nonce} own `)).map((l) => l.slice(`AICC-RESULT ${nonce} own `.length))
    for (const n of own) ctx.log(`[remote-helper] ${profileId}: its folder on ${m.host} keeps its own ${stripSpoofableText(n, 128)}, not a link to ~/${via.links.home}`)
    // Round 2 (R1): its marker rewritten as this install's: one of the builds before the install id was in it, or (Adopt) another install's.
    const adopted = result.values.get('adopted')
    if (adopted === 'old' || adopted === 'elsewhere') {
      ctx.log(`[remote-helper] ${profileId}: its folder on ${m.host} is marked as this install's now (it had ${adopted === 'old' ? 'the marker of an earlier build' : "another install's marker"})`)
      return { ok: true, own, adopted }
    }
    return { ok: true, own }
  } catch (err) {
    return { ok: false, why: (err as Error).message }
  }
}

/** What one sign-out on a machine did: `logout`, the CLI's sign-out's exit
 *  status (null when it printed none); `removed`, the account's folder went;
 *  `gone`, there was no folder to sign out. */
export type SignOutRun = { ok: true; logout: number | null; removed: boolean; gone: boolean } | { ok: false; why: string }

/** One account folder's sign-out in a `signout` exec. */
export interface FolderSignOut { profileId: string; logout: number | null; removed: boolean }

/** An exit status as the script prints it, or null. */
const exitOf = (v: string | undefined): number | null => (v !== undefined && /^[0-9]{1,3}$/.test(v) ? Number(v) : null)

/** Each folder's `out <id> <exit>` and `removed <id>` lines, in order. */
export function folderSignOuts(stdout: string, nonce: string): FolderSignOut[] {
  const out: FolderSignOut[] = []
  for (const line of markedLines(stdout, 'AICC-RESULT', nonce)) {
    const [key, id, exit, more] = line.split(' ')
    if (more !== undefined || !ACCOUNT_PROFILE_RE.test(id ?? '')) continue
    if (key === 'out' && !out.some((o) => o.profileId === id)) out.push({ profileId: id, logout: exitOf(exit), removed: false })
    if (key === 'removed' && exit === undefined) {
      const o = out.find((x) => x.profileId === id)
      if (o) o.removed = true
    }
  }
  return out
}

/** How long one sign-out exec may take: the CLI's own sign-out has 60 s
 *  there (`timeout`), and the exec a little more. */
export const SIGN_OUT_EXEC_MS = 90_000
/** How long Remove's sign-out exec may take (2.1.3-beta.20 fix round,
 *  NIT-10): one sign-out after another for each of this computer's folders
 *  there. The Remove door waits longer than this, its list exec and its
 *  removal together (ipc/remote-machines-handlers.ts REMOTE_REMOVE_TIMEOUT_MS). */
export const REMOVE_SIGN_OUT_EXEC_MS = 600_000

/** The words a `list` exec names each folder it left with: this install's
 *  that the list did not name (`left`), and another computer's
 *  (`elsewhere`). */
export function leftFolders(stdout: string, nonce: string, key: 'left' | 'old' | 'elsewhere'): string[] {
  const out: string[] = []
  for (const line of markedLines(stdout, 'AICC-RESULT', nonce)) {
    const [k, id, more] = line.split(' ')
    if (k === key && more === undefined && ACCOUNT_PROFILE_RE.test(id ?? '') && !out.includes(id)) out.push(id)
  }
  return out
}

type SignOutExec = { ok: true; values: Map<string, string>; folders: FolderSignOut[]; left: string[]; old: string[]; elsewhere: string[] } | { ok: false; why: string; folders: FolderSignOut[] }

/** One `signout` exec: the folders it signed out (and removed), and the
 *  ones it left; or why it stopped, with those it did before. */
async function runSignOut(ctx: HostAccountsContext, m: RemoteMachineRecord, via: RemoteAccounts, kind: 'folder' | 'own' | 'list', profileIds: string): Promise<SignOutExec> {
  try {
    const nonce = newNonce()
    const values = [nonce, m.did, ctx.installId, kind, profileIds, via.configVar, via.signOut.program, via.signOut.args.join(',')]
    const r = await runScript(ctx.runner, targetOf(m), 'signout', values, { timeoutMs: kind === 'list' ? REMOVE_SIGN_OUT_EXEC_MS : SIGN_OUT_EXEC_MS })
    if (r.notStarted) ctx.log(notStartedLogLine(m.host, r.stderr))
    const failed = sshFailure(r)
    if (failed) return { ok: false, why: `${m.host} could not be reached: ${failed}`, folders: [] }
    const folders = folderSignOuts(r.stdout, nonce)
    const result = readScriptResult(r.stdout, nonce)
    if (!result) return { ok: false, why: `${m.host} did not say whether it signed out`, folders }
    if (!result.ok) return { ok: false, why: `${m.host} stopped the sign-out: ${refusalText(result.refused)}`, folders }
    return { ok: true, values: result.values, folders, left: leftFolders(r.stdout, nonce, 'left'), old: leftFolders(r.stdout, nonce, 'old'), elsewhere: leftFolders(r.stdout, nonce, 'elsewhere') }
  } catch (err) {
    return { ok: false, why: (err as Error).message, folders: [] }
  }
}

/**
 * Section 3.1.8: the CLI's own sign-out on machine `m`, in the account's
 * folder (`{ profileId }`: then that folder goes, and only it) or of the
 * machine's own sign-in (`own`: only after the user confirmed it, Q5; its
 * folder stays). Never throws.
 */
export async function signOutOnMachine(ctx: HostAccountsContext, m: RemoteMachineRecord, via: RemoteAccounts, which: { profileId: string } | 'own'): Promise<SignOutRun> {
  if (which !== 'own' && !ACCOUNT_PROFILE_RE.test(which.profileId)) return { ok: false, why: 'that is not an account id the app makes' }
  const run = await runSignOut(ctx, m, via, which === 'own' ? 'own' : 'folder', which === 'own' ? '-' : which.profileId)
  if (!run.ok) return { ok: false, why: run.why }
  if (which === 'own') return { ok: true, logout: exitOf(run.values.get('logout')), removed: false, gone: false }
  if (run.values.get('gone') === 'yes') return { ok: true, logout: null, removed: false, gone: true }
  const f = run.folders.find((x) => x.profileId === which.profileId)
  return { ok: true, logout: f?.logout ?? null, removed: f?.removed ?? false, gone: false }
}

/** What Remove's sign-out did: each folder it signed out; the folders it
 *  left (this install's it was not given, and another computer's); and
 *  `deviceGone`, the device folder was not there, so nothing was signed out
 *  and Remove goes on as before (2.1.3-beta.20 fix round, MAJOR-2). */
export type RemoveSignOut =
  | { ok: true; deviceGone: boolean; folders: FolderSignOut[]; left: string[]; old: string[]; elsewhere: string[] }
  | { ok: false; why: string; folders: FolderSignOut[] }

/** Most profile ids one `list` exec names (ACCOUNT_IDS_RE). */
const MAX_LIST_IDS = 64

/**
 * Section 3.1.8, Remove (2.1.3-beta.20 fix round, MAJOR-1): the account
 * folders on machine `m` that `profileIds` names (this computer's accounts,
 * and its folders of accounts it no longer holds), each only when its
 * folder holds this install's marker, signed out and removed in one exec,
 * with no read first (a machine whose helper is not this build's is removed
 * too). A folder another computer's app made there is never touched, and is
 * named in the answer. Never throws.
 */
export async function signOutListOnMachine(ctx: HostAccountsContext, m: RemoteMachineRecord, via: RemoteAccounts, profileIds: readonly string[]): Promise<RemoveSignOut> {
  const ids = [...new Set(profileIds.filter((id) => ACCOUNT_PROFILE_RE.test(id)))].slice(0, MAX_LIST_IDS)
  const run = await runSignOut(ctx, m, via, 'list', ids.length > 0 ? ids.join(',') : '-')
  if (!run.ok) return { ok: false, why: run.why, folders: run.folders }
  return { ok: true, deviceGone: run.values.get('device') === 'gone', folders: run.folders, left: run.left, old: run.old, elsewhere: run.elsewhere }
}

/** The states a launch may start on. */
export const launchable = (s: HostSignInState): boolean => s === 'signed-in-here' || s === 'machine-own'

/**
 * Round 2 (R1): Adopt, the user's own choice on a machine's card. Each of
 * `profileIds` that the machine's last read named `elsewhere` and that is one
 * of this computer's accounts gets this install's marker on its folder
 * (`account adopt`, one exec each); nothing is signed in, out or removed.
 * Any other id is refused before anything runs. The machine is read again
 * after it. Never throws. `aliases`: as accountNamer takes them (F2-1).
 */
export async function adoptAccountFolders(ctx: HostAccountsContext, m: RemoteMachineRecord, via: RemoteAccounts, profileIds: readonly string[], aliases?: Readonly<Record<string, string>>): Promise<HostAdoptResult> {
  let profiles: readonly HostProfile[]
  try { profiles = await via.profiles() } catch { return { ok: false, message: "This computer's accounts could not be read, so nothing was adopted.", adopted: [] } }
  const held = new Set(profiles.filter((p) => ACCOUNT_PROFILE_RE.test(p.id)).map((p) => p.id))
  const last = machineAccounts(m.did, profiles)
  const elsewhere = new Set(last.elsewhere ?? [])
  const ids = [...new Set(profileIds)]
  const not = ids.filter((id) => !ACCOUNT_PROFILE_RE.test(id) || !held.has(id) || !elsewhere.has(id))
  if (ids.length === 0 || not.length > 0) return { ok: false, message: "Nothing was adopted: only a folder the machine's last read names as another install's, for one of this computer's accounts, can be adopted.", adopted: [] }
  // Phase 5 round 3 (R3-1): the one rule (accountBinding): not while a folder
  // there with another install's mark is for an account this computer does not hold.
  if (last.mayBeEarlierInstall !== true) return { ok: false, message: "Nothing was adopted: not every folder there with another install's mark is for one of this computer's accounts, so they are taken as the app's on another computer.", adopted: [] }
  const adopted: string[] = []
  // Final review (F-4): each id not adopted with its reason, for the
  // renderer's dialog, which names the accounts by its own rule.
  const notAdopted: Array<{ profileId: string; why: string }> = []
  for (const id of ids) {
    const r = await prepareAccountFolder(ctx, m, via, id, 'adopt', 'keep')
    if (r.ok) adopted.push(id)
    else notAdopted.push({ profileId: id, why: r.why })
  }
  await readMachineAccounts(ctx, m, via)
  const nameOf = accountNamer(profiles, aliases)
  const names = adopted.map(nameOf)
  const done = names.length ? `Adopted ${joinNames(names)}: ${names.length === 1 ? 'its folder' : 'their folders'} there ${names.length === 1 ? 'is' : 'are'} this computer's now.` : ''
  const failed = notAdopted.map((x) => `${nameOf(x.profileId)}: ${x.why}`)
  return {
    ok: notAdopted.length === 0,
    message: [done, failed.length ? `Not adopted: ${failed.join('; ')}.` : ''].filter(Boolean).join(' '),
    adopted,
    ...(notAdopted.length ? { notAdopted } : {}),
  }
}
