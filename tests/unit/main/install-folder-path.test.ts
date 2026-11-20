// A CLI the check did not find, though its publisher's installer put it in
// its own folder (the PATH finding of the first-run test, 2026-10-10;
// ADR-024). Anthropic's native installer leaves claude.exe in
// %USERPROFILE%\.local\bin off PATH, and npm leaves Codex in its own
// %APPDATA%\npm off the PATH of an account that did not install Node.js
// (aicc_planning#288); a restart cannot help, so the app says so and, on
// Windows, may add exactly that one folder to the user's PATH.
// PURE: the file system, the registry and the PATH write are stand-ins;
// nothing is started and the real registry and PATH are never touched.
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  pathHintFor, addToolFolderToPath, shellProfileFor, installFolderDeps, POSIX_PATH_LINE, FISH_PATH_LINE, POSIX_PATH_COMMANDS,
  type InstallFolderDeps, type EntryKind,
} from '../../../src/main/install-folder-path'
import type { RegistryPaths, UserPathAppendResult } from '../../../src/main/windows-registry-path'
import { findOnWindowsPathAsync, pathWalkDeadline, WINDOWS_PATH_WALK_WAIT_MS } from '../../../src/main/windows-programs'

const BS = String.fromCharCode(92)
const DS = '$'
/** The run-once append the copied text is, into `target` (as the user's shell writes it). */
const appendTo = (target: string) => "printf '" + BS + 'n' + 'export PATH="$HOME/.local/bin:$PATH"' + BS + "n' >> \"" + target + '"'
const ZSH_COMMAND = appendTo(DS + '{ZDOTDIR:-$HOME}/.zprofile')
const w = (s: string) => s.replace(/\//g, BS)
const HOME = w('C:/Users/u')
const LOCAL_BIN = w('C:/Users/u/.local/bin')
const CLAUDE_EXE = w('C:/Users/u/.local/bin/claude.exe')
const NPM = w('C:/Users/u/AppData/Roaming/npm')

function deps(over: Partial<InstallFolderDeps> & { entries?: Record<string, EntryKind>; files?: string[]; registry?: RegistryPaths | Error } = {}) {
  const entries = over.entries ?? {}
  const files = new Set((over.files ?? []).map((f) => f.toLowerCase()))
  const log = vi.fn()
  const appendUserPath = vi.fn(async (_folder: string): Promise<UserPathAppendResult> => ({ outcome: 'added', broadcast: true }))
  const d: InstallFolderDeps = {
    platform: 'win32',
    home: HOME,
    env: { Path: w('C:/Windows/system32;') + NPM, USERPROFILE: HOME, SystemRoot: w('C:/Windows') },
    entryKind: async (p) => entries[p] ?? 'none',
    isFile: async (p) => files.has(p.toLowerCase()),
    readRegistry: async () => {
      const r = over.registry ?? { machine: { kind: 'ExpandString', data: w('%SystemRoot%/system32') }, user: { kind: 'ExpandString', data: w('%USERPROFILE%/AppData/Roaming/npm') } }
      if (r instanceof Error) throw r
      return r
    },
    appendUserPath,
    loginShell: () => '/bin/zsh',
    exists: () => false,
    log,
    ...over,
  }
  return { d, log, appendUserPath }
}

const INSTALLED = { [LOCAL_BIN]: 'dir', [CLAUDE_EXE]: 'file' } as Record<string, EntryKind>

describe('what a check that found nothing says (Windows)', () => {
  it("claude.exe in Anthropic's folder, which neither PATH names: Add it to PATH for me, the folder shown, never the real path", async () => {
    const { d } = deps({ entries: INSTALLED })
    const hint = await pathHintFor('claude', d)
    expect(hint).toEqual({ kind: 'add-to-path', folder: '%USERPROFILE%' + BS + '.local' + BS + 'bin' })
    expect(JSON.stringify(hint)).not.toContain('Users')
  })

  it('a link there (or a folder that is a link) is not taken for an install', async () => {
    for (const entries of [{ [LOCAL_BIN]: 'dir', [CLAUDE_EXE]: 'link' }, { [LOCAL_BIN]: 'link', [CLAUDE_EXE]: 'file' }, { [LOCAL_BIN]: 'dir' }] as Array<Record<string, EntryKind>>) {
      expect(await pathHintFor('claude', deps({ entries }).d), JSON.stringify(entries)).toBeUndefined()
    }
  })

  it('the folder already in the registry PATH but not taken in by this process: a restart is what helps', async () => {
    const { d } = deps({ entries: INSTALLED, registry: { machine: null, user: { kind: 'ExpandString', data: w('%USERPROFILE%/.local/bin/') } } })
    expect(await pathHintFor('claude', d)).toEqual({ kind: 'restart' })
  })

  it('not in that folder: a restart is advised only when the tool is in a folder the registry PATH names', async () => {
    const reg = { machine: null, user: { kind: 'String', data: w('D:/tools') } }
    expect(await pathHintFor('claude', deps({ registry: reg, files: [w('D:/tools/claude.cmd')] }).d)).toEqual({ kind: 'restart' })
    expect(await pathHintFor('claude', deps({ registry: reg }).d)).toBeUndefined()
    expect(await pathHintFor('codex', deps({ registry: reg, files: [w('D:/tools/codex.exe')] }).d)).toEqual({ kind: 'restart' })
    expect(await pathHintFor('claude', deps({ registry: new Error('no answer') }).d)).toBeUndefined()
  })

  // aicc_planning#190 (F6): a REG_EXPAND_SZ entry such as
  // %NVM_SYMLINK% whose variable was defined after the app started stays
  // unexpanded here, so the tool in it cannot be seen; a restart is what
  // helps, never "not installed". Expanded against this process's
  // environment only, from the one registry read.
  it('a registry PATH entry still naming a %VARIABLE% this process does not have, and the tool not found: a restart is what helps', async () => {
    const reg = { machine: { kind: 'ExpandString', data: w('%SystemRoot%/system32') }, user: { kind: 'ExpandString', data: w('%USERPROFILE%/AppData/Roaming/npm;') + '%NVM_SYMLINK%' } }
    const readRegistry = vi.fn(async () => reg)
    expect(await pathHintFor('claude', deps({ readRegistry }).d)).toEqual({ kind: 'restart', unresolved: true })
    expect(readRegistry).toHaveBeenCalledTimes(1)
    // In the system Path too, and for either tool.
    const sys = { machine: { kind: 'ExpandString', data: '%NVM_SYMLINK%;' + w('%SystemRoot%/system32') }, user: null }
    expect(await pathHintFor('codex', deps({ registry: sys }).d)).toEqual({ kind: 'restart', unresolved: true })
  })

  // A dangling entry such as %JAVA_HOME%\bin, left
  // in the PATH after JAVA_HOME was removed, is common on developer
  // machines. Windows kept it unexpanded in the PATH this process started
  // with, so a restart changes nothing, and advising one meant the advice
  // came back after every restart, hiding "not installed" and the install's
  // exit code. Only an entry this process's PATH does not hold counts.
  it('a dangling %VARIABLE% entry this process started with, still in its PATH as it stands: no hint', async () => {
    const jdk = w('%JAVA_HOME%/bin')
    const reg = { machine: { kind: 'ExpandString', data: w('%SystemRoot%/system32;') + jdk }, user: { kind: 'ExpandString', data: w('%USERPROFILE%/AppData/Roaming/npm') } }
    const started = deps({ registry: reg })
    started.d.env.Path = w('C:/Windows/system32;') + jdk + ';' + NPM
    expect(await pathHintFor('claude', started.d)).toBeUndefined()
    expect(await pathHintFor('codex', started.d)).toBeUndefined()
    // Compared as Windows compares folders: any case, a trailing backslash, quotes.
    const spelled = deps({ registry: { machine: null, user: { kind: 'ExpandString', data: jdk } } })
    spelled.d.env.Path = w('C:/Windows/system32;"%java_home%/BIN/"')
    expect(await pathHintFor('claude', spelled.d)).toBeUndefined()
    // In the user Path, where it was held too.
    const user = deps({ registry: { machine: null, user: { kind: 'ExpandString', data: w('%USERPROFILE%/AppData/Roaming/npm;%IDEA_HOME%/bin') } } })
    user.d.env.Path = w('C:/Windows/system32;%IDEA_HOME%/bin')
    expect(await pathHintFor('claude', user.d)).toBeUndefined()
  })

  it('a dangling entry the PATH held, beside one added since the app started: the new one still advises a restart', async () => {
    const reg = { machine: { kind: 'ExpandString', data: w('%JAVA_HOME%/bin') }, user: { kind: 'ExpandString', data: '%NVM_HOME%;%NVM_SYMLINK%' } }
    const mixed = deps({ registry: reg })
    mixed.d.env.Path = w('C:/Windows/system32;%JAVA_HOME%/bin')
    expect(await pathHintFor('claude', mixed.d)).toEqual({ kind: 'restart', unresolved: true })
    // An entry whose variable this process has is never counted, held or not.
    mixed.d.env.NVM_HOME = w('C:/nvm')
    mixed.d.env.NVM_SYMLINK = w('C:/nvm4w/nodejs')
    expect(await pathHintFor('claude', mixed.d)).toBeUndefined()
  })

  it('fully expanded against this process and not found: no hint; a REG_SZ entry Windows never expands is no reason to restart', async () => {
    const reg = { machine: null, user: { kind: 'ExpandString', data: w('%USERPROFILE%/AppData/Roaming/npm;') + '%NVM_SYMLINK%' } }
    const defined = deps({ registry: reg })
    defined.d.env.NVM_SYMLINK = w('C:/nvm4w/nodejs')
    expect(await pathHintFor('claude', defined.d)).toBeUndefined()
    expect(await pathHintFor('claude', deps({ registry: { machine: null, user: { kind: 'String', data: '%NVM_SYMLINK%' } } }).d)).toBeUndefined()
    // A folder that merely has two % signs in it names no variable.
    expect(await pathHintFor('claude', deps({ registry: { machine: null, user: { kind: 'ExpandString', data: w('D:/50%/off%/bin') } } }).d)).toBeUndefined()
    // The tool found in an expanded folder still says only "restart".
    expect(await pathHintFor('claude', deps({ registry: { machine: null, user: { kind: 'ExpandString', data: w('D:/tools;') + '%NVM_SYMLINK%' } }, files: [w('D:/tools/claude.cmd')] }).d)).toEqual({ kind: 'restart' })
  })

  it("Codex on Windows is never looked for in Anthropic's folder: OpenAI's installer puts its own folder on PATH itself", async () => {
    const codexExe = w('C:/Users/u/.local/bin/codex.exe')
    expect(await pathHintFor('codex', deps({ entries: { [LOCAL_BIN]: 'dir', [codexExe]: 'file' } }).d)).toBeUndefined()
  })
})

// aicc_planning#288 (option A): `npm install -g @openai/codex` on Windows
// puts codex.cmd in npm's own default folder, %APPDATA%\npm, which the
// Node.js installer adds to the PATH of the account that ran it only. On
// another account the check found nothing and the page said the Codex CLI
// was not found (the VM, 2026-10-13). Main now looks in that one folder,
// built from %APPDATA% in this process's environment as npm builds its own
// default, and offers to add it as it does for Claude Code. Nothing is
// started to ask npm, and a custom npm prefix is not guessed.
describe("Codex installed with npm on Windows: npm's own folder, %APPDATA%\\npm (aicc_planning#288)", () => {
  const APPDATA = w('C:/Users/u/AppData/Roaming')
  const CODEX_CMD = w('C:/Users/u/AppData/Roaming/npm/codex.cmd')
  const CODEX_EXE = w('C:/Users/u/AppData/Roaming/npm/codex.exe')
  const SHOWN = '%APPDATA%' + BS + 'npm'
  const CODEX_NAMES = ['codex.exe', 'codex.cmd']
  /** npm's folder on neither PATH in the registry. */
  const OFF_PATH: RegistryPaths = { machine: { kind: 'ExpandString', data: w('%SystemRoot%/system32') }, user: { kind: 'ExpandString', data: w('%USERPROFILE%/.cargo/bin') } }
  /** An account whose PATH lacks npm's folder, with codex.cmd in it, and
   *  %APPDATA% as given (not set at all when null). */
  const npm = (over: Parameters<typeof deps>[0] = {}, appData: string | null = APPDATA) => {
    const r = deps({ registry: OFF_PATH, entries: { [NPM]: 'dir', [CODEX_CMD]: 'file' }, files: [CODEX_CMD], ...over })
    r.d.env.Path = w('C:/Windows/system32')
    if (appData !== null) r.d.env.APPDATA = appData
    return r
  }

  it('Codex there, the folder on neither PATH: Add it to PATH for me, the folder shown as %APPDATA%\\npm, never the real path', async () => {
    const hint = await pathHintFor('codex', npm().d)
    expect(hint).toEqual({ kind: 'add-to-path', folder: SHOWN })
    expect(JSON.stringify(hint)).not.toContain('Users')
    expect(JSON.stringify(hint)).not.toContain('Roaming')
  })

  it('codex.cmd alone counts, as codex.exe does; a link at either name, a folder of that name or another name does not', async () => {
    for (const file of [CODEX_CMD, CODEX_EXE]) {
      expect(await pathHintFor('codex', npm({ entries: { [NPM]: 'dir', [file]: 'file' } }).d), file).toEqual({ kind: 'add-to-path', folder: SHOWN })
    }
    // Codex's own lookup (providers/codex/spawn.ts) reads both names in
    // PATHEXT's order and follows links, so a link beside a regular file may
    // be what runs once the folder is on PATH.
    const linkBeside: Array<Record<string, EntryKind>> = [
      { [NPM]: 'dir', [CODEX_EXE]: 'link', [CODEX_CMD]: 'file' },
      { [NPM]: 'dir', [CODEX_EXE]: 'file', [CODEX_CMD]: 'link' },
    ]
    const notAnInstall: Array<Record<string, EntryKind>> = [
      { [NPM]: 'dir', [CODEX_CMD]: 'link' },
      { [NPM]: 'link', [CODEX_CMD]: 'file' },
      { [NPM]: 'dir', [CODEX_CMD]: 'dir' },
      { [NPM]: 'dir', [w('C:/Users/u/AppData/Roaming/npm/codex.ps1')]: 'file', [w('C:/Users/u/AppData/Roaming/npm/codex')]: 'file' },
      ...linkBeside,
    ]
    for (const entries of notAnInstall) {
      expect(await pathHintFor('codex', npm({ entries, files: [] }).d), JSON.stringify(entries)).toBeUndefined()
    }
    for (const entries of linkBeside) {
      const r = npm({ entries, files: [] })
      expect(await addToolFolderToPath('codex', r.d), JSON.stringify(entries)).toMatchObject({ outcome: 'refused' })
      expect(r.appendUserPath).not.toHaveBeenCalled()
    }
  })

  it('the folder absent, or no Codex in it: no hint, so the page reads as before', async () => {
    expect(await pathHintFor('codex', npm({ entries: {}, files: [] }).d)).toBeUndefined()
    expect(await pathHintFor('codex', npm({ entries: { [NPM]: 'dir' }, files: [] }).d)).toBeUndefined()
  })

  it('the folder on PATH: a walk of that PATH finds Codex there (found), and the hint never offers to add it', async () => {
    // This process's PATH, walked folder by folder for codex.exe or
    // codex.cmd by the shared lookup (findOnWindowsPathAsync). Codex's own
    // lookup (the async binary lookup in providers/codex/spawn.ts) reads the
    // same two names and is covered by its own suite
    // (tests/unit/providers/codex/codex-binary-path-order.test.ts); a check
    // that finds Codex asks for no hint.
    const on = npm()
    on.d.env.Path = w('C:/Windows/system32;') + NPM
    expect(await findOnWindowsPathAsync(CODEX_NAMES, on.d.env as NodeJS.ProcessEnv, on.d.isFile)).toBe(CODEX_CMD)
    // The registry's PATH (the user Path as the Node.js installer writes it,
    // or the folder written out), which this process could not take in: a
    // restart, as for Claude Code.
    for (const data of [w('%APPDATA%/npm'), NPM + BS]) {
      expect(await pathHintFor('codex', npm({ registry: { machine: null, user: { kind: 'ExpandString', data } } }).d), data).toEqual({ kind: 'restart' })
    }
  })

  it('%APPDATA% unset, empty or not a full path: no folder, so no hint and nothing added', async () => {
    for (const appData of [null, '', w('AppData/Roaming'), 'C:AppData', w('/Users/u/AppData/Roaming'), BS + BS + 'server']) {
      const r = npm({}, appData)
      expect(Object.keys(r.d.env).some((k) => k.toUpperCase() === 'APPDATA'), String(appData)).toBe(appData !== null)
      expect(await pathHintFor('codex', r.d), String(appData)).toBeUndefined()
      expect(await addToolFolderToPath('codex', r.d), String(appData)).toEqual({ outcome: 'refused', message: 'There is no install folder the app adds to PATH for this tool.' })
      expect(r.appendUserPath).not.toHaveBeenCalled()
    }
  })

  it('%APPDATA% is read from the environment in any case, never from the home folder; one that would read as more than one entry is no folder', async () => {
    const lower = npm({}, null)
    lower.d.env.appdata = APPDATA
    expect(await pathHintFor('codex', lower.d)).toEqual({ kind: 'add-to-path', folder: SHOWN })
    // A redirected %APPDATA% (a share), with the home folder elsewhere: the
    // folder is the one the environment names, still shown as %APPDATA%\npm.
    const share = BS + BS + w('srv/profiles/u/Roaming')
    const shareNpm = share + BS + 'npm'
    const redirected = npm({ home: w('D:/home/u'), entries: { [shareNpm]: 'dir', [shareNpm + BS + 'codex.cmd']: 'file' } }, share)
    expect(await pathHintFor('codex', redirected.d)).toEqual({ kind: 'add-to-path', folder: SHOWN })
    expect(await addToolFolderToPath('codex', redirected.d)).toEqual({ outcome: 'added' })
    expect(redirected.appendUserPath).toHaveBeenCalledWith(shareNpm)
    for (const appData of [APPDATA + ';' + w('D:/x'), w('C:/Users/%U%/AppData/Roaming'), '"' + APPDATA + '"']) {
      const r = npm({}, appData)
      expect(await pathHintFor('codex', r.d), appData).toBeUndefined()
      expect(await addToolFolderToPath('codex', r.d), appData).toMatchObject({ outcome: 'refused' })
      expect(r.appendUserPath).not.toHaveBeenCalled()
    }
  })

  it('Add it to PATH for me appends exactly %APPDATA%\\npm, then this process\'s PATH holds it, so Check again finds Codex', async () => {
    const { d, appendUserPath, log } = npm()
    const before = d.env.Path!
    expect(await findOnWindowsPathAsync(CODEX_NAMES, d.env as NodeJS.ProcessEnv, d.isFile)).toBeNull()
    expect(await addToolFolderToPath('codex', d)).toEqual({ outcome: 'added' })
    expect(appendUserPath).toHaveBeenCalledTimes(1)
    expect(appendUserPath).toHaveBeenCalledWith(NPM)
    expect(d.env.Path).toBe(`${before};${NPM}`)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain(NPM)
    expect(await findOnWindowsPathAsync(CODEX_NAMES, d.env as NodeJS.ProcessEnv, d.isFile)).toBe(CODEX_CMD)
  })

  it('refused, with nothing written, when Codex is not there as a regular file', async () => {
    for (const entries of [{}, { [NPM]: 'dir' }, { [NPM]: 'dir', [CODEX_CMD]: 'link' }, { [NPM]: 'link', [CODEX_CMD]: 'file' }] as Array<Record<string, EntryKind>>) {
      const { d, appendUserPath } = npm({ entries })
      const r = await addToolFolderToPath('codex', d)
      expect(r, JSON.stringify(entries)).toEqual({ outcome: 'refused', message: 'codex.cmd is not in ' + SHOWN + ', so the folder was not added.' })
      expect(appendUserPath).not.toHaveBeenCalled()
    }
  })

  // A redirected %APPDATA% on a share that is down (review of #732): a look
  // that never answers holds the check only until the deadline of the
  // looks, then the folder counts as holding nothing. A name not seen in
  // time may be a link, so codex.exe seen as a regular file does not count
  // while the look at codex.cmd has not ended.
  it('a look in the folder that never answers (a share that is down): no hint and no add once the deadline passes', async () => {
    const seen: Record<string, EntryKind> = { [NPM]: 'dir', [CODEX_CMD]: 'file' }
    const exeSeen: Record<string, EntryKind> = { [NPM]: 'dir', [CODEX_EXE]: 'file', [CODEX_CMD]: 'file' }
    for (const [hangs, kinds] of [[NPM, seen], [CODEX_CMD, seen], [CODEX_CMD, exeSeen]] as Array<[string, Record<string, EntryKind>]>) {
      const entryKind = (p: string): Promise<EntryKind> => p === hangs ? new Promise<EntryKind>(() => {}) : Promise.resolve(kinds[p] ?? 'none')
      const r = npm({ entryKind, files: [], lookDeadline: () => pathWalkDeadline(10) })
      const label = hangs + ' ' + JSON.stringify(kinds)
      expect(await pathHintFor('codex', r.d), label).toBeUndefined()
      expect(await addToolFolderToPath('codex', r.d), label).toMatchObject({ outcome: 'refused' })
      expect(r.appendUserPath, label).not.toHaveBeenCalled()
    }
  })

  it('the looks wait as long as a walk of PATH does, by default, and no longer', async () => {
    vi.useFakeTimers()
    try {
      const r = npm({ entryKind: () => new Promise<EntryKind>(() => {}), files: [] })
      let settled = false
      const hint = pathHintFor('codex', r.d).then((h) => { settled = true; return h })
      await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await hint).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("Claude Code is never looked for in npm's folder: its rows are unchanged", async () => {
    const claudeCmd = w('C:/Users/u/AppData/Roaming/npm/claude.cmd')
    const { d, appendUserPath } = npm({ entries: { [NPM]: 'dir', [claudeCmd]: 'file' }, files: [] })
    expect(await pathHintFor('claude', d)).toBeUndefined()
    expect(await addToolFolderToPath('claude', d)).toMatchObject({ outcome: 'refused' })
    expect(appendUserPath).not.toHaveBeenCalled()
  })
})

describe('what a check that found nothing says (macOS and Linux): the line and the file, never an edit', () => {
  const posix = (shell: string, platform: NodeJS.Platform, files: string[], exists: string[] = []) => deps({
    platform, home: '/home/u', env: { PATH: '/usr/bin' }, files, loginShell: () => shell, exists: (p) => exists.includes(p),
  }).d

  it('Claude Code and Codex in ~/.local/bin, which the login shell misses: the shell file it reads and the exact line', async () => {
    expect(await pathHintFor('claude', posix('/bin/zsh', 'darwin', ['/home/u/.local/bin/claude']))).toEqual({
      kind: 'shell-profile', folder: '~/.local/bin', file: '~/.zprofile', line: ZSH_COMMAND,
    })
    expect(await pathHintFor('codex', posix('/usr/bin/bash', 'linux', ['/home/u/.local/bin/codex'], ['/home/u/.profile']))).toEqual({
      kind: 'shell-profile', folder: '~/.local/bin', file: '~/.profile', line: appendTo('$HOME/.profile'),
    })
    expect(await pathHintFor('claude', posix('/bin/zsh', 'darwin', []))).toBeUndefined()
  })

  it('the file a login shell reads: zsh .zprofile; bash the first of .bash_profile, .bash_login, .profile; fish its config', () => {
    expect(shellProfileFor('/bin/zsh', 'darwin', '/Users/u', {}, () => false)).toEqual({ file: '~/.zprofile', line: ZSH_COMMAND })
    expect(shellProfileFor('/bin/zsh', 'linux', '/home/u', { ZDOTDIR: '/home/u/.zsh' }, () => false).file).toBe('$ZDOTDIR/.zprofile')
    const has = (...names: string[]) => (p: string) => names.some((n) => p === path.posix.join('/home/u', n))
    expect(shellProfileFor('/bin/bash', 'linux', '/home/u', {}, has('.bash_login', '.profile')).file).toBe('~/.bash_login')
    expect(shellProfileFor('/bin/bash', 'linux', '/home/u', {}, has('.profile')).file).toBe('~/.profile')
    expect(shellProfileFor('/bin/bash', 'linux', '/home/u', {}, has()).file).toBe('~/.profile')
    expect(shellProfileFor('/bin/bash', 'darwin', '/Users/u', {}, () => false).file).toBe('~/.bash_profile')
    expect(shellProfileFor('/usr/bin/fish', 'linux', '/home/u', {}, () => false)).toEqual({ file: '~/.config/fish/fish_variables', line: FISH_PATH_LINE })
    expect(shellProfileFor('/bin/dash', 'linux', '/home/u', {}, () => false).file).toBe('~/.profile')
  })
})

// aicc_planning#194 (F5): the copied text used to be the bare export
// line, which changes only the terminal it is pasted into, so setup still
// said "cannot be found". It is now a command run once that appends the line
// to the file shellProfileFor names: a constant per shell, never a value read
// from this process's environment (zsh's $ZDOTDIR stays literal, quoted, for
// the user's shell to expand). fish keeps fish_add_path, which saves the
// folder in fish's universal variables.
describe('the copied PATH text (macOS and Linux): a run-once append into the file named', () => {
  it('zsh: appends the export line to "${ZDOTDIR:-$HOME}/.zprofile", ZDOTDIR literal and quoted, whatever ZDOTDIR and HOME are here', () => {
    for (const env of [{}, { ZDOTDIR: '/home/u/.zsh' }] as Array<Record<string, string>>) {
      const p = shellProfileFor('/bin/zsh', 'linux', '/home/u', env, () => false)
      expect(p.line, JSON.stringify(env)).toBe(ZSH_COMMAND)
      expect(p.line).toContain('>> "' + DS + '{ZDOTDIR:-$HOME}/.zprofile"')
      expect(p.line).not.toContain('/home/u')
    }
    expect(ZSH_COMMAND).toBe("printf '" + BS + 'nexport PATH="$HOME/.local/bin:$PATH"' + BS + "n' >> \"" + DS + '{ZDOTDIR:-$HOME}/.zprofile"')
  })

  it('bash and sh: the same append, into exactly the file shellProfileFor names', () => {
    const has = (...names: string[]) => (p: string) => names.some((n) => p === path.posix.join('/home/u', n))
    const cases: Array<[string, NodeJS.Platform, (p: string) => boolean, string]> = [
      ['/bin/bash', 'linux', has('.bash_profile', '.profile'), '.bash_profile'],
      ['/bin/bash', 'linux', has('.bash_login', '.profile'), '.bash_login'],
      ['/bin/bash', 'linux', has('.profile'), '.profile'],
      ['/bin/bash', 'linux', has(), '.profile'],
      ['/bin/bash', 'darwin', has(), '.bash_profile'],
      ['/bin/sh', 'linux', has('.bash_profile'), '.profile'],
      ['/bin/dash', 'linux', has(), '.profile'],
    ]
    for (const [shell, platform, exists, name] of cases) {
      const p = shellProfileFor(shell, platform, '/home/u', { HOME: '/home/u' }, exists)
      expect(p.file, shell + ' ' + name).toBe('~/' + name)
      expect(p.line, shell + ' ' + name).toBe(appendTo('$HOME/' + name))
      expect(p.line).not.toContain('/home/u')
    }
  })

  it('each command is one of a fixed set of constants, and every one adds the export line on a line of its own', () => {
    expect(Object.values(POSIX_PATH_COMMANDS).sort()).toEqual([ZSH_COMMAND, appendTo('$HOME/.bash_login'), appendTo('$HOME/.bash_profile'), appendTo('$HOME/.profile')].sort())
    for (const c of Object.values(POSIX_PATH_COMMANDS)) {
      expect(c.startsWith("printf '" + BS + 'n' + POSIX_PATH_LINE + BS + "n' >> \"")).toBe(true)
      expect(c).not.toContain('~')
    }
  })

  it('fish: fish_add_path, run once, which fish keeps in its own variables file (in $XDG_CONFIG_HOME when that is set)', () => {
    expect(shellProfileFor('/usr/bin/fish', 'darwin', '/Users/u', {}, () => true)).toEqual({ file: '~/.config/fish/fish_variables', line: 'fish_add_path $HOME/.local/bin' })
    // Named as the variable, never its value.
    expect(shellProfileFor('/usr/bin/fish', 'linux', '/home/u', { XDG_CONFIG_HOME: '/home/u/cfg' }, () => true)).toEqual({ file: '$XDG_CONFIG_HOME/fish/fish_variables', line: 'fish_add_path $HOME/.local/bin' })
  })
})

describe('Add it to PATH for me: only ever the one folder main computes, appended', () => {
  it('appends exactly home\\.local\\bin to the user PATH, then to this process\'s PATH, at the end, nothing else changed', async () => {
    const { d, appendUserPath, log } = deps({ entries: INSTALLED })
    const before = d.env.Path!
    expect(await addToolFolderToPath('claude', d)).toEqual({ outcome: 'added' })
    expect(appendUserPath).toHaveBeenCalledTimes(1)
    expect(appendUserPath).toHaveBeenCalledWith(LOCAL_BIN)
    expect(d.env.Path).toBe(`${before};${LOCAL_BIN}`)
    expect(d.env.Path!.split(';').slice(0, before.split(';').length)).toEqual(before.split(';'))
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain(LOCAL_BIN)
    expect(log.mock.calls[0][0]).toMatch(/written/)
  })

  it('the folder is computed from the home folder alone: whatever the environment says, it is the same one', async () => {
    const { d, appendUserPath } = deps({ entries: INSTALLED })
    d.env.USERPROFILE = w('D:/elsewhere')
    d.env.LOCALAPPDATA = w('D:/evil')
    await addToolFolderToPath('claude', d)
    expect(appendUserPath).toHaveBeenCalledWith(path.win32.join(HOME, '.local', 'bin'))
  })

  it('already on the registry PATH: nothing written, and this process takes the folder in', async () => {
    const { d, appendUserPath } = deps({ entries: INSTALLED })
    appendUserPath.mockResolvedValueOnce({ outcome: 'already' })
    expect(await addToolFolderToPath('claude', d)).toEqual({ outcome: 'already' })
    expect(d.env.Path!.endsWith(`;${LOCAL_BIN}`)).toBe(true)
  })

  it('refused, with nothing written, when the tool is not there as a regular file, off Windows, or for a provider with no folder here (Codex with no %APPDATA%)', async () => {
    for (const entries of [{}, { [LOCAL_BIN]: 'dir', [CLAUDE_EXE]: 'link' }, { [LOCAL_BIN]: 'link', [CLAUDE_EXE]: 'file' }] as Array<Record<string, EntryKind>>) {
      const { d, appendUserPath } = deps({ entries })
      expect(await addToolFolderToPath('claude', d)).toMatchObject({ outcome: 'refused' })
      expect(appendUserPath).not.toHaveBeenCalled()
    }
    const codex = deps({ entries: INSTALLED })
    expect(await addToolFolderToPath('codex', codex.d)).toMatchObject({ outcome: 'refused' })
    const mac = deps({ entries: INSTALLED, platform: 'darwin', home: '/Users/u' })
    expect(await addToolFolderToPath('claude', mac.d)).toMatchObject({ outcome: 'refused' })
    expect(codex.appendUserPath).not.toHaveBeenCalled()
    expect(mac.appendUserPath).not.toHaveBeenCalled()
  })

  it('a write that fails, or a PATH that keeps changing, changes nothing here and is logged with the folder', async () => {
    const { d, appendUserPath, log } = deps({ entries: INSTALLED })
    const before = d.env.Path
    appendUserPath.mockRejectedValueOnce(new Error('powershell refused'))
    expect(await addToolFolderToPath('claude', d)).toMatchObject({ outcome: 'failed' })
    appendUserPath.mockResolvedValueOnce({ outcome: 'changed' })
    expect(await addToolFolderToPath('claude', d)).toMatchObject({ outcome: 'failed' })
    expect(d.env.Path).toBe(before)
    expect(log).toHaveBeenCalledTimes(2)
    for (const [line] of log.mock.calls) expect(line).toContain(LOCAL_BIN)
  })
})

// The real looks (installFolderDeps().entryKind): lstat is a stand-in here,
// so nothing on disk is read. A look on a share that is down holds one of
// the few threads file tests share for tens of seconds, so a path whose
// look has not ended is not looked at again until it has (review of #732).
describe('the real looks: one lstat outstanding per path', () => {
  it('a look at a path whose last look has not ended gets that look; another path, or a look after it ended, starts its own', async () => {
    const gone = () => Object.assign(new Error('gone'), { code: 'ENOENT' })
    let end: (e: Error) => void = () => {}
    const lstat = vi.spyOn(fs.promises, 'lstat')
      .mockImplementationOnce((() => new Promise((_, reject) => { end = reject })) as never)
      .mockImplementation((() => Promise.reject(gone())) as never)
    try {
      const p = w('C:/nowhere/npm')
      const first = installFolderDeps().entryKind(p)
      expect(installFolderDeps().entryKind(p)).toBe(first)
      expect(lstat).toHaveBeenCalledTimes(1)
      expect(await installFolderDeps().entryKind(w('C:/nowhere/other'))).toBe('none')
      expect(lstat).toHaveBeenCalledTimes(2)
      end(gone())
      expect(await first).toBe('none')
      expect(await installFolderDeps().entryKind(p)).toBe('none')
      expect(lstat).toHaveBeenCalledTimes(3)
    } finally {
      lstat.mockRestore()
    }
  })
})
