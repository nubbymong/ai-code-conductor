// A CLI the check did not find, though its publisher's installer put it in
// its own folder (the PATH finding of the first-run test, 2026-10-10;
// ADR-024). Anthropic's native installer leaves claude.exe in
// %USERPROFILE%\.local\bin off PATH; a restart cannot help, so the app says
// so and, on Windows, may add exactly that one folder to the user's PATH.
// PURE: the file system, the registry and the PATH write are stand-ins;
// nothing is started and the real registry and PATH are never touched.
import { describe, it, expect, vi } from 'vitest'
import * as path from 'path'
import {
  pathHintFor, addToolFolderToPath, shellProfileFor, POSIX_PATH_LINE, FISH_PATH_LINE, POSIX_PATH_COMMANDS,
  type InstallFolderDeps, type EntryKind,
} from '../../../src/main/install-folder-path'
import type { RegistryPaths, UserPathAppendResult } from '../../../src/main/windows-registry-path'

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

  it("Codex on Windows has no folder of its own to add: OpenAI's installer puts its folder on PATH itself", async () => {
    const codexExe = w('C:/Users/u/.local/bin/codex.exe')
    expect(await pathHintFor('codex', deps({ entries: { [LOCAL_BIN]: 'dir', [codexExe]: 'file' } }).d)).toBeUndefined()
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

  it('refused, with nothing written, when the tool is not there as a regular file, off Windows, or for a provider with no folder', async () => {
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
