// What the remote setup does with the user's own ~/.claude/settings.json on
// the host, on a POSIX host and on a Windows host, and with ~/.claude.json on a
// POSIX host when it marks the session folder trusted.
//
// Both setup programs are taken from the real generators (the exact text the
// host runs) and RUN in-process against an in-memory file system that keeps
// every file as BYTES, so an encoding or a byte-order mark is seen exactly as
// the host would see it, and that applies a umask to a create (not to fchmod)
// as the host does. Nothing on this machine is read or written.
//
// The rules (userSettingsJs in src/main/providers/claude/ssh-shim.ts):
//   - the file is decoded as Claude Code decodes it (UTF-16LE after FF FE, a
//     leading U+FEFF dropped; src/main/settings-text.ts), so the per-session
//     settings file inherits its keys whatever the encoding;
//   - it is written back only when it parsed and a key the app owns there (a
//     statusLine running the app's statusline shim, the conductor and
//     conductor-vision mcpServers entries) was removed, in its own encoding
//     and byte-order mark, through a temporary file in its folder that is
//     then renamed over it;
//   - only a file the user could write in place is replaced that way: owned
//     by the user (POSIX, process.geteuid), with one name (nlink 1) and
//     opening for writing in place (an open with 'r+', which honours the
//     permission bits, file flags and ACLs, not only the read-only
//     attribute); a read-only file, one owned by another user, one with
//     another hard link, or one that does not open for writing is left as it
//     is;
//   - the temporary file is created exclusively with the file's own
//     permission bits; where its group is not the file's, fchown gives it the
//     file's group, and a group the user cannot give it leaves the file
//     whenever the file's group bits differ from its other bits, either way
//     (otherwise the file is written in the temporary file's group); fchmod then sets
//     the bits exactly, so the umask neither narrows nor widens them, and
//     only then is the content written;
//   - otherwise its bytes are left exactly as they were, and a file that is
//     not JSON, not an object, cannot be written back faithfully, or is left
//     for one of the reasons above is named in conductor-shim.log.
// The trust write to ~/.claude.json goes through the same writer: a link
// stays a link (the file it points at gets the flag), the mode is kept (0600
// for a new file), and a file left for one of the reasons above is named in
// conductor-shim.log as a claude-json-left line. After that, on every connect,
// a ~/.claude.json whose real path is a plain file with one name the user owns
// loses its group and other bits (keeping its owner's), with one
// claude-json-mode line in conductor-shim.log.
import { describe, it, expect } from 'vitest'
import * as nodePath from 'path'
import { generateRemoteSetupScript, generateWindowsRemoteSetupScript } from '../../../../src/main/providers/claude/ssh-shim'

const NONCE = 'userSettingsNonce1'
const SID = 'sid-us'
const PID = 4242
/** The user the POSIX setup runs as (process.geteuid). */
const EUID = 1000

type Flavour = {
  name: string
  path: typeof nodePath.posix
  home: string
  /** process.geteuid() on this host; a Windows host has none (and stat reports uid 0). */
  euid?: number
  script: () => string
}

const FLAVOURS: Flavour[] = [
  {
    name: 'POSIX host',
    path: nodePath.posix,
    home: '/home/remote-user',
    euid: EUID,
    script: () => generateRemoteSetupScript(SID, null, { includeConductorMcp: false }, NONCE, '~'),
  },
  {
    name: 'Windows host',
    path: nodePath.win32 as typeof nodePath.posix,
    home: 'C:\\Users\\remote-user',
    script: () => generateWindowsRemoteSetupScript(SID, { includeConductorMcp: false }, NONCE),
  },
]

interface World {
  /** Every file, as bytes. */
  files: Map<string, Buffer>
  /** Permission bits statSync reports for a path (default 0o644). */
  modes?: Record<string, number>
  /** Owner statSync reports for a path (default: the setup's user; uid 0 on a Windows host). */
  uids?: Record<string, number>
  /** Number of names statSync reports for a path (default 1). */
  nlinks?: Record<string, number>
  /** statSync of this path throws this code. */
  statFails?: Record<string, string>
  /** A path that is a link to another path: reads, stats and realpath follow it. */
  links?: Record<string, string>
  /** renameSync onto this path throws this code. */
  renameFails?: Record<string, string>
  /** The setup's umask (default 0o022): applied to the mode of a create, not to fchmod. */
  umask?: number
  /** Group statSync reports for a path (default: the user's primary group; 0 on a Windows host). */
  gids?: Record<string, number>
  /** The groups the setup's user is in (default: the primary group only). */
  groups?: readonly number[]
  /** A file that refuses an open for writing, and a write in place, although its
   *  mode and read-only attribute allow them: an ACL that denies the user
   *  writing (Windows), or an append-only flag (POSIX). access W_OK still
   *  passes for it, and a rename over it still succeeds, as the folder allows. */
  denyWrite?: readonly string[]
  /** A path statSync reports as not a plain file (a FIFO or a folder, say). */
  notFile?: readonly string[]
  /** chmodSync of this path throws this code. */
  chmodFails?: Record<string, string>
}

interface Run {
  /** Every file operation, in order: '<op> <path>' ('open:wx', 'open:r+',
   *  'fstat', 'fchown', 'fchmod', 'write', 'close', 'rm'), or
   *  'rename <from> <to>'. */
  ops: string[]
  files: Map<string, Buffer>
  /** Every write of content: by path, or through an open file (opts.fd). */
  writes: Array<{ path: string; opts?: Record<string, unknown> }>
  renames: Array<{ from: string; to: string }>
  opens: Array<{ path: string; flags: string; mode?: number }>
  fchmods: Array<{ path: string; mode: number }>
  fchowns: Array<{ path: string; uid: number; gid: number }>
  /** Every chmod the setup asked for, by the path it named (one that
   *  failed included). */
  chmods: Array<{ path: string; mode: number }>
  /** Permission bits of every file after the run. */
  modes: Map<string, number>
  /** Group of a file after the run, where one was set (none: the user's primary group). */
  gids: Map<string, number>
  /** The links still standing after the run. */
  links: Record<string, string>
  traces: string[]
  printed: string
}

function runSetup(f: Flavour, w: World): Run {
  const files = w.files
  const links = { ...(w.links ?? {}) }
  const follow = (p: string): string => links[p] ?? p
  const writes: Run['writes'] = []
  const renames: Run['renames'] = []
  const opens: Run['opens'] = []
  const fchmods: Run['fchmods'] = []
  const fchowns: Run['fchowns'] = []
  const chmods: Run['chmods'] = []
  const traces: string[] = []
  const ops: string[] = []
  const err = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code })
  const W_OK = 2
  const umask = w.umask ?? 0o022
  const modes = new Map<string, number>(Object.entries(w.modes ?? {}))
  const uids = new Map<string, number>(Object.entries(w.uids ?? {}))
  const nlinks = new Map<string, number>(Object.entries(w.nlinks ?? {}))
  const deny = new Set(w.denyWrite ?? [])
  const gids = new Map<string, number>(Object.entries(w.gids ?? {}))
  /** The user's primary group: the same number as the user id (a per-user group). */
  const egid = f.euid ?? 0
  const groups = new Set(w.groups ?? [egid])
  const uidOf = (t: string): number => uids.get(t) ?? f.euid ?? 0
  const gidOf = (t: string): number => gids.get(t) ?? egid
  const modeOf = (t: string): number => modes.get(t) ?? 0o644
  /** Write permission as the host decides it: the owner bit for the owner, the
   *  other bit for anyone else, everything for root; on a Windows host (no
   *  euid) only the read-only attribute, which stat shows as no owner write bit. */
  const writable = (t: string): boolean => {
    if (f.euid === undefined) return (modeOf(t) & 0o200) !== 0
    if (f.euid === 0) return true
    return (modeOf(t) & (uidOf(t) === f.euid ? 0o200 : 0o002)) !== 0
  }
  /** A new file: its bits are the create's mode less the umask, its owner the
   *  setup's user, its group the user's primary group. */
  const create = (p: string, mode: number): void => {
    files.set(p, Buffer.alloc(0))
    modes.set(p, mode & ~umask & 0o777)
    uids.delete(p)
    gids.delete(p)
    nlinks.delete(p)
  }
  const fds = new Map<number, string>()
  let nextFd = 30
  const fs = {
    constants: { X_OK: 1, W_OK },
    mkdirSync: () => {},
    // A chmod follows a link, as the host's does. Only the file's owner (or
    // root) may change its mode; a folder's (~/.claude) is not kept here.
    chmodSync: (p: string, mode: number) => {
      const t = follow(p)
      chmods.push({ path: p, mode })
      ops.push(`chmod ${p}`)
      if (w.chmodFails?.[t]) throw err(w.chmodFails[t], p)
      if (!files.has(t)) return
      if (f.euid !== undefined && f.euid !== 0 && uidOf(t) !== f.euid) throw err('EPERM', p)
      modes.set(t, mode & 0o7777)
    },
    existsSync: (p: string) => files.has(follow(p)),
    // Only the W_OK question about an existing file is answered; every other
    // probe (the tmux X_OK ladder) finds nothing, as before.
    accessSync: (p: string, mode?: number) => {
      const t = follow(p)
      if (mode === W_OK && files.has(t)) { if (writable(t)) return; throw err('EACCES', p) }
      throw err('ENOENT', p)
    },
    rmSync: (p: string) => { ops.push(`rm ${p}`); files.delete(p); modes.delete(p) },
    readFileSync: (p: string, enc?: unknown) => {
      const b = files.get(follow(p))
      if (b === undefined) throw err('ENOENT', p)
      const e = typeof enc === 'string' ? enc : (enc as { encoding?: string } | undefined)?.encoding
      return e ? b.toString(e as BufferEncoding) : Buffer.from(b)
    },
    openSync: (p: string, flags: string, mode?: number) => {
      if (flags === 'r+') {
        const t = follow(p)
        if (!files.has(t)) throw err('ENOENT', p)
        if (!writable(t)) throw err(f.euid === undefined ? 'EPERM' : 'EACCES', p)
        if (deny.has(t)) throw err('EPERM', p)
        opens.push({ path: t, flags })
        ops.push(`open:r+ ${t}`)
        fds.set(nextFd, t)
        return nextFd++
      }
      if (flags === 'wx') {
        // O_EXCL: any name already there, a link included, refuses the create.
        if (files.has(p) || links[p] !== undefined) throw err('EEXIST', p)
        create(p, mode ?? 0o666)
        opens.push({ path: p, flags, mode })
        ops.push(`open:wx ${p}`)
        fds.set(nextFd, p)
        return nextFd++
      }
      throw new Error('harness: unexpected open flags ' + flags)
    },
    fchmodSync: (fd: number, mode: number) => {
      const t = fds.get(fd)
      if (t === undefined) throw err('EBADF', String(fd))
      fchmods.push({ path: t, mode })
      ops.push(`fchmod ${t}`)
      modes.set(t, mode & 0o7777)
    },
    fstatSync: (fd: number) => {
      const t = fds.get(fd)
      if (t === undefined) throw err('EBADF', String(fd))
      ops.push(`fstat ${t}`)
      return { mode: 0o100000 | modeOf(t), uid: uidOf(t), gid: gidOf(t), nlink: nlinks.get(t) ?? 1, isFile: () => true, isDirectory: () => false }
    },
    // A user other than root may give a file only their own user id and a
    // group they are in; on a Windows host fchown does nothing.
    fchownSync: (fd: number, uid: number, gid: number) => {
      const t = fds.get(fd)
      if (t === undefined) throw err('EBADF', String(fd))
      fchowns.push({ path: t, uid, gid })
      ops.push(`fchown ${t}`)
      if (f.euid === undefined) return
      if (f.euid !== 0 && (uid !== f.euid || !groups.has(gid))) throw err('EPERM', t)
      uids.set(t, uid)
      gids.set(t, gid)
    },
    closeSync: (fd: number) => {
      const t = fds.get(fd)
      if (t === undefined) throw err('EBADF', String(fd))
      ops.push(`close ${t}`)
      fds.delete(fd)
    },
    writeFileSync: (p: string | number, c: unknown, opts?: Record<string, unknown>) => {
      const body = Buffer.isBuffer(c) ? Buffer.from(c) : Buffer.from(String(c), 'utf8')
      if (typeof p === 'number') {
        const t = fds.get(p)
        if (t === undefined) throw err('EBADF', String(p))
        writes.push({ path: t, opts: { fd: true } })
        ops.push(`write ${t}`)
        files.set(t, body)
        return
      }
      if (opts?.flag === 'wx' && (files.has(p) || links[p] !== undefined)) throw err('EEXIST', p)
      const t = follow(p)
      if (files.has(t) && (!writable(t) || deny.has(t))) throw err(deny.has(t) ? 'EPERM' : 'EACCES', p)
      writes.push({ path: p, opts })
      ops.push(`write ${p}`)
      if (!files.has(t)) create(t, (opts?.mode as number | undefined) ?? 0o666)
      files.set(t, body)
    },
    appendFileSync: (_p: string, c: unknown) => { traces.push(String(c)) },
    // A link whose target is not there, or a file that is not there, has no
    // real path (a folder, such as the home folder, always has one).
    realpathSync: (p: string) => {
      const t = follow(p)
      if (!files.has(t) && (links[p] !== undefined || /\.json$/.test(p))) throw err('ENOENT', p)
      return t
    },
    statSync: (p: string) => {
      const t = follow(p)
      if (w.statFails?.[t]) throw err(w.statFails[t], p)
      if (!files.has(t)) throw err('ENOENT', p)
      const plain = !(w.notFile ?? []).includes(t)
      return { mode: (plain ? 0o100000 : 0o010000) | modeOf(t), uid: uidOf(t), gid: gidOf(t), nlink: nlinks.get(t) ?? 1, isFile: () => plain, isDirectory: () => false }
    },
    lstatSync: (p: string) => {
      if (links[p] !== undefined) return { mode: 0o120777, uid: f.euid ?? 0, nlink: 1, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
      if (!files.has(p)) throw err('ENOENT', p)
      return { mode: 0o100000 | modeOf(p), uid: uidOf(p), nlink: nlinks.get(p) ?? 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
    },
    renameSync: (a: string, b: string) => {
      const code = w.renameFails?.[b]
      if (code) throw err(code, b)
      // rename(2) needs only the folder's write permission; Windows refuses
      // to replace a read-only file.
      if (f.euid === undefined && files.has(b) && !writable(b)) throw err('EPERM', b)
      const v = files.get(a)
      if (v === undefined) throw err('ENOENT', a)
      renames.push({ from: a, to: b })
      ops.push(`rename ${a} ${b}`)
      // The name now holds the renamed file: a link that stood there is gone,
      // and the mode, owner, link count and ACL are those of the renamed file.
      delete links[b]
      files.set(b, v)
      modes.set(b, modeOf(a))
      uids.set(b, uidOf(a))
      gids.set(b, gidOf(a))
      nlinks.delete(b)
      deny.delete(b)
      files.delete(a)
      modes.delete(a)
      gids.delete(a)
    },
  }
  const childProcess = {
    execSync: () => { throw new Error('not found') },
    execFileSync: () => { throw new Error('not found') },
    spawn: () => { throw new Error('not in this test') },
  }
  const req = (name: string): unknown => {
    if (name === 'fs') return fs
    if (name === 'os') return { homedir: () => f.home }
    if (name === 'path') return f.path
    if (name === 'child_process') return childProcess
    throw new Error('harness: unexpected require ' + name)
  }
  const out: string[] = []
  const proc: Record<string, unknown> = { env: {}, pid: PID, stdout: { write: (c: unknown) => { out.push(String(c)); return true } } }
  if (f.euid !== undefined) proc.geteuid = () => f.euid
  // eslint-disable-next-line no-new-func -- deliberate: this IS the harness.
  new Function('require', 'process', f.script())(req, proc)
  expect(fds.size, 'every file the setup opened is closed').toBe(0)
  return { ops, files, writes, renames, opens, fchmods, fchowns, chmods, modes, gids, links, traces, printed: out.join('') }
}

/** The operations, in order, on one path (a temporary file), without the path. */
const opsOn = (r: Run, p: string): string[] => r.ops.filter((o) => o.split(' ').slice(1).includes(p)).map((o) => o.split(' ')[0])

const utf8 = (o: unknown): Buffer => Buffer.from(JSON.stringify(o), 'utf8')
const bomUtf8 = (o: unknown): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(o), 'utf8')])
const utf16 = (o: unknown): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(o), 'utf16le')])

/** The user's own settings: deny rules, a model and a Stop hook of theirs. */
const USER = {
  permissions: { deny: ['Bash(rm:*)'] },
  model: 'opus',
  hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'user-stop.sh' }] }] },
}
/** The same, plus what an older build of the app wrote there. */
const WITH_APP_KEYS = {
  ...USER,
  statusLine: { type: 'command', command: 'CLAUDE_MULTI_SESSION_ID=x node ~/.claude/conductor-ssh-statusline.js' },
  mcpServers: {
    conductor: { type: 'sse', url: 'http://localhost:1/sse' },
    'conductor-vision': { type: 'sse', url: 'http://localhost:2/sse' },
    mine: { command: 'my-server' },
  },
}
/** WITH_APP_KEYS once the app's keys are removed. */
const TIDIED = { ...USER, mcpServers: { mine: { command: 'my-server' } } }

describe.each(FLAVOURS)('the user\'s settings.json on a $name', (f) => {
  const claude = f.path.join(f.home, '.claude')
  const SP = f.path.join(claude, 'settings.json')
  const TMP = f.path.join(claude, `.settings.json.ccc-${PID}.tmp`)
  const left = (r: Run): string => r.traces.filter((t) => t.includes('user-settings-left')).join('')
  const session = (r: Run): Record<string, unknown> => JSON.parse(r.files.get(f.path.join(claude, `settings-${SID}.json`))!.toString('utf8')) as Record<string, unknown>
  /** No write of any kind reached the settings file or a temporary file for it. */
  const untouched = (r: Run): void => {
    expect(r.writes.filter((x) => x.path === SP || x.path === TMP)).toEqual([])
    expect(r.renames.filter((x) => x.to === SP || x.from === TMP)).toEqual([])
    expect(r.opens.filter((x) => x.path === TMP)).toEqual([])
  }

  it('a missing file stays missing, and setup completes', () => {
    const r = runSetup(f, { files: new Map() })
    expect(r.files.has(SP)).toBe(false)
    untouched(r)
    expect(left(r)).toBe('')
    expect(r.printed).toContain(`setup ok ${NONCE} `)
  })

  // Mutation to prove this can fail: write the file back whatever was read
  // (a plain file is then rewritten in another layout).
  it('a plain UTF-8 file with none of the app\'s keys is left byte for byte, and the session inherits it', () => {
    const bytes = Buffer.from(JSON.stringify(USER) + '\n', 'utf8')
    const r = runSetup(f, { files: new Map([[SP, bytes]]) })
    expect(r.files.get(SP)!.equals(bytes)).toBe(true)
    untouched(r)
    expect(left(r)).toBe('')
    expect(session(r)).toMatchObject({ permissions: USER.permissions, model: 'opus' })
  })

  // Claude Code reads both of these in full. Mutation to prove this can
  // fail: decode the file as UTF-8 text as it stands.
  for (const [label, make] of [['a UTF-8 byte-order mark', bomUtf8], ['UTF-16LE', utf16]] as const) {
    it(`a file saved with ${label} and none of the app's keys is left byte for byte, and the session inherits all of it`, () => {
      const bytes = make(USER)
      const r = runSetup(f, { files: new Map([[SP, bytes]]) })
      expect(r.files.get(SP)!.equals(bytes)).toBe(true)
      untouched(r)
      expect(left(r)).toBe('')
      const s = session(r)
      expect(s.permissions).toEqual(USER.permissions)
      expect(s.model).toBe('opus')
      expect(s.hooks).toEqual(USER.hooks)
    })
  }

  // Mutation to prove this can fail: write the result back as plain UTF-8, or
  // without its byte-order mark.
  for (const [label, make, pre, enc] of [
    ['plain UTF-8', utf8, Buffer.alloc(0), 'utf8'],
    ['a UTF-8 byte-order mark', bomUtf8, Buffer.from([0xef, 0xbb, 0xbf]), 'utf8'],
    ['UTF-16LE', utf16, Buffer.from([0xff, 0xfe]), 'utf16le'],
  ] as const) {
    it(`a file saved as ${label} holding the app's old keys loses only those keys, and keeps its encoding`, () => {
      const r = runSetup(f, { files: new Map([[SP, make(WITH_APP_KEYS)]]) })
      const expected = Buffer.concat([pre, Buffer.from(JSON.stringify(TIDIED, null, 2), enc)])
      expect(r.files.get(SP)!.equals(expected)).toBe(true)
      expect(left(r)).toBe('')
    })
  }

  // Mutation to prove this can fail: write the settings file in place, create
  // the temporary file without the fchmod, or write the content before the
  // fchown or the fchmod (it would then sit, for a moment, in a file with the
  // user's primary group, or with the bits the umask left).
  it('the write goes to an exclusive temporary file in the same folder, given the file\'s group and mode before the content, renamed over it', () => {
    // On a POSIX host the file is in a group of the user's other than the
    // primary one, so the temporary file needs the fchown; a Windows host
    // reports group 0 for both and has none.
    const posix = f.euid !== undefined
    const r = runSetup(f, { files: new Map([[SP, utf8(WITH_APP_KEYS)]]), modes: { [SP]: 0o600 }, ...(posix ? { gids: { [SP]: 2000 }, groups: [EUID, 2000] } : {}) })
    expect(r.writes.filter((x) => x.path === SP)).toEqual([])
    expect(r.opens.filter((x) => x.path === TMP)).toEqual([{ path: TMP, flags: 'wx', mode: 0o600 }])
    expect(r.fchmods.filter((x) => x.path === TMP)).toEqual([{ path: TMP, mode: 0o600 }])
    expect(r.writes.filter((x) => x.path === TMP).map((x) => x.opts)).toEqual([{ fd: true }])
    expect(r.renames.filter((x) => x.to === SP)).toEqual([{ from: TMP, to: SP }])
    expect(opsOn(r, TMP)).toEqual(['rm', 'open:wx', 'fstat', ...(posix ? ['fchown'] : []), 'fchmod', 'write', 'close', 'rename'])
    expect(r.files.has(TMP)).toBe(false)
    expect(r.modes.get(SP)).toBe(0o600)
    if (posix) expect(r.gids.get(SP)).toBe(2000)
  })

  // The umask applies to a create, not to fchmod. Mutation to prove this can
  // fail: drop the fchmod (the create's mode alone is narrowed by the umask).
  if (f.euid !== undefined) {
    for (const [mode, umask] of [[0o664, 0o022], [0o644, 0o077], [0o600, 0o022]] as const) {
      it(`a ${mode.toString(8)} file keeps exactly ${mode.toString(8)} under umask ${umask.toString(8).padStart(3, '0')} when the app's old keys are removed`, () => {
        const r = runSetup(f, { files: new Map([[SP, utf8(WITH_APP_KEYS)]]), modes: { [SP]: mode }, umask })
        expect(JSON.parse(r.files.get(SP)!.toString('utf8'))).toEqual(TIDIED)
        expect(r.modes.get(SP)).toBe(mode)
        expect(left(r)).toBe('')
      })
    }
  }

  it('a settings file that is a link stays a link: the file it points at is the one rewritten, from its own folder', () => {
    const target = f.path.join(f.home, 'dotfiles', 'claude-settings.json')
    const targetTmp = f.path.join(f.home, 'dotfiles', `.claude-settings.json.ccc-${PID}.tmp`)
    const r = runSetup(f, { files: new Map([[target, utf8(WITH_APP_KEYS)]]), links: { [SP]: target } })
    expect(JSON.parse(r.files.get(target)!.toString('utf8'))).toEqual(TIDIED)
    expect(r.renames.filter((x) => x.to === target)).toEqual([{ from: targetTmp, to: target }])
    expect(r.files.has(SP)).toBe(false)
    expect(r.renames.filter((x) => x.to === SP)).toEqual([])
  })

  it('a rename that fails leaves the file as it was, removes the temporary file, and says why in conductor-shim.log', () => {
    const bytes = utf8(WITH_APP_KEYS)
    const r = runSetup(f, { files: new Map([[SP, bytes]]), renameFails: { [SP]: 'EPERM' } })
    expect(r.files.get(SP)!.equals(bytes)).toBe(true)
    expect(r.files.has(TMP)).toBe(false)
    expect(left(r)).toContain(`user-settings-left sid=${SID} why=EPERM\n`)
    expect(r.printed).toContain(`setup ok ${NONCE} `)
  })

  // A rename needs only the folder's write permission, so it would replace a
  // file that a write in place could not change, or split it from its other
  // name. Such a file is left as it is, with one line in conductor-shim.log.
  const leftFor = (r: Run, why: string): void => {
    const lines = r.traces.filter((t) => t.includes('user-settings-left'))
    expect(lines).toHaveLength(1)
    expect(lines[0].endsWith(` user-settings-left sid=${SID} why=${why}\n`)).toBe(true)
  }

  // Mutation to prove this can fail: drop the open-for-writing check.
  it('a read-only (0444) file holding the app\'s old keys is left byte for byte, and says why', () => {
    const bytes = utf8(WITH_APP_KEYS)
    const r = runSetup(f, { files: new Map([[SP, bytes]]), modes: { [SP]: 0o444 } })
    expect(r.files.get(SP)!.equals(bytes)).toBe(true)
    untouched(r)
    expect(r.files.has(TMP)).toBe(false)
    leftFor(r, 'readonly')
    expect(r.printed).toContain(`setup ok ${NONCE} `)
  })

  // On Windows an access W_OK check reads only the read-only attribute, so a
  // file whose ACL denies the user writing passes it (on POSIX, so does an
  // append-only file); an open for writing in place answers by the ACL and
  // the file flags too. Mutation to prove this can fail: check with
  // access W_OK instead of the open.
  it('a file that does not open for writing in place, although its mode and read-only attribute allow it, is left byte for byte, and says why', () => {
    const bytes = utf8(WITH_APP_KEYS)
    const r = runSetup(f, { files: new Map([[SP, bytes]]), modes: { [SP]: f.euid === undefined ? 0o666 : 0o644 }, denyWrite: [SP] })
    expect(r.files.get(SP)!.equals(bytes)).toBe(true)
    untouched(r)
    leftFor(r, 'readonly')
    expect(r.printed).toContain(`setup ok ${NONCE} `)
  })

  // Mutation to prove this can fail: drop the nlink check, or allow two names.
  it('a file with a second name (a hard link) holding the app\'s old keys is left byte for byte, and both names keep it', () => {
    const bytes = utf8(WITH_APP_KEYS)
    const other = f.path.join(f.home, 'dotfiles', 'settings.json')
    const r = runSetup(f, { files: new Map([[SP, bytes], [other, Buffer.from(bytes)]]), nlinks: { [SP]: 2, [other]: 2 } })
    expect(r.files.get(SP)!.equals(bytes)).toBe(true)
    expect(r.files.get(other)!.equals(bytes)).toBe(true)
    untouched(r)
    leftFor(r, 'hardlink')
  })

  // Mutation to prove this can fail: write when the file cannot be stated.
  it('a file that cannot be stated is left byte for byte, and says why', () => {
    const bytes = utf8(WITH_APP_KEYS)
    const r = runSetup(f, { files: new Map([[SP, bytes]]), statFails: { [SP]: 'EIO' } })
    expect(r.files.get(SP)!.equals(bytes)).toBe(true)
    untouched(r)
    leftFor(r, 'EIO')
  })

  // The owner rule is POSIX only: a Windows host has no process.geteuid, and
  // the cases above already clean a file whose stat reports uid 0 there.
  // Mutation to prove this can fail: drop the owner check (the 0666 file is
  // then replaced), or call geteuid where there is none (Windows setup throws).
  if (f.euid !== undefined) {
    for (const [label, uid, mode] of [
      ['owned by root with mode 0644 in the user\'s folder', 0, 0o644],
      ['owned by another user and writable by everyone (0666)', 1001, 0o666],
    ] as const) {
      it(`a file ${label}, holding the app's old keys, is left byte for byte, and says why`, () => {
        const bytes = utf8(WITH_APP_KEYS)
        const r = runSetup(f, { files: new Map([[SP, bytes]]), uids: { [SP]: uid }, modes: { [SP]: mode } })
        expect(r.files.get(SP)!.equals(bytes)).toBe(true)
        untouched(r)
        leftFor(r, 'owner')
      })
    }
  }

  // A replaced file keeps its group, so its group bits apply to the same group
  // as before rather than to the user's primary group. Mutation to prove this
  // can fail: drop the fchown.
  if (f.euid !== undefined) {
    it('a 0664 file in a group the user is in keeps that group and its mode when the app\'s old keys are removed', () => {
      const r = runSetup(f, { files: new Map([[SP, utf8(WITH_APP_KEYS)]]), modes: { [SP]: 0o664 }, gids: { [SP]: 2000 }, groups: [EUID, 2000] })
      expect(JSON.parse(r.files.get(SP)!.toString('utf8'))).toEqual(TIDIED)
      expect(r.gids.get(SP)).toBe(2000)
      expect(r.modes.get(SP)).toBe(0o664)
      expect(left(r)).toBe('')
    })

    // Keeping the mode in another group would give that group what only the
    // file's own group had (0640, 0664), or give the group the file keeps out
    // what everyone else has (0604). Mutation to prove this can fail: ignore a
    // failed fchown, or compare the bits one way only (either way round).
    for (const mode of [0o640, 0o664, 0o604]) {
      it(`a ${mode.toString(8)} file in a group the user is not in (its group bits differ from its other bits) is left byte for byte, and says why`, () => {
        const bytes = utf8(WITH_APP_KEYS)
        const r = runSetup(f, { files: new Map([[SP, bytes]]), modes: { [SP]: mode }, gids: { [SP]: 3000 } })
        expect(r.files.get(SP)!.equals(bytes)).toBe(true)
        expect(r.gids.get(SP)).toBe(3000)
        expect(r.modes.get(SP)).toBe(mode)
        expect(r.files.has(TMP)).toBe(false)
        leftFor(r, 'group')
      })
    }

    // What a sudo chown to the user leaves behind: the user's file, in root's
    // group. Its group bits give that group exactly what everyone else has,
    // so the file is still cleaned, in the user's own group, with its mode.
    // Mutation to prove this can fail: leave the file on any failed fchown.
    for (const mode of [0o600, 0o644, 0o666]) {
      it(`a ${mode.toString(8)} file in a group the user is not in (its group bits the same as its other bits) is still cleaned, keeping its mode`, () => {
        const r = runSetup(f, { files: new Map([[SP, utf8(WITH_APP_KEYS)]]), modes: { [SP]: mode }, gids: { [SP]: 0 } })
        expect(JSON.parse(r.files.get(SP)!.toString('utf8'))).toEqual(TIDIED)
        expect(r.modes.get(SP)).toBe(mode)
        expect(r.gids.get(SP)).toBe(EUID)
        expect(r.files.has(TMP)).toBe(false)
        expect(left(r)).toBe('')
      })
    }
  }

  it('a file the user owns, with one name and writable, is still cleaned (through a link, too)', () => {
    const target = f.path.join(f.home, 'dotfiles', 'claude-settings.json')
    const r = runSetup(f, { files: new Map([[SP, utf8(WITH_APP_KEYS)]]), modes: { [SP]: 0o600 } })
    expect(JSON.parse(r.files.get(SP)!.toString('utf8'))).toEqual(TIDIED)
    expect(left(r)).toBe('')
    const viaLink = runSetup(f, { files: new Map([[target, utf8(WITH_APP_KEYS)]]), links: { [SP]: target } })
    expect(JSON.parse(viaLink.files.get(target)!.toString('utf8'))).toEqual(TIDIED)
    expect(left(viaLink)).toBe('')
  })

  // Claude Code reports such a file and leaves it alone; so does the setup.
  // Mutation to prove this can fail: take {} for a file that does not parse
  // and write it back.
  for (const [label, bytes, why] of [
    ['an empty file', Buffer.alloc(0), 'parse'],
    ['a file with a trailing comma, holding the app\'s old statusLine', Buffer.from('{"model":"opus","statusLine":{"type":"command","command":"node ~/.claude/conductor-ssh-statusline.js"},}', 'utf8'), 'parse'],
    ['UTF-16LE with no byte-order mark', Buffer.from(JSON.stringify(WITH_APP_KEYS), 'utf16le'), 'parse'],
    ['JSON null', Buffer.from('null', 'utf8'), 'type'],
    ['a JSON array', Buffer.from('[{"mcpServers":{"conductor":{}}}]', 'utf8'), 'type'],
  ] as const) {
    it(`${label} is left byte for byte, named in conductor-shim.log, and setup completes`, () => {
      const r = runSetup(f, { files: new Map([[SP, bytes]]) })
      expect(r.files.get(SP)!.equals(bytes)).toBe(true)
      untouched(r)
      expect(left(r)).toContain(`user-settings-left sid=${SID} why=${why}\n`)
      expect(r.printed).toContain(`setup ok ${NONCE} `)
    })
  }

  // A file whose bytes do not come back from its decoded text (here a byte
  // that is not UTF-8) cannot be written back without changing what else is
  // in it. Mutation to prove this can fail: write back without that check.
  it('a file that cannot be written back faithfully is left byte for byte even when it holds the app\'s old keys, and says why', () => {
    const json = JSON.stringify({ note: 'caf_', ...WITH_APP_KEYS })
    const bytes = Buffer.from(json, 'latin1')
    bytes[json.indexOf('caf_') + 3] = 0xe9
    const r = runSetup(f, { files: new Map([[SP, bytes]]) })
    expect(r.files.get(SP)!.equals(bytes)).toBe(true)
    untouched(r)
    expect(left(r)).toContain(`user-settings-left sid=${SID} why=encoding\n`)
  })
})

// The POSIX setup marks the session folder trusted in ~/.claude.json (the
// Windows setup has no such write). It writes through the same writer as the
// settings.json tidy, so the write keeps the file's mode, its link and its one
// name, and a file the user could not write in place is left as it is. The
// statement after the trust write then makes a file the user owns owner-only
// (the describe after this one), so a file with group or other bits ends with
// its owner's bits alone.
describe('~/.claude.json on a POSIX host, when the setup marks the session folder trusted', () => {
  const f = FLAVOURS[0]
  const p = f.path
  const CJ = p.join(f.home, '.claude.json')
  const TMP = p.join(f.home, `..claude.json.ccc-${PID}.tmp`)
  /** The user's own config: the setup must keep all of it. */
  const CONFIG = { numStartups: 7, theme: 'dark', projects: { '/srv/other': { hasTrustDialogAccepted: true } } }
  const trusted = (b: Buffer | undefined): boolean => {
    const c = JSON.parse(b!.toString('utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }
    return c.projects?.[f.home]?.hasTrustDialogAccepted === true
  }
  const kept = (b: Buffer | undefined): void => {
    expect(JSON.parse(b!.toString('utf8'))).toMatchObject(CONFIG)
  }
  const leftFor = (r: Run, why: string): void => {
    const lines = r.traces.filter((t) => t.includes('claude-json-left'))
    expect(lines).toHaveLength(1)
    expect(lines[0].endsWith(` claude-json-left sid=${SID} why=${why}\n`)).toBe(true)
  }
  const noneLeft = (r: Run): void => { expect(r.traces.filter((t) => t.includes('claude-json-left'))).toEqual([]) }
  /** The claude-json-mode lines in conductor-shim.log. */
  const modeLines = (r: Run): string[] => r.traces.filter((t) => t.includes('claude-json-mode'))
  /** Nothing was written to, opened for, or renamed onto the file or a temporary file for it. */
  const untouched = (r: Run, target = CJ): void => {
    const tmp = p.join(p.dirname(target), `.${p.basename(target)}.ccc-${PID}.tmp`)
    expect(r.writes.filter((x) => [CJ, TMP, target, tmp].includes(x.path))).toEqual([])
    expect(r.renames.filter((x) => [CJ, target].includes(x.to))).toEqual([])
    expect(r.opens.filter((x) => x.flags === 'wx')).toEqual([])
    expect(r.files.has(TMP) || r.files.has(tmp)).toBe(false)
  }

  // Mutation to prove this can fail: drop the fchmod (the create's mode is
  // then narrowed or widened by the umask), or create the temporary file with
  // no mode. A file with group or other bits then ends owner-only.
  for (const [mode, umask] of [[0o600, 0o022], [0o600, 0o002], [0o664, 0o077], [0o644, 0o077]] as const) {
    it(`a ${mode.toString(8)} file is written keeping exactly ${mode.toString(8)} under umask ${umask.toString(8).padStart(3, '0')}, keeps the rest of its content, gets the flag, and ends ${(mode & 0o700).toString(8)}`, () => {
      const r = runSetup(f, { files: new Map([[CJ, utf8(CONFIG)]]), modes: { [CJ]: mode }, umask })
      expect(trusted(r.files.get(CJ))).toBe(true)
      kept(r.files.get(CJ))
      expect(r.fchmods).toEqual([{ path: TMP, mode }])
      expect(r.modes.get(CJ)).toBe(mode & 0o700)
      expect(modeLines(r)).toHaveLength(mode & 0o077 ? 1 : 0)
      expect(r.files.has(TMP)).toBe(false)
      // Already in the temporary file's group: no fchown is asked for, so a
      // mount that refuses every chown still gets the flag.
      expect(r.fchowns).toEqual([])
      noneLeft(r)
      expect(r.printed).toContain(`setup ok ${NONCE} `)
    })
  }

  // Mutation to prove this can fail: write in place, create the temporary
  // file without 'wx', its mode or the fchmod, or write the content before
  // the fchown or the fchmod.
  it('the write goes to an exclusive temporary file next to it, given the file\'s group and mode before the content, renamed over it', () => {
    const r = runSetup(f, { files: new Map([[CJ, utf8(CONFIG)]]), modes: { [CJ]: 0o600 }, gids: { [CJ]: 2000 }, groups: [EUID, 2000] })
    expect(r.writes.filter((x) => x.path === CJ)).toEqual([])
    expect(r.opens.filter((x) => x.flags === 'wx')).toEqual([{ path: TMP, flags: 'wx', mode: 0o600 }])
    expect(r.fchowns).toEqual([{ path: TMP, uid: EUID, gid: 2000 }])
    expect(r.fchmods).toEqual([{ path: TMP, mode: 0o600 }])
    expect(r.writes.filter((x) => x.path === TMP).map((x) => x.opts)).toEqual([{ fd: true }])
    expect(r.renames).toEqual([{ from: TMP, to: CJ }])
    expect(opsOn(r, TMP)).toEqual(['rm', 'open:wx', 'fstat', 'fchown', 'fchmod', 'write', 'close', 'rename'])
    expect(trusted(r.files.get(CJ))).toBe(true)
    expect(r.gids.get(CJ)).toBe(2000)
    expect(r.modes.get(CJ)).toBe(0o600)
  })

  // Mutation to prove these can fail: drop the fchown (the file then has the
  // user's primary group, or is replaced with it).
  it('a 0640 file in a group the user is in is written keeping that group and its mode, gets the flag, and ends 0600 in that group', () => {
    const r = runSetup(f, { files: new Map([[CJ, utf8(CONFIG)]]), modes: { [CJ]: 0o640 }, gids: { [CJ]: 2000 }, groups: [EUID, 2000] })
    expect(trusted(r.files.get(CJ))).toBe(true)
    expect(r.gids.get(CJ)).toBe(2000)
    expect(r.fchmods).toEqual([{ path: TMP, mode: 0o640 }])
    expect(r.modes.get(CJ)).toBe(0o600)
    noneLeft(r)
  })

  // The trust write leaves the file; the statement after it still makes the
  // file owner-only, in its own group (the flag lands on a later connect).
  // Mutation to prove these can fail: ignore a failed fchown, or compare the
  // bits one way only (either way round).
  for (const mode of [0o640, 0o664, 0o604]) {
    it(`a ${mode.toString(8)} file in a group the user is not in (its group bits differ from its other bits) keeps its content byte for byte and its group, its temporary file removed, says why, and ends 0600`, () => {
      const bytes = utf8(CONFIG)
      const r = runSetup(f, { files: new Map([[CJ, bytes]]), modes: { [CJ]: mode }, gids: { [CJ]: 3000 } })
      expect(r.files.get(CJ)!.equals(bytes)).toBe(true)
      expect(r.gids.get(CJ)).toBe(3000)
      expect(r.modes.get(CJ)).toBe(0o600)
      expect(r.renames).toEqual([])
      expect(r.opens.filter((x) => x.flags === 'wx')).toEqual([{ path: TMP, flags: 'wx', mode }])
      expect(r.files.has(TMP)).toBe(false)
      leftFor(r, 'group')
      expect(r.printed).toContain(`setup ok ${NONCE} `)
    })
  }

  // What a sudo chown of ~/.claude.json to the user leaves behind: the user's
  // file, in root's group. The folder is still marked trusted, as before.
  // Mutation to prove this can fail: leave the file on any failed fchown.
  for (const mode of [0o600, 0o644, 0o666]) {
    it(`a ${mode.toString(8)} file in a group the user is not in (its group bits the same as its other bits) still gets the flag, written keeping its mode and content, and ends 0600`, () => {
      const r = runSetup(f, { files: new Map([[CJ, utf8(CONFIG)]]), modes: { [CJ]: mode }, gids: { [CJ]: 0 } })
      expect(trusted(r.files.get(CJ))).toBe(true)
      kept(r.files.get(CJ))
      expect(r.fchmods).toEqual([{ path: TMP, mode }])
      expect(r.modes.get(CJ)).toBe(0o600)
      expect(r.gids.get(CJ)).toBe(EUID)
      expect(r.files.has(TMP)).toBe(false)
      noneLeft(r)
      expect(r.printed).toContain(`setup ok ${NONCE} `)
    })
  }

  // Mutation to prove this can fail: rename onto ~/.claude.json itself rather
  // than onto the file it points at (the link is then replaced).
  it('a ~/.claude.json that is a link stays a link: the file it points at gets the flag, from its own folder, and keeps its mode', () => {
    const target = p.join(f.home, 'dotfiles', 'claude.json')
    const targetTmp = p.join(f.home, 'dotfiles', `.claude.json.ccc-${PID}.tmp`)
    const r = runSetup(f, { files: new Map([[target, utf8(CONFIG)]]), links: { [CJ]: target }, modes: { [target]: 0o600 } })
    expect(r.links[CJ]).toBe(target)
    expect(r.files.has(CJ)).toBe(false)
    expect(trusted(r.files.get(target))).toBe(true)
    kept(r.files.get(target))
    expect(r.modes.get(target)).toBe(0o600)
    expect(r.renames).toEqual([{ from: targetTmp, to: target }])
    noneLeft(r)
  })

  // Mutation to prove this can fail: create the file when a link whose target
  // is missing stands at its name (the link is then replaced).
  it('a link at ~/.claude.json whose target is missing is left as it is, and says why', () => {
    const target = p.join(f.home, 'dotfiles', 'claude.json')
    const r = runSetup(f, { files: new Map(), links: { [CJ]: target } })
    expect(r.links[CJ]).toBe(target)
    expect(r.files.has(CJ)).toBe(false)
    expect(r.files.has(target)).toBe(false)
    untouched(r, target)
    leftFor(r, 'ENOENT')
    expect(r.printed).toContain(`setup ok ${NONCE} `)
  })

  // Claude Code creates this file 0600. Mutation to prove this can fail:
  // create it with no mode, or drop the fchmod.
  for (const umask of [0o022, 0o000]) {
    it(`a missing ~/.claude.json is created 0600 under umask ${umask.toString(8).padStart(3, '0')}, with the flag`, () => {
      const r = runSetup(f, { files: new Map(), umask })
      expect(trusted(r.files.get(CJ))).toBe(true)
      expect(r.modes.get(CJ)).toBe(0o600)
      expect(r.opens.filter((x) => x.flags === 'wx')).toEqual([{ path: TMP, flags: 'wx', mode: 0o600 }])
      expect(r.fchowns).toEqual([])
      expect(r.files.has(TMP)).toBe(false)
      noneLeft(r)
    })
  }

  // A rename needs only the folder's write permission, so it would replace a
  // file that a write in place could not change, or split it from its other
  // name. Such a file is left as it is, with one line in conductor-shim.log,
  // and the session still starts (Claude Code asks once about the folder).
  // Mutations to prove these can fail: drop the nlink check; drop the owner
  // check; drop the open-for-writing check, or use access W_OK for it.
  for (const [label, world, why] of [
    ['with a second name (a hard link)', {}, 'hardlink'],
    ['that is read-only (0444)', { modes: { [CJ]: 0o444 } }, 'readonly'],
    ['that does not open for writing in place although its mode allows it (an append-only file)', { modes: { [CJ]: 0o600 }, denyWrite: [CJ] }, 'readonly'],
    ['owned by root with mode 0644', { uids: { [CJ]: 0 }, modes: { [CJ]: 0o644 } }, 'owner'],
    ['owned by another user and writable by everyone (0666)', { uids: { [CJ]: 1001 }, modes: { [CJ]: 0o666 } }, 'owner'],
  ] as const) {
    it(`a file ${label} is left byte for byte, and says why`, () => {
      const bytes = utf8(CONFIG)
      const other = p.join(f.home, 'dotfiles', 'claude.json')
      const files = new Map([[CJ, bytes]])
      if (why === 'hardlink') files.set(other, Buffer.from(bytes))
      const extra: Partial<World> = why === 'hardlink' ? { nlinks: { [CJ]: 2, [other]: 2 } } : {}
      const r = runSetup(f, { files, ...world, ...extra })
      expect(r.files.get(CJ)!.equals(bytes)).toBe(true)
      if (why === 'hardlink') expect(r.files.get(other)!.equals(bytes)).toBe(true)
      untouched(r)
      leftFor(r, why)
      expect(r.printed).toContain(`setup ok ${NONCE} `)
    })
  }

  // Mutation to prove this can fail: leave the temporary file, or say nothing.
  it('a rename that fails leaves the file as it was, removes the temporary file, and says why', () => {
    const bytes = utf8(CONFIG)
    const r = runSetup(f, { files: new Map([[CJ, bytes]]), modes: { [CJ]: 0o600 }, renameFails: { [CJ]: 'EXDEV' } })
    expect(r.files.get(CJ)!.equals(bytes)).toBe(true)
    expect(r.modes.get(CJ)).toBe(0o600)
    expect(r.files.has(TMP)).toBe(false)
    leftFor(r, 'EXDEV')
    expect(r.printed).toContain(`setup ok ${NONCE} `)
  })

  it('a folder already marked trusted is not written at all', () => {
    const bytes = utf8({ ...CONFIG, projects: { [f.home]: { hasTrustDialogAccepted: true } } })
    const r = runSetup(f, { files: new Map([[CJ, bytes]]), modes: { [CJ]: 0o600 } })
    expect(r.files.get(CJ)!.equals(bytes)).toBe(true)
    untouched(r)
    expect(r.opens).toEqual([])
    noneLeft(r)
  })
})

// Claude Code keeps the mode it finds when it saves ~/.claude.json. On every
// connect, whether or not the trust flag is written, the POSIX setup clears
// the group and other bits of the file's real path (keeping the owner's, so a
// read-only file stays read-only) when that is a plain file with one name
// owned by the user running it, with one claude-json-mode line in
// conductor-shim.log. Nothing else about the file changes.
describe('~/.claude.json on a POSIX host is made owner-only on every connect', () => {
  const f = FLAVOURS[0]
  const p = f.path
  const CJ = p.join(f.home, '.claude.json')
  /** Already marked trusted for the session folder: the trust write does not run. */
  const TRUSTED = { numStartups: 7, theme: 'dark', projects: { [f.home]: { hasTrustDialogAccepted: true } } }
  const modeLines = (r: Run): string[] => r.traces.filter((t) => t.includes('claude-json-mode'))
  /** No write of content, temporary file or rename reached the file (or the file a link names). */
  const notWritten = (r: Run): void => {
    expect(r.writes.filter((x) => /claude\.json/.test(x.path))).toEqual([])
    expect(r.renames).toEqual([])
    expect(r.opens.filter((x) => x.flags === 'wx')).toEqual([])
  }
  /** The chmods the setup asked for on anything but the ~/.claude folder. */
  const fileChmods = (r: Run): Run['chmods'] => r.chmods.filter((x) => x.path !== p.join(f.home, '.claude'))

  // Mutations to prove these can fail: drop the statement; run it only when
  // the trust flag is written; set 0600 whatever the owner's bits were; say
  // nothing in conductor-shim.log.
  for (const [mode, ends] of [[0o644, 0o600], [0o664, 0o600], [0o640, 0o600], [0o604, 0o600], [0o666, 0o600], [0o444, 0o400], [0o755, 0o700]] as const) {
    it(`a ${mode.toString(8)} file in a folder already trusted becomes ${ends.toString(8)}, its content byte for byte, with one line in conductor-shim.log`, () => {
      const bytes = utf8(TRUSTED)
      const r = runSetup(f, { files: new Map([[CJ, bytes]]), modes: { [CJ]: mode } })
      expect(r.files.get(CJ)!.equals(bytes)).toBe(true)
      expect(r.modes.get(CJ)).toBe(ends)
      expect(fileChmods(r)).toEqual([{ path: CJ, mode: ends }])
      notWritten(r)
      const lines = modeLines(r)
      expect(lines).toHaveLength(1)
      expect(lines[0].endsWith(` claude-json-mode sid=${SID} set to owner-only was=${mode.toString(8)}\n`)).toBe(true)
      expect(r.printed).toContain(`setup ok ${NONCE} `)
    })
  }

  // Mutation to prove this can fail: chmod (or log) whatever the mode.
  for (const mode of [0o600, 0o400, 0o700]) {
    it(`a ${mode.toString(8)} file is not changed, and nothing is said`, () => {
      const r = runSetup(f, { files: new Map([[CJ, utf8(TRUSTED)]]), modes: { [CJ]: mode } })
      expect(r.modes.get(CJ)).toBe(mode)
      expect(fileChmods(r)).toEqual([])
      expect(modeLines(r)).toEqual([])
    })
  }

  // Mutation to prove this can fail: change the link rather than the file it
  // names (a chmod through the link reaches the same file on the host, so the
  // call is checked by the path it names).
  it('a ~/.claude.json that is a link stays a link, and the file it points at becomes 0600', () => {
    const target = p.join(f.home, 'dotfiles', 'claude.json')
    const bytes = utf8(TRUSTED)
    const r = runSetup(f, { files: new Map([[target, bytes]]), links: { [CJ]: target }, modes: { [target]: 0o644 } })
    expect(r.links[CJ]).toBe(target)
    expect(r.files.has(CJ)).toBe(false)
    expect(r.files.get(target)!.equals(bytes)).toBe(true)
    expect(r.modes.get(target)).toBe(0o600)
    expect(fileChmods(r)).toEqual([{ path: target, mode: 0o600 }])
    expect(modeLines(r)).toHaveLength(1)
  })

  // A mode belongs to the file, so a file with another name would change for
  // that name too; a file another user owns is theirs to set; something that
  // is not a plain file is not a config file. Mutations to prove these can
  // fail: drop the nlink check, the owner check, or the plain-file check.
  for (const [label, world] of [
    ['with a second name (a hard link)', { nlinks: { [CJ]: 2 } }],
    ['owned by another user', { uids: { [CJ]: 1001 } }],
    ['owned by root', { uids: { [CJ]: 0 } }],
    ['that is not a plain file (a FIFO, say)', { notFile: [CJ] }],
  ] as const) {
    it(`a 0644 file ${label} is not changed, and nothing is said`, () => {
      const bytes = utf8(TRUSTED)
      const r = runSetup(f, { files: new Map([[CJ, bytes]]), modes: { [CJ]: 0o644 }, ...world })
      expect(r.files.get(CJ)!.equals(bytes)).toBe(true)
      expect(r.modes.get(CJ)).toBe(0o644)
      expect(fileChmods(r)).toEqual([])
      expect(modeLines(r)).toEqual([])
      expect(r.printed).toContain(`setup ok ${NONCE} `)
    })
  }

  // Mutation to prove this can fail: write the line before the chmod.
  it('a chmod that fails leaves the file as it was, says nothing, and setup completes', () => {
    const r = runSetup(f, { files: new Map([[CJ, utf8(TRUSTED)]]), modes: { [CJ]: 0o644 }, chmodFails: { [CJ]: 'EROFS' } })
    expect(r.modes.get(CJ)).toBe(0o644)
    expect(modeLines(r)).toEqual([])
    expect(r.printed).toContain(`setup ok ${NONCE} `)
  })

  it('no ~/.claude.json, or a link at it whose target is missing: nothing is changed, and nothing is said', () => {
    const target = p.join(f.home, 'dotfiles', 'claude.json')
    for (const w of [{ files: new Map<string, Buffer>() }, { files: new Map<string, Buffer>(), links: { [CJ]: target } }]) {
      const r = runSetup(f, w)
      expect(fileChmods(r).filter((x) => x.path === CJ || x.path === target)).toEqual([])
      expect(modeLines(r)).toEqual([])
    }
  })

  // The trust write runs first and keeps the file's mode; the file is made
  // owner-only after it, so a first connect leaves it 0600 with the flag.
  it('on a first connect a 0644 file gets the flag and ends 0600', () => {
    const r = runSetup(f, { files: new Map([[CJ, utf8({ numStartups: 7, theme: 'dark' })]]), modes: { [CJ]: 0o644 } })
    expect((JSON.parse(r.files.get(CJ)!.toString('utf8')) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> }).projects[f.home].hasTrustDialogAccepted).toBe(true)
    expect(r.modes.get(CJ)).toBe(0o600)
    expect(r.ops.indexOf(`chmod ${CJ}`)).toBeGreaterThan(r.ops.findIndex((o) => o.startsWith('rename ') && o.endsWith(` ${CJ}`)))
    expect(modeLines(r)).toHaveLength(1)
  })

  // The Windows setup does not touch ~/.claude.json's mode (a Windows host
  // keeps no such mode).
  it('the Windows setup changes no mode of ~/.claude.json', () => {
    const w = FLAVOURS[1]
    const wcj = w.path.join(w.home, '.claude.json')
    const r = runSetup(w, { files: new Map([[wcj, utf8(TRUSTED)]]), modes: { [wcj]: 0o666 } })
    expect(r.chmods.filter((x) => x.path === wcj)).toEqual([])
    expect(r.modes.get(wcj)).toBe(0o666)
    expect(w.script()).not.toContain('claude-json-mode')
  })
})
