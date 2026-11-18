// A Claude Code session held by the session helper sends its hooks through it
// (2.1.3-beta.8, plan section A4): the per-session settings file keeps
// PreToolUse on the hooks gateway and points the other eight events at the
// helper's hook mode, quoted for the launcher Claude Code starts a command
// hook with (Git for Windows' bash on Windows, ADR-030 probe P16 step 0;
// /bin/sh elsewhere).
//
// The writer's own secure write (owner-only folder and file) is swapped here
// for a plain write, so this file touches no folder's permissions; the
// switch's real write is covered in tests/unit/hooks/session-hooks-writer.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const w = vi.hoisted(() => ({ failWrites: false }))
vi.mock('../../../src/main/account-profiles', () => ({
  mkdirSecure: (dir: string) => { fs.mkdirSync(dir, { recursive: true }) },
  hardenCredentialDir: () => {},
  atomicWriteSecure: (file: string, data: string) => {
    if (w.failWrites) throw new Error('EPERM: the stage could not be written')
    fs.writeFileSync(file, data)
  },
}))

import {
  MVP_EVENTS,
  buildHelperHooksBlock,
  buildHooksBlock,
  helperHookCommand,
  switchHooksToHelper,
  type HelperHookTarget,
} from '../../../src/main/hooks/session-hooks-writer'

const SID = 'ag0123456789abcdef0123456789abcd'
const APP_ID = 'abcdef0123456789abcdef01'
const PORT = 19334
const SECRET = '6f1c3d2a-1b2c-4d3e-8f90-a1b2c3d4e5f6'

// A user folder with a space, an apostrophe, $, %, &, ^ and letters outside ASCII.
const WIN_HOME = "C:\\Users\\Zoë O'Brien $x %y% & ^z"
const WIN_EXE = `${WIN_HOME}\\AppData\\Local\\AI Code Conductor\\helper\\2.1.3-beta.8-0123456789ab\\aicc-helper.exe`
const WIN_STORE = `${WIN_HOME}\\AppData\\Local\\AI Code Conductor\\helper\\store`
const NIX_HOME = "/home/zoë o'brien $x %y% & ^z"
const NIX_EXE = `${NIX_HOME}/.local/share/AI Code Conductor/helper/2.1.3-beta.8-0123456789ab/aicc-helper`
const NIX_STORE = `${NIX_HOME}/.local/share/AI Code Conductor/helper/store`

const win: HelperHookTarget = { helperPath: WIN_EXE, store: WIN_STORE, sid: SID, launcher: 'git-bash' }
const nix: HelperHookTarget = { helperPath: NIX_EXE, store: NIX_STORE, sid: SID, launcher: 'sh' }

describe('the hook mode command, quoted for the launcher', () => {
  it('Git Bash (Windows): forward slashes, each path one single-quoted word, an apostrophe closed, escaped and opened again', () => {
    expect(helperHookCommand(win)).toBe(
      "'C:/Users/Zoë O'\\''Brien $x %y% & ^z/AppData/Local/AI Code Conductor/helper/2.1.3-beta.8-0123456789ab/aicc-helper.exe'" +
      " hook --store 'C:/Users/Zoë O'\\''Brien $x %y% & ^z/AppData/Local/AI Code Conductor/helper/store'" +
      ` --session ${SID}`,
    )
  })

  it('/bin/sh (macOS and Linux): the same quoting, the paths as they are', () => {
    expect(helperHookCommand(nix)).toBe(
      "'/home/zoë o'\\''brien $x %y% & ^z/.local/share/AI Code Conductor/helper/2.1.3-beta.8-0123456789ab/aicc-helper'" +
      " hook --store '/home/zoë o'\\''brien $x %y% & ^z/.local/share/AI Code Conductor/helper/store'" +
      ` --session ${SID}`,
    )
  })

  it('on Windows no double quote, and no backslash but the one that escapes an apostrophe: Claude Code\'s own quoting of the command for bash.exe cannot change it', () => {
    const cmd = helperHookCommand(win)!
    expect(cmd).not.toContain('"')
    expect(cmd.replace(/'\\''/g, '')).not.toContain('\\')
  })

  it('a path the launcher cannot take safely gives no command (the session keeps its gateway hooks)', () => {
    const bad: Array<[string, HelperHookTarget]> = [
      ['a double quote (Git Bash)', { ...win, store: 'C:\\Users\\a"b\\store' }],
      ['a line feed (Git Bash)', { ...win, helperPath: 'C:\\Users\\a\nb\\aicc-helper.exe' }],
      ['a tab (Git Bash)', { ...win, store: 'C:\\Users\\a\tb\\store' }],
      ['a C1 control character (Git Bash)', { ...win, store: 'C:\\Users\\a\u0085b\\store' }],
      ['a network path (Git Bash)', { ...win, helperPath: '\\\\server\\share\\aicc-helper.exe' }],
      ['a relative path (Git Bash)', { ...win, store: 'helper\\store' }],
      ['an empty path', { ...win, helperPath: '' }],
      ['a line feed (/bin/sh)', { ...nix, store: '/home/a\nb/store' }],
      ['a relative path (/bin/sh)', { ...nix, helperPath: 'helper/aicc-helper' }],
      ['a Windows path given to /bin/sh', { ...nix, helperPath: WIN_EXE }],
      ['a session id that breaks its pattern', { ...win, sid: 'ag 0123; rm -rf ~' }],
    ]
    for (const [what, t] of bad) {
      expect(helperHookCommand(t), what).toBeNull()
      expect(buildHelperHooksBlock(APP_ID, PORT, SECRET, t), what).toBeNull()
    }
  })
})

describe('buildHelperHooksBlock', () => {
  it('eight command entries and one PreToolUse, which stays the gateway\'s exactly', () => {
    const block = buildHelperHooksBlock(APP_ID, PORT, SECRET, win)!
    expect(Object.keys(block)).toEqual(MVP_EVENTS)
    expect(MVP_EVENTS).toHaveLength(9)
    expect(block.PreToolUse).toEqual(buildHooksBlock(APP_ID, PORT, SECRET).PreToolUse)
    expect(block.PreToolUse).toEqual([{ matcher: '', hooks: [{ type: 'http', url: `http://localhost:${PORT}/hook/${APP_ID}`, headers: { 'X-CCC-Hook-Token': SECRET } }] }])
    const command = helperHookCommand(win)
    const commands = MVP_EVENTS.filter((k) => k !== 'PreToolUse')
    expect(commands).toHaveLength(8)
    for (const kind of commands) {
      expect(block[kind], kind).toEqual([{ matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] }])
    }
    // Nothing of the gateway's in the eight: no URL, no token.
    expect(JSON.stringify(commands.map((k) => block[k]))).not.toContain(SECRET)
  })
})

describe('switchHooksToHelper: the per-session settings file, in place', () => {
  let dir: string
  let file: string
  const inherited = {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-guard.sh' }] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'project-notify.sh' }] }],
    PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'compact.sh' }] }],
  }
  /** As injectHooks writes it: the inherited hooks first, then the gateway's. */
  function writeAsSpawned(): string {
    const gw = buildHooksBlock(APP_ID, PORT, SECRET)
    const hooks: Record<string, unknown[]> = {}
    for (const [k, v] of Object.entries(inherited)) hooks[k] = [...v]
    for (const [k, v] of Object.entries(gw)) hooks[k] = [...(hooks[k] ?? []), ...v]
    const text = JSON.stringify({ statusLine: { type: 'command', command: 'statusline.js' }, permissions: { allow: ['mcp__conductor__canvas_render'] }, hooks }, null, 2)
    fs.writeFileSync(file, text)
    return text
  }

  beforeEach(() => {
    w.failWrites = false
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-hooks-switch-'))
    file = path.join(dir, `settings-${APP_ID}.json`)
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('the eight go to the hook mode, PreToolUse and every inherited hook stay as they were, and so does the rest of the file', () => {
    writeAsSpawned()
    expect(switchHooksToHelper({ settingsPath: file, sessionId: APP_ID, target: win })).toBe('switched')
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(after.statusLine).toEqual({ type: 'command', command: 'statusline.js' })
    expect(after.permissions).toEqual({ allow: ['mcp__conductor__canvas_render'] })
    const block = buildHelperHooksBlock(APP_ID, PORT, SECRET, win)!
    // Inherited first, in their order; the app's own last.
    expect(after.hooks.PreToolUse).toEqual([...inherited.PreToolUse, ...block.PreToolUse])
    expect(after.hooks.Stop).toEqual([...inherited.Stop, ...block.Stop])
    expect(after.hooks.PreCompact).toEqual(inherited.PreCompact)
    for (const kind of MVP_EVENTS) {
      if (kind === 'PreToolUse' || kind === 'Stop') continue
      expect(after.hooks[kind], kind).toEqual(block[kind])
    }
    // No gateway URL is left on any of the eight.
    for (const kind of MVP_EVENTS.filter((k) => k !== 'PreToolUse')) expect(JSON.stringify(after.hooks[kind]), kind).not.toContain('/hook/')
  })

  it('switching twice changes nothing more', () => {
    writeAsSpawned()
    expect(switchHooksToHelper({ settingsPath: file, sessionId: APP_ID, target: win })).toBe('switched')
    const once = fs.readFileSync(file, 'utf8')
    expect(switchHooksToHelper({ settingsPath: file, sessionId: APP_ID, target: win })).toBe('switched')
    expect(fs.readFileSync(file, 'utf8')).toBe(once)
  })

  it('a file with no gateway hooks of this session is left as it is', () => {
    const lookalikes: Array<[string, unknown]> = [
      ['no hooks', { statusLine: { type: 'command', command: 'statusline.js' } }],
      ['another session\'s', { hooks: buildHooksBlock('abcdef0123456789abcdef02', PORT, SECRET) }],
      ['an entry with a field of its own', { hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'http', url: `http://localhost:${PORT}/hook/${APP_ID}`, headers: { 'X-CCC-Hook-Token': SECRET }, timeout: 5 }] }] } }],
      ['another host', { hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'http', url: `http://example.test:${PORT}/hook/${APP_ID}`, headers: { 'X-CCC-Hook-Token': SECRET } }] }] } }],
    ]
    for (const [what, content] of lookalikes) {
      const text = JSON.stringify(content)
      fs.writeFileSync(file, text)
      expect(switchHooksToHelper({ settingsPath: file, sessionId: APP_ID, target: win }), what).toBe('no-gateway-hooks')
      expect(fs.readFileSync(file, 'utf8'), what).toBe(text)
    }
    fs.rmSync(file)
    expect(switchHooksToHelper({ settingsPath: file, sessionId: APP_ID, target: win })).toBe('no-gateway-hooks')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('a path the launcher cannot take, or a write that fails, leaves the file as it was', () => {
    const text = writeAsSpawned()
    expect(switchHooksToHelper({ settingsPath: file, sessionId: APP_ID, target: { ...win, store: 'C:\\a"b' } })).toBe('unsafe-path')
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
    w.failWrites = true
    expect(switchHooksToHelper({ settingsPath: file, sessionId: APP_ID, target: win })).toBe('not-written')
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
  })
})
