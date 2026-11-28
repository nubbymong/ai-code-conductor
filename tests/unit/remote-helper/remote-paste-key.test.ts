/**
 * The key a helper tab's paste sends (plan 2.1.3-beta.21, block 5.1, its App
 * bullet; ADR-032's table, the "Linux host, helper tab" row): Claude Code's
 * image paste is Ctrl+V on a Linux host, unless `keybindings.json` in the
 * config folder that tab's Claude Code uses rebinds `chat:imagePaste`. That
 * folder is `<configDir>` when the launch sets CLAUDE_CONFIG_DIR (a tab on an
 * account's own folder there), else `~/.claude`; the file is read by a new
 * host read beside CLAUDE_HOST_READS, as data, and its chord goes through the
 * package's fixed chord-to-bytes table, so a host picks at most a chord from
 * that table, never raw bytes. A configDir outside the home folder: Ctrl+V,
 * as when there is no file.
 *
 * - the Claude package's host reads: the four settings files, then the
 *   keybindings file of the folder the CLI uses; none for a sign-in, and none
 *   for a configDir outside the home folder;
 * - its launch, given what the reads found: the key (RemoteLaunch
 *   imagePasteKey), Ctrl+V by default, the rebound chord's bytes, no key for
 *   a binding the table cannot express or one that took the default away;
 * - a tab on an account folder reads that folder's file, never `~/.claude`'s;
 * - the keybindings file carries nothing into the session's settings (its
 *   `hooks` are not a settings file's);
 * - core's remoteLaunchOf asks the read through hostReadProblem's rules, and
 *   the launch it plans holds the key.
 * Red on e89996bb: no keybindings read and no key. Mutants this must catch:
 * `~/.claude`'s file read for an account folder's tab; the rebound chord
 * ignored; the keybindings file's hooks carried into the session's settings.
 */
import { describe, it, expect } from 'vitest'
import { CLAUDE_HOST_READS, claudeKeybindingsRead, claudeRemoteLaunch, REMOTE_SETTINGS_FILE } from '../../../src/main/providers/claude/remote-launch'
import { remoteLaunchOf } from '../../../src/main/remote-helper'
import { remoteHelperCommands, remoteSessionId } from '../../../src/main/remote-helper/session'
import { hostReadProblem } from '../../../src/main/remote-helper/session-files'
import type { RemoteHelperCommands, RemoteHostFile, RemoteLaunchOptions } from '../../../src/main/providers/types'
import type { RemoteMachineRecord } from '../../../src/main/remote-helper/machines'

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
}
const HELPER: RemoteHelperCommands = remoteHelperCommands(MACHINE, remoteSessionId('kb-tab'))
const ACCOUNT_DIR = '/home/nick/.aicc/accounts/p-0123456789abcdef'
const opts = (over: Partial<RemoteLaunchOptions> = {}): RemoteLaunchOptions => ({ reconnect: false, cwd: '/home/nick/work', settings: null, tools: false, ...over })
const CTRL_V = '\u0016'
const ESC_V = '\u001bv'

/** The reads a launch was asked for, each with the content given for its path (null: not there). */
function readsFor(o: RemoteLaunchOptions, content: Record<string, string>): RemoteHostFile[] {
  return claudeRemoteLaunch.hostReads(o, MACHINE).map((r) => ({ ...r, content: content[r.path] ?? null }))
}
const bindings = (chat: Record<string, string | null>) => JSON.stringify({ bindings: [{ context: 'Chat', bindings: chat }] })

describe('the Claude package reads the keybindings file of the folder the tab\'s Claude Code uses', () => {
  it('a tab on the machine\'s own sign-in: the four settings files, then ~/.claude/keybindings.json', () => {
    const reads = claudeRemoteLaunch.hostReads(opts(), MACHINE)
    expect(reads).toEqual([...CLAUDE_HOST_READS, { from: 'home', path: '.claude/keybindings.json' }])
    for (const r of reads) expect(hostReadProblem(r)).toBeNull()
  })

  it('a tab on an account\'s own folder there: that folder\'s keybindings.json, as a path under the home folder, and not ~/.claude\'s', () => {
    const reads = claudeRemoteLaunch.hostReads(opts({ configDir: ACCOUNT_DIR }), MACHINE)
    expect(reads).toEqual([...CLAUDE_HOST_READS, { from: 'home', path: '.aicc/accounts/p-0123456789abcdef/keybindings.json' }])
    expect(reads).not.toContainEqual({ from: 'home', path: '.claude/keybindings.json' })
    expect(hostReadProblem(reads.at(-1)!)).toBeNull()
  })

  it('a configDir outside the home folder, or the home folder itself: no keybindings read (the key is Ctrl+V)', () => {
    for (const configDir of ['/srv/claude-config', '/home/nicky/.claude', '/home/nick', '/home/nick/', '/home/nick//', 'relative/dir', '/home/nick/../etc', '/home/nick/my config', `/home/nick/${'a/'.repeat(15)}b`]) {
      expect(claudeKeybindingsRead(opts({ configDir }), MACHINE), configDir).toBeNull()
      expect(claudeRemoteLaunch.hostReads(opts({ configDir }), MACHINE)).toEqual(CLAUDE_HOST_READS)
      const launch = claudeRemoteLaunch.launch(opts({ configDir }), MACHINE, HELPER, readsFor(opts({ configDir }), {}))
      expect(launch.imagePasteKey).toEqual({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' })
    }
  })

  it('a sign-in tab reads nothing and has no paste key', () => {
    const o = opts({ configDir: ACCOUNT_DIR, signIn: {} })
    expect(claudeRemoteLaunch.hostReads(o, MACHINE)).toEqual([])
    expect(claudeRemoteLaunch.launch(o, MACHINE, HELPER, []).imagePasteKey).toBeUndefined()
  })
})

describe('the launch gives the tab its paste key from what the read found', () => {
  it('no file there, or one that is not a keybindings file: Ctrl+V, Claude Code\'s default on Linux', () => {
    for (const text of [undefined, 'not json', '{"bindings": 3}']) {
      const content: Record<string, string> = text === undefined ? {} : { '.claude/keybindings.json': text }
      const launch = claudeRemoteLaunch.launch(opts(), MACHINE, HELPER, readsFor(opts(), content))
      expect(launch.imagePasteKey, String(text)).toEqual({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' })
    }
  })

  it('a file that rebinds the image paste: that chord\'s bytes, from the fixed table', () => {
    const launch = claudeRemoteLaunch.launch(opts(), MACHINE, HELPER, readsFor(opts(), { '.claude/keybindings.json': bindings({ 'alt+v': 'chat:imagePaste' }) }))
    expect(launch.imagePasteKey).toEqual({ bytes: ESC_V, chord: 'alt+v', from: 'keybindings' })
  })

  it('a binding the table cannot express, or the default taken away: no key (the hint asks for Claude Code\'s own key)', () => {
    const odd = claudeRemoteLaunch.launch(opts(), MACHINE, HELPER, readsFor(opts(), { '.claude/keybindings.json': bindings({ 'ctrl+x ctrl+v': 'chat:imagePaste' }) }))
    expect(odd.imagePasteKey).toEqual({ bytes: null, chord: 'ctrl+x ctrl+v', why: 'unexpressible' })
    const gone = claudeRemoteLaunch.launch(opts(), MACHINE, HELPER, readsFor(opts(), { '.claude/keybindings.json': bindings({ 'ctrl+v': null }) }))
    expect(gone.imagePasteKey).toEqual({ bytes: null, chord: null, why: 'unbound' })
  })

  it('a tab on an account folder takes that folder\'s binding, never ~/.claude\'s', () => {
    const o = opts({ configDir: ACCOUNT_DIR })
    const reads: RemoteHostFile[] = [
      ...readsFor(o, { '.aicc/accounts/p-0123456789abcdef/keybindings.json': bindings({ 'ctrl+g': 'chat:imagePaste' }) }),
      // A file of ~/.claude's handed in as well is not this tab's.
      { from: 'home', path: '.claude/keybindings.json', content: bindings({ 'alt+v': 'chat:imagePaste' }) },
    ]
    expect(claudeRemoteLaunch.launch(o, MACHINE, HELPER, reads).imagePasteKey).toEqual({ bytes: '\u0007', chord: 'ctrl+g', from: 'keybindings' })
    // And with only ~/.claude's file there: the default, not its binding.
    const homeOnly: RemoteHostFile[] = [...readsFor(o, {}), { from: 'home', path: '.claude/keybindings.json', content: bindings({ 'alt+v': 'chat:imagePaste' }) }]
    expect(claudeRemoteLaunch.launch(o, MACHINE, HELPER, homeOnly).imagePasteKey).toEqual({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' })
  })

  it('the keybindings file carries nothing into the session\'s settings: a hooks key in it is not a settings file\'s', () => {
    const hostile = JSON.stringify({ bindings: [], hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo from-keybindings' }] }] } })
    const launch = claudeRemoteLaunch.launch(opts(), MACHINE, HELPER, readsFor(opts(), { '.claude/keybindings.json': hostile }))
    const settings = launch.files.find((f) => f.name === REMOTE_SETTINGS_FILE)!.content
    expect(settings).not.toContain('from-keybindings')
    expect(launch.imagePasteKey).toEqual({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' })
  })

  it('core plans the launch with the read and the key: remoteLaunchOf\'s reads name it, and its first launch (nothing read yet) has the default key', () => {
    const plan = remoteLaunchOf(claudeRemoteLaunch, MACHINE, { ssh: { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~/work' } }, null, () => true, remoteSessionId('kb-plan'), 100, 30)
    expect(plan.reads).toContainEqual({ from: 'home', path: '.claude/keybindings.json' })
    expect(plan.first.imagePasteKey).toEqual({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' })
  })
})
