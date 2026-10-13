// aicc_planning#93: the REMOTE half of an SSH session's attention signal.
//
// Both scripts are taken out of the real generateRemoteSetupScript output (the
// exact bytes the remote host receives) and RUN in-process with `require` and
// `process` replaced by an in-memory filesystem and scripted devices, as
// ssh-shim-runtime-harness.test.ts does for the statusline shim:
//
//   - the setup script: writes the hook and this connection's key only when
//     asked, and gives the per-session settings file a `hooks` block that keeps
//     the user's and the project's own hooks (a --settings `hooks` key replaces
//     them) and adds this app's four command hooks;
//   - the hook: for a raising notification or a clearing event it writes ONE
//     sentinel, through the same device ladder as the statusline fallback, that
//     this side's parser takes as this session's own.
//
// Whether a hook process started by a real Claude Code can reach the
// terminal on a real host (plain SSH, SSH Persistent under tmux, macOS without
// /proc) is NOT provable here: that is the live SSH matrix's job.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as nodePath from 'path'
import { generateRemoteSetupScript, SSH_ATTENTION_HOOK, attentionHookEntries } from '../../../../src/main/providers/claude/ssh-shim'
import { parseSshAttentionPayload, remoteAttentionKey, SSH_ATTENTION_OSC_PREFIX, REMOTE_ATTENTION_HOOK_EVENTS, REMOTE_ATTENTION_CLEAR_EVENTS } from '../../../../src/main/ssh-attention'

const NONCE = 'attnNonce123'
/** This connection's attention key: what the setup writes to the key file and
 *  the hook sends (remoteAttentionKey of the nonce, never the nonce). */
const ATTN_KEY = remoteAttentionKey(NONCE)
const SID = 'sid-attn'
const HOME = '/fake-home'
const CLAUDE = `${HOME}/.claude`
const KEY = `${CLAUDE}/ccc-attn-${SID}.key`
const UP = `${CLAUDE}/ccc-attn-${SID}.up`
const HOOK_PATH = `${CLAUDE}/conductor-ssh-attention.js`
const SETUP_PID = 4242
/** This setup's own name for the hook script before it is renamed over the shared one. */
const HOOK_TMP = `${CLAUDE}/.conductor-ssh-attention-${SID}.${SETUP_PID}.tmp`

interface FakeOpts {
  files?: Record<string, string>
  /** Files given as raw bytes (a byte-order mark, UTF-16LE). */
  bytes?: Record<string, Buffer>
  charDevices?: Set<string>
  unwritable?: Set<string>
  /** readlink answers (the /proc fd walk). */
  links?: Record<string, string>
  /** readFileSync answers for paths that are not files (the /proc stat walk). */
  procFiles?: Record<string, string>
  homedir?: string
  execFileSync?: (file: string, args: string[], opts?: Record<string, unknown>) => string
  /** Paths another setup re-creates the instant they are unlinked (the race
   *  between two setups on one host): rmSync leaves them in place. */
  recreatedOnUnlink?: Set<string>
  /** Owner, group, permission bits and kind of a path, for lstat/fstat. A
   *  file in `files` defaults to uid 1000, gid 1000 (the user's own per-user
   *  group), 0644; a folder holding one (the root folder too, when any file
   *  exists) to uid 1000, gid 1000, 0755. */
  meta?: Record<string, { uid?: number; gid?: number; mode?: number; kind?: 'file' | 'dir' | 'symlink'; target?: string }>
  /** realpathSync answers; any other path is its own real path. */
  realpaths?: Record<string, string>
}

/** The user id the setup runs as in this harness (process.geteuid). */
const EUID = 1000
/** The user's own per-user group in this harness (process.getegid): the
 *  primary group, with the same number as the user id. */
const EGID = 1000
/** macOS's staff group: every account's primary group there. */
const STAFF_GID = 20
/** A group other users are in too. */
const SHARED_GID = 100
const O_NOFOLLOW = 0x20000

function makeWorld(o: FakeOpts) {
  const files = new Map<string, string>(Object.entries(o.files ?? {}))
  const bytes = new Map<string, Buffer>(Object.entries(o.bytes ?? {}))
  const has = (p: string): boolean => files.has(p) || bytes.has(p)
  /** What readFileSync answers for a file in this world: as Node does, a
   *  Buffer unless an encoding is asked for. */
  const contentOf = (p: string, enc: unknown): string | Buffer => {
    const e = typeof enc === 'string' ? enc : (enc as { encoding?: string } | undefined)?.encoding
    const b = bytes.get(p)
    if (b !== undefined) return e ? b.toString(e as BufferEncoding) : b
    const s = files.get(p)!
    return e ? s : Buffer.from(s, 'utf8')
  }
  const writes: Array<{ path: string; content: string; opts?: Record<string, unknown> }> = []
  const removed: string[] = []
  const traces: string[] = []
  const execCalls: Array<{ file: string; args: string[]; opts?: Record<string, unknown> }> = []
  const renames: Array<{ from: string; to: string }> = []
  const opened: string[] = []
  const err = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code })
  const fds = new Map<number, string>()
  let nextFd = 100
  const statOf = (p: string) => {
    const m = o.meta?.[p]
    const prefix = p.endsWith('/') ? p : p + '/'
    const isDirOfFile = [...files.keys(), ...bytes.keys()].some((f) => f.startsWith(prefix))
    const kind = m?.kind ?? (has(p) ? 'file' : isDirOfFile ? 'dir' : undefined)
    if (kind === undefined) throw err('ENOENT', p)
    const perm = m?.mode ?? (kind === 'dir' ? 0o755 : kind === 'symlink' ? 0o777 : 0o644)
    const type = kind === 'dir' ? 0o040000 : kind === 'symlink' ? 0o120000 : 0o100000
    return {
      uid: m?.uid ?? EUID,
      gid: m?.gid ?? EGID,
      mode: type | perm,
      size: files.get(p)?.length ?? bytes.get(p)?.length ?? 0,
      isDirectory: () => kind === 'dir',
      isFile: () => kind === 'file',
      isSymbolicLink: () => kind === 'symlink',
    }
  }
  const fs = {
    constants: { X_OK: 1, O_RDONLY: 0, O_NOFOLLOW, O_NONBLOCK: 0x800 },
    existsSync: (p: string) => has(p),
    mkdirSync: () => {},
    chmodSync: () => {},
    rmSync: (p: string) => { removed.push(p); if (!o.recreatedOnUnlink?.has(p)) { files.delete(p); bytes.delete(p) } },
    readFileSync: (p: string | number, enc?: unknown) => {
      if (typeof p === 'number') {
        const f = fds.get(p)
        if (f === undefined || !has(f)) throw err('EBADF', String(p))
        return contentOf(f, enc)
      }
      if (o.procFiles && p in o.procFiles) return o.procFiles[p]
      if (!has(p)) throw err('ENOENT', p)
      return contentOf(p, enc)
    },
    lstatSync: (p: string) => statOf(p),
    openSync: (p: string, flags: number) => {
      const st = statOf(p)
      if (st.isSymbolicLink() && (flags & O_NOFOLLOW)) throw err('ELOOP', p)
      // Without O_NOFOLLOW an open follows the link to its target.
      const at = st.isSymbolicLink() ? (o.meta?.[p]?.target ?? p) : p
      opened.push(at)
      const fd = nextFd++
      fds.set(fd, at)
      return fd
    },
    fstatSync: (fd: number) => {
      const p = fds.get(fd)
      if (p === undefined) throw err('EBADF', String(fd))
      return statOf(p)
    },
    closeSync: (fd: number) => { fds.delete(fd) },
    realpathSync: (p: string) => o.realpaths?.[p] ?? p,
    writeFileSync: (p: string, c: unknown, opts?: Record<string, unknown>) => {
      if (o.unwritable?.has(p)) throw err('ENXIO', p)
      if (opts?.flag === 'wx' && files.has(p)) throw err('EEXIST', p)
      writes.push({ path: p, content: String(c), opts })
      if (!p.startsWith('/dev/')) files.set(p, String(c))
    },
    appendFileSync: (_p: string, c: unknown) => { traces.push(String(c)) },
    readlinkSync: (p: string) => {
      const v = o.links?.[p]
      if (v === undefined) throw err('ENOENT', p)
      return v
    },
    statSync: (p: string) => {
      let st: Record<string, unknown> = {}
      try { st = statOf(p) } catch { /* not in this world: only the device answer */ }
      return { ...st, isCharacterDevice: () => !!o.charDevices?.has(p) }
    },
    accessSync: (p: string) => { if (!has(p)) throw err('ENOENT', p) },
    renameSync: (a: string, b: string) => {
      if (!files.has(a)) throw err('ENOENT', a)
      renames.push({ from: a, to: b })
      files.set(b, files.get(a)!)
      files.delete(a)
    },
  }
  const childProcess = {
    execSync: () => { throw new Error('command -v: not found') },
    execFileSync: (file: string, args: string[], opts?: Record<string, unknown>) => {
      execCalls.push({ file, args, opts })
      if (o.execFileSync) return o.execFileSync(file, args, opts)
      throw new Error('no such program')
    },
    spawn: () => { throw new Error('not in this test') },
  }
  const require = (name: string): unknown => {
    if (name === 'fs') return fs
    if (name === 'os') return { homedir: () => o.homedir ?? HOME }
    if (name === 'path') return nodePath.posix
    if (name === 'child_process') return childProcess
    throw new Error('harness: unexpected require ' + name)
  }
  return { files, writes, removed, traces, execCalls, renames, opened, require }
}

function runSetup(o: FakeOpts & { includeAttention?: boolean; remotePath?: string; generate?: typeof generateRemoteSetupScript; noEuid?: boolean; egid?: number; env?: Record<string, string> }) {
  const w = makeWorld(o)
  const script = (o.generate ?? generateRemoteSetupScript)(SID, null, { includeAttention: o.includeAttention, includeConductorMcp: false }, NONCE, o.remotePath ?? '~')
  const printed: string[] = []
  const proc: Record<string, unknown> = { env: o.env ?? {}, pid: SETUP_PID, stdout: { write: (c: unknown) => { printed.push(String(c)); return true } } }
  if (!o.noEuid) {
    proc.geteuid = () => EUID
    proc.getegid = () => o.egid ?? EGID
  }
  // eslint-disable-next-line no-new-func -- deliberate: this IS the harness.
  new Function('require', 'process', script)(w.require, proc)
  return { ...w, script, printed: printed.join('') }
}

const sessionSettings = (r: { files: Map<string, string> }): Record<string, unknown> =>
  JSON.parse(r.files.get(`${CLAUDE}/settings-${SID}.json`) ?? 'null') as Record<string, unknown>

/** The hook source exactly as the setup script writes it to the remote. */
function deployedHookSource(): string {
  const script = generateRemoteSetupScript(SID, null, { includeAttention: true, includeConductorMcp: false }, NONCE)
  const marker = 'fs.writeFileSync(attnTmp,'
  const idx = script.indexOf(marker)
  expect(idx).toBeGreaterThan(-1)
  const rest = script.slice(idx + marker.length)
  const end = rest.indexOf(",{mode:0o755,flag:'wx'})")
  expect(end).toBeGreaterThan(-1)
  const source = JSON.parse(rest.slice(0, end)) as string
  expect(source).toBe(SSH_ATTENTION_HOOK)
  return source.replace(/^#!.*\n/, '')
}

/** Runs the deployed hook. `ev` is the event argument the setup writes into
 *  each hook entry (undefined: none, the fallback to the JSON's
 *  hook_event_name); `raw` replaces the JSON on stdin. Stdin arrives in
 *  16 KiB chunks, as a pipe delivers it. */
function runHook(input: Record<string, unknown>, o: FakeOpts & { env?: Record<string, string>; sid?: string; ev?: string; raw?: string }) {
  const w = makeWorld(o)
  const stdin = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  const argv = ['node', HOOK_PATH, o.sid ?? SID, ...(o.ev === undefined ? [] : [o.ev])]
  const proc = { argv, env: o.env ?? {}, pid: 500, stdin, stdout: { write: () => true } }
  // eslint-disable-next-line no-new-func -- deliberate: this IS the harness.
  new Function('require', 'process', deployedHookSource())(w.require, proc)
  const text = o.raw ?? JSON.stringify(input)
  for (let i = 0; i < text.length; i += 16384) stdin.emit('data', text.slice(i, i + 16384))
  stdin.emit('end')
  const sentinels = w.writes.filter((x) => x.path.startsWith('/dev/'))
  return { ...w, sentinels }
}

/** The JSON the sentinel carries, after the prefix and before BEL. */
function payloadOf(content: string): string {
  expect(content.startsWith(SSH_ATTENTION_OSC_PREFIX)).toBe(true)
  expect(content.endsWith(String.fromCharCode(7))).toBe(true)
  return content.slice(SSH_ATTENTION_OSC_PREFIX.length, -1)
}

const PLAIN_SSH: FakeOpts = {
  // Claude's hook child has no controlling terminal over plain SSH: /dev/tty
  // refuses, and the ancestor walk finds the pts claude holds (as the shim's).
  unwritable: new Set(['/dev/tty']),
  links: { '/proc/500/fd/0': 'pipe:[1]', '/proc/500/fd/1': 'pipe:[2]', '/proc/500/fd/2': 'pipe:[3]', '/proc/400/fd/0': '/dev/pts/3' },
  procFiles: { '/proc/500/stat': '500 (node) S 400 1 1' },
}

describe('the setup script and the attention hook', () => {
  // Mutation to prove this can fail: write the key/hook/hooks block whatever
  // includeAttention says.
  it('without includeAttention: no hook, no key, no hooks block, and a previous connection\'s key and marker are removed', () => {
    const r = runSetup({ files: { [KEY]: 'oldNonce', [UP]: '' } })
    expect(r.files.has(KEY)).toBe(false)
    expect(r.files.has(UP)).toBe(false)
    expect(r.files.has(HOOK_PATH)).toBe(false)
    expect(sessionSettings(r)).not.toHaveProperty('hooks')
  })

  it('without includeAttention the user\'s own hooks still ride the per-session file, as before', () => {
    const user = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }] }
    const r = runSetup({ files: { [`${CLAUDE}/settings.json`]: JSON.stringify({ hooks: user }) } })
    expect(sessionSettings(r).hooks).toEqual(user)
  })

  it('with includeAttention: the hook (0755, under this setup\'s own name, then renamed over the shared one) and this connection\'s key (0600) are written exclusively', () => {
    const r = runSetup({ includeAttention: true, files: { [KEY]: 'oldNonce', [UP]: '' } })
    const hook = r.writes.find((x) => x.content === SSH_ATTENTION_HOOK)
    const key = r.writes.find((x) => x.path === KEY)
    expect(hook?.path).toBe(HOOK_TMP)
    expect(hook?.opts).toMatchObject({ mode: 0o755, flag: 'wx' })
    expect(r.renames.filter((x) => x.to === HOOK_PATH)).toEqual([{ from: HOOK_TMP, to: HOOK_PATH }])
    expect(r.files.get(HOOK_PATH)).toBe(SSH_ATTENTION_HOOK)
    expect(r.files.has(HOOK_TMP)).toBe(false)
    expect(key?.content).toBe(ATTN_KEY)
    expect(key?.opts).toMatchObject({ mode: 0o600, flag: 'wx' })
    // The stale marker is gone, so no clearing hook runs until a new raise.
    expect(r.files.has(UP)).toBe(false)
  })

  it('with includeAttention: the four command hooks, the clearing ones guarded by the marker, every command exiting 0', () => {
    const r = runSetup({ includeAttention: true })
    const hooks = sessionSettings(r).hooks as Record<string, Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>>
    expect(Object.keys(hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'UserPromptSubmit'])
    const run = (ev: string): string => `node '${HOOK_PATH}' ${SID} ${ev} 2>/dev/null || true`
    expect(hooks.Notification).toEqual([{ matcher: '', hooks: [{ type: 'command', command: run('Notification'), timeout: 10 }] }])
    for (const ev of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
      expect(hooks[ev]).toEqual([{ matcher: '', hooks: [{ type: 'command', command: `[ -e '${UP}' ] && ${run(ev)}`, timeout: 10 }] }])
    }
    // Neither the nonce nor the key is ever in the settings file or a command line.
    expect(JSON.stringify(hooks)).not.toContain(NONCE)
    expect(JSON.stringify(hooks)).not.toContain(ATTN_KEY)
  })

  // The setup's completion line prints the nonce (pty-manager matches it to
  // finish the setup), so the key the hook sends must be another value.
  // Mutation to prove this can fail: write the nonce to the key file.
  it('the key file holds the attention key, never the nonce the completion line prints', () => {
    const r = runSetup({ includeAttention: true })
    expect(r.printed).toContain(`setup ok ${NONCE} `)
    expect(r.files.get(KEY)).toBe(ATTN_KEY)
    expect(ATTN_KEY).not.toBe(NONCE)
    expect(r.printed).not.toContain(ATTN_KEY)
    // A sentinel made from the printed value is refused; one with the key is taken.
    expect(parseSshAttentionPayload(JSON.stringify({ s: SID, n: NONCE, e: 'PreToolUse' }), SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload(JSON.stringify({ s: SID, n: r.files.get(KEY), e: 'PreToolUse' }), SID, NONCE)).not.toBeNull()
  })

  // Mutation to prove this can fail: set sesCfg.hooks to the app's own block
  // alone -- the user's and the project's hooks disappear from the session.
  it('keeps the user\'s and the project\'s own hooks, in order, ahead of this app\'s, with duplicates dropped', () => {
    const userEntry = { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }
    const projEntry = { matcher: '', hooks: [{ type: 'command', command: 'project-stop' }] }
    const localEntry = { matcher: 'Edit', hooks: [{ type: 'command', command: 'local-hook' }] }
    const r = runSetup({
      includeAttention: true,
      remotePath: '~/proj/sub',
      files: {
        [`${CLAUDE}/settings.json`]: JSON.stringify({ hooks: { PreToolUse: [userEntry], Stop: 'not-an-array' } }),
        [`${HOME}/proj/sub/.claude/settings.json`]: JSON.stringify({ hooks: { Stop: [projEntry], PreToolUse: [userEntry] } }),
        [`${HOME}/proj/sub/.claude/settings.local.json`]: JSON.stringify({ hooks: { PostToolUse: [localEntry] } }),
      },
    })
    const hooks = sessionSettings(r).hooks as Record<string, unknown[]>
    expect(hooks.PreToolUse).toHaveLength(2)
    expect(hooks.PreToolUse[0]).toEqual(userEntry)
    expect(JSON.stringify(hooks.PreToolUse[1])).toContain('conductor-ssh-attention.js')
    expect(hooks.Stop).toEqual([projEntry])
    expect(hooks.PostToolUse[0]).toEqual(localEntry)
    expect(hooks.PostToolUse).toHaveLength(2)
  })

  it('the session folder\'s own project hooks are lifted outside the home folder too, when the folder and files are the user\'s', () => {
    const projEntry = { matcher: '', hooks: [{ type: 'command', command: 'srv-project' }] }
    const localEntry = { matcher: '', hooks: [{ type: 'command', command: 'srv-local' }] }
    const r = runSetup({
      includeAttention: true,
      remotePath: '/srv/work',
      files: {
        '/srv/work/.claude/settings.json': JSON.stringify({ hooks: { Stop: [projEntry] } }),
        '/srv/work/.claude/settings.local.json': JSON.stringify({ hooks: { Stop: [localEntry] } }),
      },
    })
    expect((sessionSettings(r).hooks as Record<string, unknown[]>).Stop).toEqual([projEntry, localEntry])
  })

  it('a home folder the hook command could not quote safely gets no hook, no key and no hooks block', () => {
    const r = runSetup({ includeAttention: true, homedir: '/home/a b' })
    expect(r.files.has('/home/a b/.claude/ccc-attn-sid-attn.key')).toBe(false)
    expect(r.files.has('/home/a b/.claude/conductor-ssh-attention.js')).toBe(false)
    expect(JSON.parse(r.files.get('/home/a b/.claude/settings-sid-attn.json') ?? '{}')).not.toHaveProperty('hooks')
  })

  it('a key that cannot be created leaves no hooks block (nothing could ever be accepted)', () => {
    const r = runSetup({ includeAttention: true, unwritable: new Set([KEY]) })
    expect(r.files.has(KEY)).toBe(false)
    expect(sessionSettings(r)).not.toHaveProperty('hooks')
  })

  // Replacing the shared hook script with an unlink then an exclusive create
  // lets a second setup on the same host (the sessions restored at app start)
  // create it in between; this setup's create would then fail EEXIST and the
  // session get no hooks for its whole life, untraced. Mutation to prove this
  // can fail: write the shared name directly with rmSync + flag 'wx' again.
  it('another setup re-creating the shared hook script mid-setup does not cost this session its hooks', () => {
    const r = runSetup({
      includeAttention: true,
      files: { [HOOK_PATH]: 'written by another session\'s setup', [HOOK_TMP]: 'left by a setup that died' },
      recreatedOnUnlink: new Set([HOOK_PATH]),
    })
    expect(r.files.get(HOOK_PATH)).toBe(SSH_ATTENTION_HOOK)
    expect(r.files.get(KEY)).toBe(ATTN_KEY)
    expect(Object.keys(sessionSettings(r).hooks as object).sort()).toEqual([...REMOTE_ATTENTION_HOOK_EVENTS].sort())
    expect(r.traces.join('')).not.toContain('attn-setup-fail')
  })

  // Mutation to prove this can fail: drop the attn-setup-fail trace.
  it('a setup that ends without the hook or the key says why in conductor-shim.log', () => {
    const noKey = runSetup({ includeAttention: true, unwritable: new Set([KEY]) })
    expect(noKey.traces.join('')).toContain(`attn-setup-fail sid=${SID} why=ENXIO`)
    const noHook = runSetup({ includeAttention: true, unwritable: new Set([HOOK_TMP]) })
    expect(noHook.traces.join('')).toContain(`attn-setup-fail sid=${SID} why=ENXIO`)
    expect(noHook.files.has(KEY)).toBe(false)
    expect(sessionSettings(noHook)).not.toHaveProperty('hooks')
    const unsafe = runSetup({ includeAttention: true, homedir: '/home/a b' })
    expect(unsafe.traces.join('')).toContain(`attn-setup-fail sid=${SID} why=unsafe-path`)
    // Nothing is traced when the hook was not asked for.
    expect(runSetup({}).traces.join('')).not.toContain('attn-setup-fail')
  })

  it('the hook entries are the one list: every event it is registered for, the clearing ones behind the marker', () => {
    expect(attentionHookEntries()).toEqual(REMOTE_ATTENTION_HOOK_EVENTS.map((ev) => [ev, REMOTE_ATTENTION_CLEAR_EVENTS.includes(ev)]))
    const r = runSetup({ includeAttention: true })
    const hooks = sessionSettings(r).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    expect(Object.keys(hooks).sort()).toEqual([...REMOTE_ATTENTION_HOOK_EVENTS].sort())
    for (const [ev, gated] of attentionHookEntries()) {
      const command = hooks[ev][0].hooks[0].command
      expect(command.endsWith(`${SID} ${ev} 2>/dev/null || true`), ev).toBe(true)
      expect(command.startsWith(`[ -e '${UP}' ] && `), ev).toBe(gated)
    }
  })

  // The setup's hook map is built from the one list, so an event added to it
  // reaches the remote registration. Mutation to prove this can fail: put the literal
  // {Notification,UserPromptSubmit,PreToolUse,PostToolUse} map back.
  it('an event added to the one list reaches the remote registration and the hook script, behind the marker', async () => {
    vi.resetModules()
    vi.doMock('../../../../src/main/ssh-attention', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../../../src/main/ssh-attention')>()
      return {
        ...real,
        REMOTE_ATTENTION_CLEAR_EVENTS: [...real.REMOTE_ATTENTION_CLEAR_EVENTS, 'SubagentStart'],
        REMOTE_ATTENTION_HOOK_EVENTS: [...real.REMOTE_ATTENTION_HOOK_EVENTS, 'SubagentStart'],
      }
    })
    try {
      const fresh = await import('../../../../src/main/providers/claude/ssh-shim')
      const r = runSetup({ includeAttention: true, generate: fresh.generateRemoteSetupScript })
      const hooks = sessionSettings(r).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
      expect(hooks.SubagentStart?.[0].hooks[0].command).toBe(`[ -e '${UP}' ] && node '${HOOK_PATH}' ${SID} SubagentStart 2>/dev/null || true`)
      expect(fresh.SSH_ATTENTION_HOOK).toContain('"SubagentStart"')
    } finally {
      vi.doUnmock('../../../../src/main/ssh-attention')
      vi.resetModules()
    }
  })
})

// Which project hooks the setup lifts into the per-session settings file.
// Claude Code (the repo's tracked pin, 2.1.278; see
// src/main/git-local-settings-root.ts) takes project settings from
// <cwd>/.claude/settings.json and local settings from
// <cwd>/.claude/settings.local.json and, on POSIX, from the canonical git
// root's .claude/settings.local.json when that root, its .git and its .claude
// are the user's; it reads no other ancestor folder. The setup lifts exactly
// those files (the root found with git on the host), never from the home
// folder or above it, and only when each .claude folder and file belongs to
// the user, is not a link, is not writable by others, and is writable by its
// group only when it is the user's own per-user group (the primary group, with
// the same number as the user id). A .claude or file that
// is present but not taken is traced as project-hooks-skipped.
describe('the project hooks the setup lifts', () => {
  const marker = 'other-folder-hook'
  const other = JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: marker }] }] } })
  const lifted = (r: { files: Map<string, string> }): string => JSON.stringify(sessionSettings(r).hooks ?? {})
  const skippedLine = (r: { traces: string[] }): string => r.traces.filter((t) => t.includes('project-hooks-skipped')).join('')
  const own = (command: string): string => JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command }] }] } })

  // Mutation to prove this can fail: walk up from the session folder to the
  // nearest ancestor holding a .claude settings file. Each case runs twice:
  // with no .claude in the session folder (nothing is opened or lifted), and
  // with one of the user's own there (only its files are opened).
  it('reads nothing from a folder above the session folder, outside the home folder', () => {
    for (const [remotePath, file] of [
      ['/tmp/work', '/tmp/.claude/settings.local.json'],
      ['/scratch/lab/job', '/scratch/.claude/settings.json'],
      ['/srv/a/b', '/.claude/settings.json'],
      ['~/../../tmp/work', '/tmp/.claude/settings.json'],
    ]) {
      const cwd = remotePath.replace('~/../..', '')
      const bare = runSetup({ includeAttention: true, remotePath, files: { [file]: other } })
      expect(lifted(bare), remotePath).not.toContain(marker)
      expect(bare.opened, remotePath).toEqual([])
      const ownFiles = [`${cwd}/.claude/settings.json`, `${cwd}/.claude/settings.local.json`]
      const withOwn = runSetup({
        includeAttention: true,
        remotePath,
        files: { [file]: other, [ownFiles[0]]: own('session-folder-hook'), [ownFiles[1]]: own('session-folder-local') },
      })
      expect(lifted(withOwn), remotePath).not.toContain(marker)
      expect(lifted(withOwn), remotePath).toContain('session-folder-hook')
      expect(lifted(withOwn), remotePath).toContain('session-folder-local')
      expect(withOwn.opened, remotePath).toEqual(ownFiles)
    }
  })

  it('reads nothing from a folder above the session folder inside the home folder (~/proj/.claude for ~/proj/sub)', () => {
    const r = runSetup({ includeAttention: true, remotePath: '~/proj/sub', files: { [`${HOME}/proj/.claude/settings.json`]: other } })
    expect(lifted(r)).not.toContain(marker)
  })

  // Mutation to prove this can fail: drop the "home folder or above it" check.
  it('reads no project hooks when the session folder is the home folder or above it', () => {
    for (const [remotePath, file] of [
      ['/', '/.claude/settings.json'],
      ['/', '/.claude/settings.local.json'],
      ['/home', '/home/.claude/settings.json'],
      ['/home/', '/home/.claude/settings.local.json'],
      ['~', '/home/alice/.claude/settings.local.json'],
      ['/home/alice', '/home/alice/.claude/settings.local.json'],
    ]) {
      const r = runSetup({ includeAttention: true, homedir: '/home/alice', remotePath, files: { [file]: other } })
      const ses = JSON.parse(r.files.get('/home/alice/.claude/settings-sid-attn.json') ?? '{}') as { hooks?: unknown }
      expect(ses.hooks, `${remotePath} ${file}`).toBeDefined()
      expect(JSON.stringify(ses.hooks), `${remotePath} ${file}`).not.toContain(marker)
    }
  })

  // Mutation to prove this can fail: drop the realpath comparison.
  it('a home folder reached by another spelling still counts as home (a folder above its real path is not read)', () => {
    const r = runSetup({
      includeAttention: true,
      homedir: '/home/alice',
      remotePath: '/data/home',
      realpaths: { '/home/alice': '/data/home/alice' },
      files: { '/data/home/.claude/settings.json': other },
    })
    expect(JSON.stringify(JSON.parse(r.files.get('/home/alice/.claude/settings-sid-attn.json') ?? '{}').hooks ?? {})).not.toContain(marker)
  })

  it('a session folder with no .claude lifts nothing and traces no skip', () => {
    const r = runSetup({ includeAttention: true, remotePath: '/srv/bare' })
    expect(skippedLine(r)).toBe('')
    expect(Object.keys(sessionSettings(r).hooks as object).sort()).toEqual([...REMOTE_ATTENTION_HOOK_EVENTS].sort())
  })

  // With a per-user group and umask 002 (the default on Ubuntu and the RHEL
  // family) the folder is 0775 and the files 0664, group-owned by the user's
  // own per-user group. Mutation to prove this can fail: refuse every
  // group-writable folder or file.
  it('lifts a .claude folder and files writable by the user\'s own per-user group (umask 002), with no skip traced', () => {
    const r = runSetup({
      includeAttention: true,
      remotePath: '/srv/work',
      files: { '/srv/work/.claude/settings.json': own('umask-project'), '/srv/work/.claude/settings.local.json': own('umask-local') },
      meta: {
        '/srv/work/.claude': { kind: 'dir', mode: 0o775 },
        '/srv/work/.claude/settings.json': { kind: 'file', mode: 0o664 },
        '/srv/work/.claude/settings.local.json': { kind: 'file', mode: 0o664 },
      },
    })
    expect(((sessionSettings(r).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).Stop).map((e) => e.hooks[0].command)).toEqual(['umask-project', 'umask-local'])
    expect(skippedLine(r)).toBe('')
  })

  // Claude Code reads a settings file that starts with FF FE as UTF-16LE and
  // drops a leading byte-order mark (src/main/settings-text.ts), so the hooks
  // of a file saved with a UTF-8 BOM or as UTF-16LE are lifted too. Mutation
  // to prove this can fail: parse each file as UTF-8 text as it stands.
  it('lifts the hooks of settings files saved with a UTF-8 byte-order mark or as UTF-16LE', () => {
    const r = runSetup({
      includeAttention: true,
      remotePath: '/srv/work',
      bytes: {
        '/srv/work/.claude/settings.json': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(own('project-bom'), 'utf8')]),
        '/srv/work/.claude/settings.local.json': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(own('local-utf16'), 'utf16le')]),
      },
    })
    expect(((sessionSettings(r).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).Stop ?? []).map((e) => e.hooks[0].command)).toEqual(['project-bom', 'local-utf16'])
    expect(skippedLine(r)).toBe('')
  })

  // A primary group other accounts share is not a per-user group, even though
  // it is the user's own: on macOS every account's is staff (gid 20), and a
  // new file takes its folder's group. Mutation to prove this can fail: accept
  // a group-writable folder or file whenever its group is the user's primary
  // group.
  it('a primary group other accounts share (macOS staff) does not make a group-writable .claude or file usable, and the skip is traced', () => {
    const files = { '/srv/work/.claude/settings.json': own('staff-project'), '/srv/work/.claude/settings.local.json': own('staff-local') }
    const staff = (mode: number, kind: 'file' | 'dir') => ({ kind, mode, gid: STAFF_GID })
    const viaDir = runSetup({
      includeAttention: true,
      egid: STAFF_GID,
      remotePath: '/srv/work',
      files,
      meta: { '/srv/work/.claude': staff(0o775, 'dir'), '/srv/work/.claude/settings.json': staff(0o644, 'file'), '/srv/work/.claude/settings.local.json': staff(0o644, 'file') },
    })
    expect(lifted(viaDir)).not.toContain('staff-')
    expect(skippedLine(viaDir)).toContain(`project-hooks-skipped sid=${SID} why=dir:mode\n`)
    const viaFiles = runSetup({
      includeAttention: true,
      egid: STAFF_GID,
      remotePath: '/srv/work',
      files,
      meta: { '/srv/work/.claude': staff(0o755, 'dir'), '/srv/work/.claude/settings.json': staff(0o664, 'file'), '/srv/work/.claude/settings.local.json': staff(0o664, 'file') },
    })
    expect(lifted(viaFiles)).not.toContain('staff-')
    expect(skippedLine(viaFiles)).toContain(`project-hooks-skipped sid=${SID} why=settings.json:mode,settings.local.json:mode\n`)
    // The same group, not group-writable: lifted as usual.
    const plain = runSetup({
      includeAttention: true,
      egid: STAFF_GID,
      remotePath: '/srv/work',
      files,
      meta: { '/srv/work/.claude': staff(0o755, 'dir'), '/srv/work/.claude/settings.json': staff(0o644, 'file'), '/srv/work/.claude/settings.local.json': staff(0o644, 'file') },
    })
    expect(lifted(plain)).toContain('staff-project')
    expect(lifted(plain)).toContain('staff-local')
    expect(skippedLine(plain)).toBe('')
  })

  // Mutation to prove this can fail: drop the owner check on the .claude folder.
  it('skips the session folder\'s .claude when another user owns it, even holding a file of the user\'s, and traces why', () => {
    const r = runSetup({
      includeAttention: true,
      remotePath: '/srv/work',
      files: { '/srv/work/.claude/settings.json': other },
      meta: { '/srv/work/.claude': { kind: 'dir', uid: 2000, mode: 0o755 } },
    })
    expect(lifted(r)).not.toContain(marker)
    expect(skippedLine(r)).toContain(`project-hooks-skipped sid=${SID} why=dir:owner\n`)
  })

  // Mutation to prove this can fail: drop the others-writable check or the
  // group check on the .claude folder.
  it('skips a .claude folder writable by others, or by a group other than the user\'s own, and traces why', () => {
    for (const m of [{ mode: 0o777 }, { mode: 0o757 }, { mode: 0o775, gid: SHARED_GID }, { mode: 0o770, gid: SHARED_GID }]) {
      const r = runSetup({
        includeAttention: true,
        remotePath: '/srv/work',
        files: { '/srv/work/.claude/settings.json': other },
        meta: { '/srv/work/.claude': { kind: 'dir', ...m } },
      })
      expect(lifted(r), JSON.stringify(m)).not.toContain(marker)
      expect(skippedLine(r), JSON.stringify(m)).toContain('why=dir:mode\n')
    }
  })

  // Mutation to prove this can fail: drop the owner, others-writable or group
  // check on the file.
  it('skips a settings file another user owns, or writable by others or by another group, traces why, and still reads the other one', () => {
    const ownEntry = { matcher: '', hooks: [{ type: 'command', command: 'own-local' }] }
    const cases: Array<[{ uid?: number; gid?: number; mode?: number }, string]> = [
      [{ uid: 2000 }, 'owner'],
      [{ mode: 0o646 }, 'mode'],
      [{ mode: 0o666 }, 'mode'],
      [{ mode: 0o664, gid: SHARED_GID }, 'mode'],
    ]
    for (const [fileMeta, why] of cases) {
      const r = runSetup({
        includeAttention: true,
        remotePath: '/srv/work',
        files: {
          '/srv/work/.claude/settings.json': other,
          '/srv/work/.claude/settings.local.json': JSON.stringify({ hooks: { Stop: [ownEntry] } }),
        },
        meta: { '/srv/work/.claude/settings.json': { kind: 'file', ...fileMeta } },
      })
      expect(lifted(r), JSON.stringify(fileMeta)).not.toContain(marker)
      expect((sessionSettings(r).hooks as Record<string, unknown[]>).Stop).toEqual([ownEntry])
      expect(skippedLine(r), JSON.stringify(fileMeta)).toContain(`why=settings.json:${why}\n`)
    }
  })

  // Mutation to prove this can fail: open the settings file without O_NOFOLLOW.
  it('skips a settings file that is a symbolic link, and a .claude that is one, and traces why', () => {
    const viaFile = runSetup({
      includeAttention: true,
      remotePath: '/srv/work',
      files: { '/srv/work/.claude/settings.json': other, '/srv/work/.claude/target.json': other },
      meta: { '/srv/work/.claude/settings.json': { kind: 'symlink', target: '/srv/work/.claude/target.json' } },
    })
    expect(lifted(viaFile)).not.toContain(marker)
    expect(skippedLine(viaFile)).toContain('why=settings.json:link\n')
    const viaDir = runSetup({
      includeAttention: true,
      remotePath: '/srv/work',
      files: { '/srv/work/.claude/settings.json': other },
      meta: { '/srv/work/.claude': { kind: 'symlink', mode: 0o755 } },
    })
    expect(lifted(viaDir)).not.toContain(marker)
    expect(skippedLine(viaDir)).toContain('why=dir:link\n')
  })

  // Mutation to prove this can fail: treat a missing geteuid as "any owner".
  it('lifts no project hooks where the user id cannot be read', () => {
    const r = runSetup({ includeAttention: true, noEuid: true, remotePath: '/srv/work', files: { '/srv/work/.claude/settings.json': other } })
    expect(lifted(r)).not.toContain(marker)
    // The app's own hooks are still there.
    expect(Object.keys(sessionSettings(r).hooks as object).sort()).toEqual([...REMOTE_ATTENTION_HOOK_EVENTS].sort())
  })

  // The checkout root's settings.local.json: Claude Code also reads it on a
  // host with user ids, for a session in a subfolder of a checkout or in a
  // linked worktree (from the main checkout). The setup asks git on the host.
  describe('the checkout root\'s settings.local.json', () => {
    const stops = (r: { files: Map<string, string> }): string[] =>
      (((sessionSettings(r).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).Stop) ?? []).map((e) => e.hooks[0].command)
    /** git rev-parse on the host: answers `lines` (toplevel, git dir, common
     *  dir) for that one command, refuses anything else. */
    const git = (lines: string[]) => (file: string, args: string[]): string => {
      if (file !== 'git' || args.join(' ') !== 'rev-parse --show-toplevel --git-dir --git-common-dir') throw new Error('not this command')
      return lines.join('\n') + '\n'
    }
    /** A checkout at /srv/repo: its .git folder, its .claude/settings.local.json
     *  (lifted for a session below it) and its settings.json (never lifted for
     *  a session elsewhere). */
    const REPO_FILES: Record<string, string> = {
      '/srv/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/srv/repo/.claude/settings.local.json': own('root-local'),
      '/srv/repo/.claude/settings.json': other,
    }

    // Mutation to prove this can fail: lift only the session folder's own
    // .claude.
    it('a session in a subfolder of a checkout also lifts the checkout root\'s local hooks, after its own, and not the root\'s settings.json', () => {
      const r = runSetup({
        includeAttention: true,
        remotePath: '/srv/repo/pkg',
        env: { GIT_DIR: '/elsewhere/.git', GIT_CEILING_DIRECTORIES: '/srv', HOME_KEEP: 'yes' },
        files: { ...REPO_FILES, '/srv/repo/pkg/.claude/settings.json': own('pkg-project') },
        execFileSync: git(['/srv/repo', '/srv/repo/.git', '../.git']),
      })
      expect(stops(r)).toEqual(['pkg-project', 'root-local'])
      expect(lifted(r)).not.toContain(marker)
      expect(skippedLine(r)).toBe('')
      // Asked in the session folder, with no GIT_ variable of the user's and
      // discovery across filesystems, as Claude Code's own walk has no bound.
      const call = r.execCalls.find((c) => c.file === 'git')
      expect(call?.opts?.cwd).toBe('/srv/repo/pkg')
      expect(call?.opts?.env).toEqual({ HOME_KEEP: 'yes', GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' })
    })

    // Mutation to prove this can fail: stop at the worktree (do not follow
    // its git directory to the main checkout).
    it('a session in a linked worktree also lifts the MAIN checkout\'s local hooks, and not its settings.json', () => {
      const files = {
        ...REPO_FILES,
        '/srv/repo/.git/worktrees/wt/gitdir': '/srv/wt/.git\n',
        '/srv/wt/.git': 'gitdir: /srv/repo/.git/worktrees/wt\n',
        '/srv/wt/.claude/settings.json': own('wt-project'),
      }
      const r = runSetup({ includeAttention: true, remotePath: '/srv/wt', files, execFileSync: git(['/srv/wt', '/srv/repo/.git/worktrees/wt', '/srv/repo/.git']) })
      expect(stops(r)).toEqual(['wt-project', 'root-local'])
      expect(lifted(r)).not.toContain(marker)
      const sub = runSetup({ includeAttention: true, remotePath: '/srv/wt/src', files, execFileSync: git(['/srv/wt', '/srv/repo/.git/worktrees/wt', '/srv/repo/.git']) })
      expect(stops(sub)).toEqual(['root-local'])
    })

    // Mutation to prove this can fail: drop the gitdir back-pointer check.
    it('a worktree whose git directory does not point back at it, or does not sit under the common worktrees folder, is not followed', () => {
      const base = { ...REPO_FILES, '/srv/wt/.git': 'gitdir: /srv/repo/.git/worktrees/wt\n' }
      const away = runSetup({
        includeAttention: true,
        remotePath: '/srv/wt',
        files: { ...base, '/srv/repo/.git/worktrees/wt/gitdir': '/srv/other/.git\n' },
        execFileSync: git(['/srv/wt', '/srv/repo/.git/worktrees/wt', '/srv/repo/.git']),
      })
      expect(stops(away)).toEqual([])
      const outside = runSetup({
        includeAttention: true,
        remotePath: '/srv/wt',
        files: { ...base, '/srv/repo/.git/elsewhere/wt/gitdir': '/srv/wt/.git\n' },
        execFileSync: git(['/srv/wt', '/srv/repo/.git/elsewhere/wt', '/srv/repo/.git']),
      })
      expect(stops(outside)).toEqual([])
    })

    it('no git on the host, or not a checkout: the session folder\'s own files only, and no skip traced', () => {
      for (const execFileSync of [undefined, (): string => { throw Object.assign(new Error('not a git repository'), { status: 128 }) }]) {
        const r = runSetup({ includeAttention: true, remotePath: '/srv/repo/pkg', files: { ...REPO_FILES, '/srv/repo/pkg/.claude/settings.json': own('pkg-project') }, execFileSync })
        expect(stops(r)).toEqual(['pkg-project'])
        expect(skippedLine(r)).toBe('')
      }
    })

    it('the session folder that is the checkout root lifts its local file once', () => {
      const r = runSetup({ includeAttention: true, remotePath: '/srv/repo', files: REPO_FILES, execFileSync: git(['/srv/repo', '.git', '.git']) })
      expect(stops(r)).toEqual(['root-local'])
    })

    // Claude Code's own rule: the root, its .git and its .claude must be the
    // user's, or Claude reads only the session folder's files. Not a skip of
    // the setup's, so nothing is traced.
    it('a checkout root, .git or .claude another user owns is not lifted and not traced, as Claude Code does not read it', () => {
      for (const p of ['/srv/repo', '/srv/repo/.git', '/srv/repo/.claude']) {
        const r = runSetup({
          includeAttention: true,
          remotePath: '/srv/repo/pkg',
          files: REPO_FILES,
          meta: { [p]: { kind: 'dir', uid: 2000 } },
          execFileSync: git(['/srv/repo', '/srv/repo/.git', '/srv/repo/.git']),
        })
        expect(stops(r), p).toEqual([])
        expect(skippedLine(r), p).toBe('')
      }
    })

    // Mutation to prove this can fail: skip the folder or the file checks on
    // the root's .claude.
    it('a checkout root\'s .claude or local file another user owns, writable by others or by another group, not a folder, or a link, is skipped and traced with a root- prefix', () => {
      const cases: Array<[Record<string, { uid?: number; gid?: number; mode?: number; kind?: 'file' | 'dir' | 'symlink'; target?: string }>, string]> = [
        [{ '/srv/repo/.claude': { kind: 'dir', mode: 0o777 } }, 'root-dir:mode'],
        [{ '/srv/repo/.claude': { kind: 'dir', mode: 0o775, gid: SHARED_GID } }, 'root-dir:mode'],
        [{ '/srv/repo/.claude': { kind: 'file' } }, 'root-dir:type'],
        [{ '/srv/repo/.claude': { kind: 'symlink', mode: 0o755 } }, 'root-dir:link'],
        [{ '/srv/repo/.claude/settings.local.json': { kind: 'file', uid: 2000 } }, 'root-settings.local.json:owner'],
        [{ '/srv/repo/.claude/settings.local.json': { kind: 'file', mode: 0o666 } }, 'root-settings.local.json:mode'],
        [{ '/srv/repo/.claude/settings.local.json': { kind: 'file', mode: 0o664, gid: SHARED_GID } }, 'root-settings.local.json:mode'],
        [{ '/srv/repo/.claude/settings.local.json': { kind: 'symlink', target: '/srv/repo/.claude/settings.json' } }, 'root-settings.local.json:link'],
      ]
      // Under a primary group other accounts share, a group-writable root .claude is skipped too.
      const staff = runSetup({
        includeAttention: true,
        egid: STAFF_GID,
        remotePath: '/srv/repo/pkg',
        files: REPO_FILES,
        meta: { '/srv/repo/.claude': { kind: 'dir', mode: 0o775, gid: STAFF_GID } },
        execFileSync: git(['/srv/repo', '/srv/repo/.git', '/srv/repo/.git']),
      })
      expect(stops(staff)).toEqual([])
      expect(skippedLine(staff)).toContain(`project-hooks-skipped sid=${SID} why=root-dir:mode\n`)
      for (const [meta, why] of cases) {
        const r = runSetup({ includeAttention: true, remotePath: '/srv/repo/pkg', files: REPO_FILES, meta, execFileSync: git(['/srv/repo', '/srv/repo/.git', '/srv/repo/.git']) })
        expect(stops(r), why).toEqual([])
        expect(skippedLine(r), why).toContain(`project-hooks-skipped sid=${SID} why=${why}\n`)
      }
    })

    // Mutation to prove this can fail: drop the "home folder or above it"
    // check on the root. Each case, the root folder included, has a .git and
    // a .claude the user owns, so only that check refuses it.
    it('never a checkout root that is the home folder or a folder above it', () => {
      for (const top of ['/home/alice', '/home', '/']) {
        const gitDir = top === '/' ? '/.git' : `${top}/.git`
        const local = top === '/' ? '/.claude/settings.local.json' : `${top}/.claude/settings.local.json`
        const r = runSetup({
          includeAttention: true,
          homedir: '/home/alice',
          remotePath: '/home/alice/proj',
          files: { [local]: other, [`${gitDir}/HEAD`]: 'x' },
          execFileSync: git([top, gitDir, gitDir]),
        })
        const ses = JSON.parse(r.files.get('/home/alice/.claude/settings-sid-attn.json') ?? '{}') as { hooks?: unknown }
        expect(JSON.stringify(ses.hooks ?? {}), top).not.toContain(marker)
      }
    })

    // Mutation to prove this can fail: drop the check that git's toplevel is
    // the session folder or a folder above it.
    it('a toplevel that is not the session folder or above it is not taken', () => {
      const r = runSetup({
        includeAttention: true,
        remotePath: '/srv/repo/pkg',
        files: { ...REPO_FILES, '/srv/other/.git/HEAD': 'x', '/srv/other/.claude/settings.local.json': other },
        execFileSync: git(['/srv/other', '/srv/other/.git', '/srv/other/.git']),
      })
      expect(lifted(r)).not.toContain(marker)
      expect(stops(r)).toEqual([])
    })

    // Claude Code takes the nearest .git directory or regular file walking up
    // from the session folder, whatever is in it; git passes over one that is
    // not a repository (an empty .git folder here) and answers a higher
    // checkout. Mutation to prove this can fail: take git's toplevel as it
    // stands (no walk below it).
    it('a .git git passed over, below git\'s toplevel, is the root Claude Code takes: the higher checkout\'s local file is not lifted', () => {
      const toplevel = git(['/srv/repo', '/srv/repo/.git', '/srv/repo/.git'])
      // In the session folder itself: it is its own root, so no root file.
      const atSession = runSetup({
        includeAttention: true,
        remotePath: '/srv/repo/sub',
        files: { ...REPO_FILES, '/srv/repo/sub/.claude/settings.json': own('sub-project') },
        meta: { '/srv/repo/sub/.git': { kind: 'dir' } },
        execFileSync: toplevel,
      })
      expect(stops(atSession)).toEqual(['sub-project'])
      expect(skippedLine(atSession)).toBe('')
      // In a folder between the session folder and the toplevel, as a folder
      // or as a file: that folder's own local file is the root's.
      for (const kind of ['dir', 'file'] as const) {
        const between = runSetup({
          includeAttention: true,
          remotePath: '/srv/repo/sub/deep',
          files: { ...REPO_FILES, '/srv/repo/sub/.claude/settings.local.json': own('sub-local') },
          meta: { '/srv/repo/sub/.git': { kind } },
          execFileSync: toplevel,
        })
        expect(stops(between), kind).toEqual(['sub-local'])
      }
      // With no .git below the toplevel, the toplevel's local file is lifted.
      const plain = runSetup({ includeAttention: true, remotePath: '/srv/repo/sub/deep', files: REPO_FILES, execFileSync: toplevel })
      expect(stops(plain)).toEqual(['root-local'])
    })
  })
})

describe('the attention hook on the remote', () => {
  // Mutation to prove this can fail: change the hook's prefix or field names --
  // this side's parser no longer takes what the remote wrote.
  it('plain SSH: a permission prompt is written once to the pts claude holds, and this side takes it as this session\'s raise', () => {
    const r = runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, { ...PLAIN_SSH, files: { [KEY]: `${ATTN_KEY}\n` } })
    expect(r.sentinels.map((x) => x.path)).toEqual(['/dev/pts/3'])
    const event = parseSshAttentionPayload(payloadOf(r.sentinels[0].content), SID, NONCE, 7)
    expect(event).toEqual({ sessionId: SID, event: 'Notification', payload: { notification_type: 'permission_prompt' }, ts: 7 })
    // The marker that lets the clearing hooks run was made BEFORE the raise.
    expect(r.writes.findIndex((x) => x.path === UP)).toBeLessThan(r.writes.findIndex((x) => x.path === '/dev/pts/3'))
    expect(r.files.has(UP)).toBe(true)
  })

  it('under tmux: written to the attached client\'s tty, never the pane', () => {
    const r = runHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, {
      env: { TMUX: '/tmp/tmux-1000/default,1,0' },
      files: { [KEY]: ATTN_KEY },
      charDevices: new Set(['/dev/pts/9']),
      execFileSync: (file, args) => {
        expect(file).toBe('tmux')
        expect(args).toEqual(['display-message', '-p', '#{client_tty}'])
        return '/dev/pts/9\n'
      },
    })
    expect(r.sentinels.map((x) => x.path)).toEqual(['/dev/pts/9'])
  })

  // Under tmux with no tmux the hook can run, it falls through to /dev/tty,
  // the pane, which tmux does not pass an unknown OSC from; the trace says
  // tty-in-tmux, never via=tty as if delivered. Mutation to prove this can
  // fail: trace via=tty whatever TMUX says.
  it('under tmux with no tmux it can run, the write to the pane is traced as tty-in-tmux, not as a delivery', () => {
    const r = runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, {
      env: { TMUX: '/tmp/tmux-1000/default,1,0' },
      files: { [KEY]: ATTN_KEY },
    })
    expect(r.execCalls.map((x) => x.file)).toEqual(['tmux'])
    expect(r.sentinels.map((x) => x.path)).toEqual(['/dev/tty'])
    expect(r.traces.join('')).toContain('via=tty-in-tmux')
    // Outside tmux the same write is the plain tty delivery.
    const plain = runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, { files: { [KEY]: ATTN_KEY } })
    expect(plain.traces.join('')).toMatch(/via=tty\n/)
  })

  it('a clearing event is sent while the marker is up, and the marker goes once it is delivered', () => {
    const r = runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, { files: { [KEY]: ATTN_KEY, [UP]: '' } })
    expect(r.sentinels.map((x) => x.path)).toEqual(['/dev/tty'])
    expect(JSON.parse(payloadOf(r.sentinels[0].content))).toEqual({ s: SID, n: ATTN_KEY, e: 'PostToolUse' })
    expect(r.files.has(UP)).toBe(false)
  })

  it('a raise it cannot deliver anywhere drops its marker, so the clearing hooks stay idle on that host', () => {
    const r = runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, { unwritable: new Set(['/dev/tty']), files: { [KEY]: ATTN_KEY } })
    expect(r.sentinels).toEqual([])
    expect(r.files.has(UP)).toBe(false)
    expect(r.traces.join('')).toContain('attn-fail')
  })

  it('writes nothing for an informational notification, an event it does not send, no key, or a bad id', () => {
    const files = { [KEY]: ATTN_KEY }
    expect(runHook({ hook_event_name: 'Notification', notification_type: 'auth_success' }, { files }).writes).toEqual([])
    expect(runHook({ hook_event_name: 'Stop' }, { files }).writes).toEqual([])
    expect(runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, {}).writes).toEqual([])
    expect(runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, { files: { [KEY]: 'bad nonce!' } }).writes).toEqual([])
    expect(runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, { files, sid: "x';rm" }).writes).toEqual([])
    expect(runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, { files, sid: '' }).writes).toEqual([])
  })

  // A hook that kept 64 KiB of stdin and then parsed ALL of it just to learn
  // the event would cut off a PostToolUse for a large Write or Read, fail to
  // parse it, and drop its clear, untraced.
  // The setup now names the event in each hook entry. Mutation to prove this
  // can fail: ignore the event argument (always parse stdin for the event).
  it('a clearing event over 64 KiB is still delivered: the event comes from the argument, its stdin is never parsed', () => {
    const big = { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { content: 'x'.repeat(200 * 1024) } }
    const r = runHook(big, { ev: 'PostToolUse', files: { [KEY]: ATTN_KEY, [UP]: '' } })
    expect(r.sentinels.map((x) => x.path)).toEqual(['/dev/tty'])
    expect(JSON.parse(payloadOf(r.sentinels[0].content))).toEqual({ s: SID, n: ATTN_KEY, e: 'PostToolUse' })
    expect(r.files.has(UP)).toBe(false)
    // Not even valid JSON on stdin stops a clear named by its argument.
    const junk = runHook({}, { ev: 'PreToolUse', raw: '{"truncated', files: { [KEY]: ATTN_KEY, [UP]: '' } })
    expect(junk.sentinels).toHaveLength(1)
  })

  it('with the event argument, a Notification still takes its type from stdin, and an event it does not send writes nothing', () => {
    const r = runHook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input' }, { ev: 'Notification', files: { [KEY]: ATTN_KEY } })
    expect(r.sentinels).toHaveLength(1)
    expect(JSON.parse(payloadOf(r.sentinels[0].content))).toEqual({ s: SID, n: ATTN_KEY, e: 'Notification', t: 'agent_needs_input' })
    expect(runHook({ hook_event_name: 'Notification', notification_type: 'auth_success' }, { ev: 'Notification', files: { [KEY]: ATTN_KEY } }).writes).toEqual([])
    expect(runHook({ hook_event_name: 'PostToolUse' }, { ev: 'Stop', files: { [KEY]: ATTN_KEY, [UP]: '' } }).sentinels).toEqual([])
  })
})
