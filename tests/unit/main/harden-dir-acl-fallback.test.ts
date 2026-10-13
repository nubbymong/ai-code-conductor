// aicc_planning#103 (2.1.1-beta.3): the Windows folder-rights step (hardenDirAclWindows)
// keeps the user's own full control at every write, whoever owns the folder,
// and never writes an empty access list. A principal the call grants is not
// removed outright where its printed name is known (a deny entry of its is,
// alone; its allow entries only by a write that grants it, the single replace
// or the strip-and-grant, when one of them is an entry the grant leaves in
// place; never by the one-at-a-time calls), each removal carries the grants
// in the same invocation, and the one-at-a-time
// fallback (taken when the single replace fails, e.g. on an entry icacls
// cannot name back) removes nothing until a read-back shows the user's own
// explicit full-control entry, in the spelling icacls prints; without it the
// step writes one fixed line to the log, once per folder, and answers false.
//
// Host-safe: icacls is a simulation in memory (`node:child_process` is
// mocked; anything else that would start a process throws). No access list on
// this machine is read or written. The simulation applies an invocation's
// options in order to a copy of the list and writes it once (as icacls does:
// a name that does not resolve fails the whole invocation and changes
// nothing), and checks the right to write the list (owner, or an allow
// full-control entry) before each write. `/grant:r` replaces only the
// principal's explicit allow entries with the grant's own flags, as measured
// on a Windows VM: an entry that applies to the folder alone (a creator's
// default list gives those) stays beside the one it writes; `/remove:g` takes
// every explicit allow entry of the principal. The step's module only runs its
// Windows half on Windows, so the cases run there (this machine, and the
// Windows legs of CI); the matching of the read-back runs on every leg. The
// real-ACL twin is in tests/unit/harden-dir-acl-windows.test.ts (quarantined
// from the owner's machine: VM and CI only).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'

/** `scope: 'folder'`: the entry applies to the folder alone (printed with no
 *  (OI)(CI)); otherwise it is passed to what is inside, as a grant writes. */
interface Ace { p: string; deny: boolean; inherited: boolean; rights: 'F' | 'RX'; scope?: 'folder' }
interface Sim {
  owner: 'user' | 'admins'
  aces: Ace[]
  /** Every invocation's argv (after the folder), in order. */
  calls: string[][]
  /** The list after every write that landed. */
  writes: Ace[][]
  /** Reads (counted from 1) that give no answer: the process ends with no exit code, as one killed at its time limit. */
  failReads: Set<number>
  reads: number
  /** Runs after each write that landed, with that write's options: another writer, for a test. */
  afterWrite?: (s: Sim, ops: string[]) => void
}

const h = vi.hoisted(() => ({ sim: null as null | Sim, user: '', folder: '' }))

const SYSTEM = 'NT AUTHORITY\\SYSTEM'
const ADMINS = 'BUILTIN\\Administrators'
const AUTH_USERS = 'NT AUTHORITY\\Authenticated Users'
/** A name icacls prints but cannot resolve back (measured on real machines). */
const LOGON = 'NT AUTHORITY\\LogonSessionId_0_411756'
const DOMAIN = 'TESTDOM'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  const fail = (status: number) => Object.assign(new Error(`icacls exit ${status}`), { status })
  // The user as icacls prints it: always with the domain it resolved, also
  // when it was named by the bare account name.
  const userPrinted = () => `${DOMAIN}\\${h.user}`
  /** A name as icacls resolves it, as the name it prints; null when it does not resolve. */
  const resolve = (name: string): string | null => {
    const n = name.toUpperCase()
    if (n === '*S-1-5-18' || n === SYSTEM.toUpperCase()) return SYSTEM
    if (n === userPrinted().toUpperCase() || n === h.user.toUpperCase()) return userPrinted()
    if (n === ADMINS.toUpperCase() || n === '*S-1-5-32-544') return ADMINS
    if (n === AUTH_USERS.toUpperCase() || n === '*S-1-5-11') return AUTH_USERS
    return null
  }
  const mayWrite = (s: Sim) => s.owner === 'user' || s.aces.some((a) => a.p === userPrinted() && !a.deny && a.rights === 'F')
  const mayRead = (s: Sim) => s.owner === 'user' || s.aces.some((a) => a.p === userPrinted() && !a.deny)
  const print = (a: Ace) => `${a.p}:${a.deny ? '(DENY)' : ''}${a.inherited ? '(I)' : ''}${a.scope === 'folder' ? '' : '(OI)(CI)'}(${a.rights})`
  const execFileSync = vi.fn((file: unknown, args: unknown) => {
    if (typeof file !== 'string' || path.win32.basename(file).toLowerCase() !== 'icacls.exe' || !Array.isArray(args)) return no(file)
    const s = h.sim
    if (!s || args[0] !== h.folder) throw fail(2)
    const ops = (args as string[]).slice(1)
    s.calls.push(ops)
    if (ops.length === 0) {
      if (s.failReads.has(++s.reads)) throw Object.assign(new Error('killed'), { status: null, signal: 'SIGTERM' })
      if (!mayRead(s)) throw fail(5)
      return [`${h.folder} ${s.aces.length ? print(s.aces[0]) : ''}`, ...s.aces.slice(1).map((a) => `${' '.repeat(h.folder.length + 1)}${print(a)}`), '', 'Successfully processed 1 files; Failed processing 0 files'].join('\r\n')
    }
    // Every name resolves first, or nothing changes (exit 1332).
    type Op = { kind: 'remove' | 'remove:d' | 'remove:g' | 'inheritance:r' | 'grant:r'; who?: string }
    const plan: Op[] = []
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i]
      if (o === '/remove' || o === '/remove:d' || o === '/remove:g') {
        const who = resolve(ops[++i] ?? '')
        if (!who) throw fail(1332)
        plan.push({ kind: o === '/remove' ? 'remove' : o === '/remove:d' ? 'remove:d' : 'remove:g', who })
      } else if (o === '/inheritance:r') plan.push({ kind: 'inheritance:r' })
      else if (o === '/grant:r') {
        while (i + 1 < ops.length && !ops[i + 1].startsWith('/')) {
          const spec = ops[++i]
          const m = /^(.*):\(OI\)\(CI\)F$/.exec(spec)
          const who = m ? resolve(m[1]) : null
          if (!who) throw fail(1332)
          plan.push({ kind: 'grant:r', who })
        }
      } else if (o === '/L' || o === '/Q') { /* no change here */ } else throw fail(87)
    }
    if (!mayWrite(s)) throw fail(5)
    let next = s.aces.map((a) => ({ ...a }))
    for (const op of plan) {
      if (op.kind === 'remove') next = next.filter((a) => a.inherited || a.p !== op.who)
      else if (op.kind === 'remove:d') next = next.filter((a) => a.inherited || !a.deny || a.p !== op.who)
      else if (op.kind === 'remove:g') next = next.filter((a) => a.inherited || a.deny || a.p !== op.who)
      else if (op.kind === 'inheritance:r') next = next.filter((a) => !a.inherited)
      else {
        // Replaces only the entries with the grant's own flags.
        next = next.filter((a) => a.inherited || a.deny || a.p !== op.who || a.scope === 'folder')
        next.push({ p: op.who!, deny: false, inherited: false, rights: 'F' })
      }
    }
    s.aces = next
    s.writes.push(next.map((a) => ({ ...a })))
    s.afterWrite?.(s, ops)
    return ''
  })
  const execFile = vi.fn(no)
  const spawn = vi.fn(no)
  const spawnSync = vi.fn(no)
  const execSync = vi.fn(no)
  return { ...real, execFileSync, execFile, spawn, spawnSync, execSync, default: { ...real, execFileSync, execFile, spawn, spawnSync, execSync } }
})

const logs = vi.hoisted(() => ({ warn: [] as string[] }))
vi.mock('../../../src/main/debug-logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/debug-logger')>()
  return { ...real, logWarn: (...a: unknown[]) => { logs.warn.push(a.map(String).join(' ')) }, logInfo: () => {}, logError: () => {} }
})

import { hardenDirAclWindows, _resetAclStateForTest, ACL_FALLBACK_UNPROVEN_LOG, grantedUserEntryPrincipal, windowsAclRemovalArgs } from '../../../src/main/account-profiles'

const USER = (() => { try { return os.userInfo().username } catch { return '' } })()
const ME = `${DOMAIN}\\${USER}`
const FOLDER = 'C:\\res\\fixture-folder'

function folder(owner: Sim['owner'], aces: Ace[], at: string = FOLDER): Sim {
  const s: Sim = { owner, aces, calls: [], writes: [], failReads: new Set(), reads: 0 }
  h.sim = s
  h.user = USER
  h.folder = at
  return s
}
const ace = (p: string, rights: Ace['rights'] = 'F', over: Partial<Ace> = {}): Ace => ({ p, deny: false, inherited: false, rights, ...over })
const inh = (p: string, rights: Ace['rights'] = 'F'): Ace => ace(p, rights, { inherited: true })
const hasMyFull = (list: Ace[]) => list.some((a) => a.p === ME && !a.deny && a.rights === 'F')
const hasSystemFull = (list: Ace[]) => list.some((a) => a.p === SYSTEM && !a.deny && a.rights === 'F')
/** Whether any invocation removes `who`'s allow entries (a /remove or /remove:g of that name). */
const removesAllowOf = (s: Sim, who: string) => s.calls.some((c) => c.some((x, i) => (x === '/remove' || x === '/remove:g') && (c[i + 1] ?? '').toUpperCase() === who.toUpperCase()))
/** The user as a call grants them (the grant that is not SYSTEM's), or undefined. */
const grantedUserIn = (c: string[]) => c.find((x) => x.endsWith(':(OI)(CI)F') && x !== '*S-1-5-18:(OI)(CI)F')?.slice(0, -':(OI)(CI)F'.length)
/** The index of the first strip-and-grant: a call with /inheritance:r whose
 *  only removals, if any, are a /remove:g of a principal that call grants
 *  (the user as it spells them, or SYSTEM by its SID). */
const stripAndGrantAt = (s: Sim) => s.calls.findIndex((c) => c.includes('/inheritance:r')
  && c.every((x, i) => !x.startsWith('/remove') || (x === '/remove:g' && (c[i + 1] === grantedUserIn(c) || c[i + 1] === '*S-1-5-18'))))
/** The fallback's one-at-a-time calls: after the strip-and-grant, exactly one removal, then the grants. */
const oneAtATime = (s: Sim) => s.calls.slice(stripAndGrantAt(s) + 1).filter((c) => c.filter((x) => x.startsWith('/remove')).length === 1 && c.includes('/grant:r'))
/** Whether `list` holds the entry the grant writes for `who`: explicit allow full control, passed to what is inside. */
const hasGrantOf = (list: Ace[], who: string) => list.some((a) => a.p === who && !a.deny && !a.inherited && a.rights === 'F' && a.scope !== 'folder')
/** `list` as `principal:flags` strings, sorted, for an exact comparison. */
const shape = (list: Ace[]) => list.map((a) => `${a.p}|${a.deny ? 'deny' : 'allow'}|${a.inherited ? 'inh' : 'exp'}|${a.scope ?? 'inside'}|${a.rights}`).sort()

const savedDomain = process.env.USERDOMAIN
beforeEach(() => {
  process.env.USERDOMAIN = DOMAIN
  logs.warn.length = 0
  _resetAclStateForTest()
})
afterEach(() => {
  if (savedDomain === undefined) delete process.env.USERDOMAIN
  else process.env.USERDOMAIN = savedDomain
  h.sim = null
})

describe.runIf(process.platform === 'win32')('the folder-rights step keeps the user\'s full control at every write (aicc_planning#103)', () => {
  it('whoever owns the folder, with every entry inherited and one that cannot be named back: the user and SYSTEM keep full control at every write', () => {
    expect(USER, 'this test needs the account name').not.toBe('')
    // The folder is the Administrators group's, the process is not, and the
    // single replace is refused because one entry's name does not resolve, so
    // the fallback runs.
    const s = folder('admins', [inh(SYSTEM), inh(ADMINS), inh(ME), inh(LOGON, 'RX')])
    const ok = hardenDirAclWindows(FOLDER)
    // Never empty, and the user's own full control at every write; SYSTEM's
    // too, from the strip-and-grant on.
    expect(s.writes.length).toBeGreaterThan(0)
    for (const w of s.writes) {
      expect(w.length, `an empty access list was written: ${JSON.stringify(s.writes)}`).toBeGreaterThan(0)
      expect(hasMyFull(w), JSON.stringify(w)).toBe(true)
      expect(hasSystemFull(w), JSON.stringify(w)).toBe(true)
    }
    expect(ok).toBe(true)
    // Ends as the step means it: the user and SYSTEM, nothing inherited.
    expect(s.aces.map((a) => a.p).sort()).toEqual([ME, SYSTEM].sort())
    expect(s.aces.every((a) => !a.inherited && !a.deny && a.rights === 'F')).toBe(true)
    // The user's allow entry is never removed, by the replace or the fallback.
    expect(removesAllowOf(s, ME)).toBe(false)
    // Nor, by the fallback, SYSTEM's: the read-back names it as the one entry
    // besides the user's that the strip-and-grant just made, though its
    // printed name was not known (the single replace may name it, as it
    // grants it in the same write).
    const grantAt = stripAndGrantAt(s)
    expect(grantAt, 'the fallback ran').toBeGreaterThanOrEqual(0)
    expect(removesAllowOf({ ...s, calls: s.calls.slice(grantAt + 1) }, SYSTEM)).toBe(false)
    expect(logs.warn).toEqual([])
  })

  it('every one-at-a-time removal carries the grants, so no write is without them', () => {
    const s = folder('admins', [inh(SYSTEM), inh(ME), ace(AUTH_USERS), ace(LOGON, 'RX')])
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    const grantAt = stripAndGrantAt(s)
    expect(grantAt, 'the fallback ran').toBeGreaterThanOrEqual(0)
    const singles = s.calls.slice(grantAt + 1).filter((c) => c.some((x) => x.startsWith('/remove')))
    expect(singles.length).toBeGreaterThan(0)
    for (const c of singles) {
      // Remove, then grant: the measured order that leaves the two intended entries.
      expect(c.findIndex((x) => x.startsWith('/remove')), c.join(' ')).toBeGreaterThanOrEqual(0)
      expect(c.indexOf('/grant:r'), c.join(' ')).toBeGreaterThan(c.findIndex((x) => x.startsWith('/remove')))
      expect(c.some((x) => x.toUpperCase() === `${ME.toUpperCase()}:(OI)(CI)F`), c.join(' ')).toBe(true)
      expect(c).toContain('*S-1-5-18:(OI)(CI)F')
    }
    // The broad entry is gone; the name that cannot be said back stays.
    expect(s.aces.map((a) => a.p)).not.toContain(AUTH_USERS)
    expect(s.aces.every((a) => a.p !== LOGON || !a.inherited)).toBe(true)
    expect(hasMyFull(s.aces)).toBe(true)
  })

  it('without a read-back of the user\'s own full-control entry, nothing is removed and the step says so, in fixed words', () => {
    // The single replace is refused (a name that cannot be said back), the
    // strip-and-grant lands, and then the read-back gives no answer (a read
    // that ran past its time limit on a slow share, say): the step cannot
    // show that it keeps the right to write the list, so it removes nothing.
    const s = folder('admins', [inh(SYSTEM), inh(ADMINS), inh(ME), inh(LOGON, 'RX')])
    s.failReads.add(2)
    expect(hardenDirAclWindows(FOLDER)).toBe(false)
    // The strip-and-grant was the last write: no removal after it.
    const grantAt = stripAndGrantAt(s)
    expect(grantAt).toBeGreaterThanOrEqual(0)
    expect(s.calls.slice(grantAt + 1).some((c) => c.some((x) => x.startsWith('/remove')))).toBe(false)
    // The folder keeps the grants just written, and stays the user's.
    expect(s.aces.length).toBeGreaterThan(0)
    expect(hasMyFull(s.aces)).toBe(true)
    for (const w of s.writes) expect(hasMyFull(w), JSON.stringify(w)).toBe(true)
    // One line, fixed words, no path.
    expect(logs.warn).toEqual([ACL_FALLBACK_UNPROVEN_LOG])
    expect(ACL_FALLBACK_UNPROVEN_LOG).not.toMatch(/[\\/]/)
  })

  it('that line is written once per folder, however often the step runs on it', () => {
    // A name that cannot be said back and is not inherited, so every call
    // takes the fallback; every read-back gives no answer.
    const a = folder('admins', [inh(SYSTEM), inh(ME), ace(LOGON, 'RX')])
    a.failReads.add(2).add(4).add(6)
    expect(hardenDirAclWindows(FOLDER)).toBe(false)
    expect(hardenDirAclWindows(FOLDER)).toBe(false)
    expect(hardenDirAclWindows(FOLDER)).toBe(false)
    // Control: every call reached the read-back.
    expect(a.reads).toBe(6)
    expect(logs.warn).toEqual([ACL_FALLBACK_UNPROVEN_LOG])
    // Another folder gets its own line.
    const b = folder('admins', [inh(SYSTEM), inh(ME), ace(LOGON, 'RX')], 'C:\\res\\fixture-folder-two')
    b.failReads.add(2)
    expect(hardenDirAclWindows('C:\\res\\fixture-folder-two')).toBe(false)
    expect(logs.warn).toEqual([ACL_FALLBACK_UNPROVEN_LOG, ACL_FALLBACK_UNPROVEN_LOG])
  })

  it.each([
    ['no domain to spell the user by', undefined],
    ['a domain spelling that does not resolve', 'OTHERDOM'],
  ])('with %s, the bare spelling\'s read-back is recognised: a broad entry goes, one that cannot be named back is set aside, and the folder settles', (_label, domain) => {
    if (domain === undefined) delete process.env.USERDOMAIN
    else process.env.USERDOMAIN = domain
    // icacls prints the user with the domain it resolved, never the bare
    // name the grant used.
    const s = folder('admins', [inh(SYSTEM), inh(ME), ace(AUTH_USERS), ace(LOGON, 'RX')])
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(stripAndGrantAt(s), 'the fallback ran').toBeGreaterThanOrEqual(0)
    for (const w of s.writes) {
      expect(w.length, JSON.stringify(s.writes)).toBeGreaterThan(0)
      expect(hasMyFull(w), JSON.stringify(w)).toBe(true)
    }
    expect(s.aces.map((a) => a.p)).not.toContain(AUTH_USERS)
    // The one-at-a-time removals ran, and none of them named the user.
    const singles = oneAtATime(s)
    expect(singles.length, JSON.stringify(s.calls)).toBeGreaterThan(0)
    expect(removesAllowOf({ ...s, calls: singles }, ME)).toBe(false)
    expect(logs.warn).toEqual([])
    // Settled: the next call reads once and writes nothing.
    const before = s.calls.length
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(s.calls.slice(before)).toEqual([[]])
  })

  it('an entry that turns up between the grant and the read-back is not taken for SYSTEM: it is removed, and SYSTEM keeps full control at every write', () => {
    // Another writer adds a full-control entry just after the strip-and-grant,
    // so two entries besides the user's look just made. Neither is taken as
    // SYSTEM's; both are named, each with the grants in the same write.
    const s = folder('admins', [inh(SYSTEM), inh(ME), ace(LOGON, 'RX')])
    let added = false
    // The first write that lands: the strip-and-grant, as the single replace is refused (checked below).
    let firstWrite: string[] | null = null
    s.afterWrite = (sim, ops) => {
      if (!added) { added = true; firstWrite = ops; sim.aces.push(ace(AUTH_USERS)) }
    }
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(added, 'the other writer ran').toBe(true)
    expect(s.calls.indexOf(firstWrite!), 'the other writer ran just after the strip-and-grant').toBe(stripAndGrantAt(s))
    expect(s.aces.map((a) => a.p)).not.toContain(AUTH_USERS)
    const grantAt = stripAndGrantAt(s)
    expect(removesAllowOf({ ...s, calls: s.calls.slice(grantAt + 1) }, AUTH_USERS)).toBe(true)
    for (const w of s.writes) {
      expect(hasMyFull(w), JSON.stringify(w)).toBe(true)
      expect(hasSystemFull(w), JSON.stringify(w)).toBe(true)
    }
    expect(s.aces.filter((a) => a.p !== LOGON).map((a) => a.p).sort()).toEqual([ME, SYSTEM].sort())
  })

  it('a deny entry of the user\'s own is still taken off, alone, never the user\'s allow entry', () => {
    const s = folder('user', [ace(ME, 'RX', { deny: true }), inh(ME), ace(AUTH_USERS)])
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(s.aces.some((a) => a.deny)).toBe(false)
    expect(s.aces.map((a) => a.p)).not.toContain(AUTH_USERS)
    expect(hasMyFull(s.aces)).toBe(true)
    expect(removesAllowOf(s, ME)).toBe(false)
    expect(s.calls.some((c) => c.includes('/remove:d'))).toBe(true)
  })

  it('the ordinary replace still clears a broad explicit entry in one invocation', () => {
    const s = folder('user', [ace(ME), ace(SYSTEM), ace(ADMINS), ace(AUTH_USERS)])
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(s.aces.map((a) => a.p).sort()).toEqual([ME, SYSTEM].sort())
    // One read, one write (the replace), one read-back to learn the pair.
    expect(s.calls.filter((c) => c.length > 0)).toHaveLength(1)
  })

  // A folder made under a parent that hands nothing down takes the creator's
  // default list: entries for the user (or the Administrators group, when the
  // creator is elevated), SYSTEM and, under some logon types, a logon session
  // that cannot be named back, each applying to the folder alone. `/grant:r`
  // leaves those beside the entries it writes.
  const THE_GRANT = (who: string) => ({ p: who, deny: false, inherited: false, rights: 'F' as const })
  const folderOnly = (p: string, rights: Ace['rights'] = 'F') => ace(p, rights, { scope: 'folder' })

  it('an entry of SYSTEM\'s that applies to the folder alone goes too, in a write that grants SYSTEM again, and the folder settles on its first call', () => {
    const s = folder('user', [folderOnly(SYSTEM), folderOnly(ADMINS), folderOnly(LOGON, 'RX'), ace(AUTH_USERS)])
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    const grantAt = stripAndGrantAt(s)
    expect(grantAt, 'the fallback ran').toBeGreaterThanOrEqual(0)
    for (const w of s.writes) {
      expect(w.length, JSON.stringify(s.writes)).toBeGreaterThan(0)
      expect(hasGrantOf(w, ME), JSON.stringify(w)).toBe(true)
      expect(hasGrantOf(w, SYSTEM), JSON.stringify(w)).toBe(true)
    }
    // The user and SYSTEM, each once, as the grant writes them; only the
    // entry that cannot be named back stays beside them.
    expect(shape(s.aces.filter((a) => a.p !== LOGON))).toEqual(shape([THE_GRANT(ME), THE_GRANT(SYSTEM)]))
    // SYSTEM's allow entries go in the strip-and-grant, by SID, ahead of its
    // grant; the fallback after it names neither the user nor SYSTEM.
    const strip = s.calls[grantAt]
    expect(strip.indexOf('/remove:g'), strip.join(' ')).toBeGreaterThanOrEqual(0)
    expect(strip[strip.indexOf('/remove:g') + 1]).toBe('*S-1-5-18')
    expect(strip.indexOf('/grant:r')).toBeGreaterThan(strip.indexOf('/remove:g'))
    const after = { ...s, calls: s.calls.slice(grantAt + 1) }
    expect(removesAllowOf(after, ME)).toBe(false)
    expect(removesAllowOf(after, SYSTEM)).toBe(false)
    expect(logs.warn).toEqual([])
    // Settled: the next call reads once and writes nothing.
    const before = s.calls.length
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(s.calls.slice(before)).toEqual([[]])
  })

  it.each(['user', 'admins'] as const)('an entry of the user\'s own that applies to the folder alone goes in the strip-and-grant, the write that grants the user again, never in a one-at-a-time call (folder owned by %s)', (owner) => {
    const s = folder(owner, [folderOnly(ME), folderOnly(SYSTEM), folderOnly(LOGON, 'RX'), ace(AUTH_USERS)])
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    const grantAt = stripAndGrantAt(s)
    expect(grantAt, 'the fallback ran').toBeGreaterThanOrEqual(0)
    // Never empty, and the user's own full control at every write.
    for (const w of s.writes) {
      expect(w.length, JSON.stringify(s.writes)).toBeGreaterThan(0)
      expect(hasGrantOf(w, ME), JSON.stringify(w)).toBe(true)
    }
    // Every call that names the user's allow entries grants the user after it,
    // in the same invocation, and none comes after the strip-and-grant.
    for (const c of s.calls) {
      const at = c.findIndex((x, i) => (x === '/remove' || x === '/remove:g') && (c[i + 1] ?? '').toUpperCase() === ME.toUpperCase())
      if (at < 0) continue
      expect(c.indexOf('/grant:r'), c.join(' ')).toBeGreaterThan(at)
      expect(c.some((x) => x.toUpperCase() === `${ME.toUpperCase()}:(OI)(CI)F`), c.join(' ')).toBe(true)
    }
    expect(removesAllowOf({ ...s, calls: s.calls.slice(grantAt + 1) }, ME)).toBe(false)
    expect(oneAtATime(s).length, JSON.stringify(s.calls)).toBeGreaterThan(0)
    expect(shape(s.aces.filter((a) => a.p !== LOGON))).toEqual(shape([THE_GRANT(ME), THE_GRANT(SYSTEM)]))
    expect(logs.warn).toEqual([])
    const before = s.calls.length
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(s.calls.slice(before)).toEqual([[]])
  })

  it('an entry of the user\'s that turns up after the strip-and-grant is not named by a one-at-a-time call, no read-back is spent while it stays, and the next call\'s replace takes it', () => {
    const s = folder('user', [folderOnly(SYSTEM), folderOnly(LOGON, 'RX'), ace(AUTH_USERS)])
    let added = false
    // The first write that lands: the strip-and-grant, as the single replace is refused (checked below).
    let firstWrite: string[] | null = null
    s.afterWrite = (sim, ops) => {
      if (!added) { added = true; firstWrite = ops; sim.aces.push(folderOnly(ME)) }
    }
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(added, 'the other writer ran').toBe(true)
    expect(s.calls.indexOf(firstWrite!), 'the other writer ran just after the strip-and-grant').toBe(stripAndGrantAt(s))
    const grantAt = stripAndGrantAt(s)
    expect(removesAllowOf({ ...s, calls: s.calls.slice(grantAt + 1) }, ME)).toBe(false)
    for (const w of s.writes) expect(hasGrantOf(w, ME), JSON.stringify(w)).toBe(true)
    // The folder cannot read back as settled while that entry stays, so the
    // call ends on its last grant, with no read after it.
    expect(s.calls[s.calls.length - 1].length, JSON.stringify(s.calls)).toBeGreaterThan(0)
    // The next call's single replace takes it, in the write that grants the user.
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(shape(s.aces.filter((a) => a.p !== LOGON))).toEqual(shape([THE_GRANT(ME), THE_GRANT(SYSTEM)]))
    for (const w of s.writes) expect(hasGrantOf(w, ME), JSON.stringify(w)).toBe(true)
    const before = s.calls.length
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(s.calls.slice(before)).toEqual([[]])
  })

  // `/remove:d` takes only a
  // deny entry. So when the user has a deny entry, and an entry of theirs
  // that the grant leaves in place turns up after the strip-and-grant, the
  // deny entry's removal does not name that allow entry: the user still
  // counts as stranded, and no read-back is spent while it stays. Mutation
  // to prove this can fail: count every removal of a granted principal as
  // naming their allow entries (strandedPrincipals, an unconditional
  // `allowNamedBack.add(printed)`), which spends a read-back here.
  it('a deny entry of the user\'s taken off by /remove:d does not count as taking a later allow entry of theirs: no read-back is spent while that entry stays', () => {
    const s = folder('user', [ace(ME, 'RX', { deny: true }), folderOnly(SYSTEM), folderOnly(LOGON, 'RX'), ace(AUTH_USERS)])
    let added = false
    // The first write that lands: the strip-and-grant, as the single replace is refused (checked below).
    let firstWrite: string[] | null = null
    s.afterWrite = (sim, ops) => {
      if (!added) { added = true; firstWrite = ops; sim.aces.push(folderOnly(ME)) }
    }
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(added, 'the other writer ran').toBe(true)
    const grantAt = stripAndGrantAt(s)
    expect(s.calls.indexOf(firstWrite!), 'the other writer ran just after the strip-and-grant').toBe(grantAt)
    // The deny entry went, by /remove:d, after the strip-and-grant; the allow entry was never named there.
    const after = s.calls.slice(grantAt + 1)
    expect(after.some((c) => c.some((x, i) => x === '/remove:d' && (c[i + 1] ?? '').toUpperCase() === ME.toUpperCase())), JSON.stringify(s.calls)).toBe(true)
    expect(s.aces.some((a) => a.deny)).toBe(false)
    expect(removesAllowOf({ ...s, calls: after }, ME)).toBe(false)
    for (const w of s.writes) expect(hasGrantOf(w, ME), JSON.stringify(w)).toBe(true)
    // The call ends on its last grant, with no read after it.
    expect(s.calls[s.calls.length - 1].length, JSON.stringify(s.calls)).toBeGreaterThan(0)
  })

  it('the ordinary replace takes the user\'s and SYSTEM\'s entries that apply to the folder alone in its one invocation, after which the folder settles', () => {
    const s = folder('user', [folderOnly(ME), folderOnly(SYSTEM), folderOnly(ADMINS), ace(AUTH_USERS)])
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(shape(s.aces)).toEqual(shape([THE_GRANT(ME), THE_GRANT(SYSTEM)]))
    const writes = s.calls.filter((c) => c.length > 0)
    expect(writes, JSON.stringify(s.calls)).toHaveLength(1)
    // The user's allow entries are named ahead of the user's grant, in that write.
    const c = writes[0]
    expect(c.indexOf('/grant:r')).toBeGreaterThan(c.indexOf('/remove:g'))
    expect(c[c.indexOf('/remove:g') + 1]?.toUpperCase()).toBe(ME.toUpperCase())
    for (const w of s.writes) expect(hasGrantOf(w, ME), JSON.stringify(w)).toBe(true)
    const before = s.calls.length
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(s.calls.slice(before)).toEqual([[]])
  })

  it('once the pair is learned, an entry of SYSTEM\'s that applies to the folder alone is still taken', () => {
    // Learn the pair on one folder, then meet the entry on another.
    folder('user', [ace(ME), ace(SYSTEM), ace(AUTH_USERS)], 'C:\\res\\fixture-learn')
    expect(hardenDirAclWindows('C:\\res\\fixture-learn')).toBe(true)
    const s = folder('user', [ace(ME), folderOnly(SYSTEM), ace(AUTH_USERS)])
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(shape(s.aces)).toEqual(shape([THE_GRANT(ME), THE_GRANT(SYSTEM)]))
    for (const w of s.writes) expect(hasGrantOf(w, SYSTEM), JSON.stringify(w)).toBe(true)
    const before = s.calls.length
    expect(hardenDirAclWindows(FOLDER)).toBe(true)
    expect(s.calls.slice(before)).toEqual([[]])
  })
})

describe('windowsAclRemovalArgs: a principal the step grants', () => {
  const ME_P = 'PC\\nick'
  const GRANTED = new Set([ME_P.toUpperCase(), SYSTEM.toUpperCase()])
  it('the entry the grant writes is not named, nor an inherited one; anyone else is', () => {
    expect(windowsAclRemovalArgs([`${ME_P}:(OI)(CI)(F)`, `${SYSTEM}:(I)(OI)(CI)(F)`, `${AUTH_USERS}:(OI)(CI)(F)`], undefined, GRANTED))
      .toEqual(['/remove', AUTH_USERS])
  })
  it('a deny entry of theirs is named alone (/remove:d)', () => {
    expect(windowsAclRemovalArgs([`${ME_P}:(OI)(CI)(F)`, `${ME_P}:(DENY)(W)`], undefined, GRANTED)).toEqual(['/remove:d', ME_P])
  })
  it('asked to (as the single replace asks), an allow entry of theirs that the grant leaves in place is named with /remove:g: one for the folder alone, or with narrower rights', () => {
    expect(windowsAclRemovalArgs([`${SYSTEM}:(F)`, `${SYSTEM}:(OI)(CI)(F)`], undefined, GRANTED, true)).toEqual(['/remove:g', SYSTEM])
    expect(windowsAclRemovalArgs([`${ME_P}:(F)`], undefined, GRANTED, true)).toEqual(['/remove:g', ME_P])
    expect(windowsAclRemovalArgs([`${ME_P}:(OI)(CI)(RX)`], undefined, GRANTED, true)).toEqual(['/remove:g', ME_P])
    expect(windowsAclRemovalArgs([`${ME_P}:(DENY)(W)`, `${ME_P}:(F)`], undefined, GRANTED, true)).toEqual(['/remove:d', ME_P, '/remove:g', ME_P])
    // The entry the grant writes, or an inherited one, is still not named.
    expect(windowsAclRemovalArgs([`${ME_P}:(OI)(CI)(F)`, `${SYSTEM}:(I)(F)`], undefined, GRANTED, true)).toEqual([])
  })
  it('not asked to (as the one-at-a-time fallback is not), it never names their allow entries, only a deny entry', () => {
    expect(windowsAclRemovalArgs([`${ME_P}:(F)`, `${ME_P}:(OI)(CI)(F)`, `${SYSTEM}:(F)`], undefined, GRANTED)).toEqual([])
    expect(windowsAclRemovalArgs([`${ME_P}:(DENY)(W)`, `${ME_P}:(F)`], undefined, GRANTED)).toEqual(['/remove:d', ME_P])
  })
})

describe('grantedUserEntryPrincipal: the user\'s own full-control entry in a read-back', () => {
  const full = (p: string) => `${p}:(OI)(CI)(F)`
  it('a DOMAIN\\user spelling matches in full, in any letter case, and nothing else', () => {
    expect(grantedUserEntryPrincipal([full('PC\\nick'), full(SYSTEM)], [], 'pc\\NICK')).toBe('PC\\nick')
    expect(grantedUserEntryPrincipal([full('OTHER\\nick'), full(SYSTEM)], [], 'PC\\nick')).toBeNull()
  })
  it('a bare spelling matches the account half of the entry the grant just made', () => {
    expect(grantedUserEntryPrincipal([full(AUTH_USERS), full('PC\\nick'), full(SYSTEM)], [full(AUTH_USERS)], 'nick')).toBe('PC\\nick')
    // A same-named account already there and one just made: the one just made.
    expect(grantedUserEntryPrincipal([full('CORP\\nick'), full('PC\\nick')], [full('CORP\\nick')], 'NICK')).toBe('PC\\nick')
  })
  it('a bare spelling matches the only such entry when the grant made none', () => {
    expect(grantedUserEntryPrincipal([full('PC\\nick'), full(SYSTEM)], [full('PC\\nick')], 'nick')).toBe('PC\\nick')
  })
  it('two candidates, or only an inherited, deny or narrower entry, are no answer', () => {
    expect(grantedUserEntryPrincipal([full('CORP\\nick'), full('PC\\nick')], [], 'nick')).toBeNull()
    expect(grantedUserEntryPrincipal([full('CORP\\nick'), full('PC\\nick')], [full('CORP\\nick'), full('PC\\nick')], 'nick')).toBeNull()
    expect(grantedUserEntryPrincipal(['PC\\nick:(I)(OI)(CI)(F)'], [], 'nick')).toBeNull()
    expect(grantedUserEntryPrincipal(['PC\\nick:(DENY)(OI)(CI)(F)'], [], 'nick')).toBeNull()
    expect(grantedUserEntryPrincipal(['PC\\nick:(OI)(CI)(RX)'], [], 'nick')).toBeNull()
    expect(grantedUserEntryPrincipal([full('PC\\nickname')], [], 'nick')).toBeNull()
    expect(grantedUserEntryPrincipal([], [], 'nick')).toBeNull()
  })
})
