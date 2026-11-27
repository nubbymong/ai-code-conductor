import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// 2.1.3-beta.6 (plan section B): only plain terminals (Terminal only tabs and
// partner terminals, the shell-only local branch of pty-manager) go through
// spawnPlainPty. 2.1.3-beta.7 (plan section A3): the two local agent session
// starts go through spawnAgentPty, with the arguments they had; SSH sessions
// keep node-pty's spawn as they are. This reads the source, so a second call
// of either, one moved out of its branch, or a change to what they are
// given, fails here. 2.1.3-beta.19 section 2: the Codex start moved, unchanged,
// into the Codex package's local launch group (providers/codex/local-launch.ts),
// which the PTY manager hands its spawnAgentPty (localLaunchCore).

const ROOT = resolve(__dirname, '../../..')
const src = readFileSync(resolve(ROOT, 'src/main/pty-manager.ts'), 'utf8').replace(/\r\n/g, '\n')
const codexLaunch = readFileSync(resolve(ROOT, 'src/main/providers/codex/local-launch.ts'), 'utf8').replace(/\r\n/g, '\n')

describe('pty-manager: where the session helper can start a terminal', () => {
  it('spawnPlainPty is called once, in the shell-only branch, with the elevated flag from both places it can come from and the renderer\'s plain mark', () => {
    const calls = [...src.matchAll(/spawnPlainPty\(/g)].map((m) => m.index!)
    expect(calls).toHaveLength(1)
    const at = calls[0]
    const branch = src.lastIndexOf('if (shellOnly) {', at)
    expect(branch).toBeGreaterThan(0)
    // No other branch opens between the shell-only test and the call.
    expect(src.slice(branch, at)).not.toMatch(/\} else/)
    expect(src.slice(branch, at)).toContain('Launching shell-only PTY')
    expect(src.slice(at, at + 250)).toContain('spawnPlainPty({ sessionId, elevated: (options?.elevated ?? options?.terminalOptions?.elevated) === true, plain: options?.plainTerminal === true }, spawnCmd, spawnArgs, {')
    // The mark is declared on the spawn options, beside shellOnly.
    expect(src).toContain('    shellOnly?: boolean; plainTerminal?: boolean // plainTerminal: a Terminal only tab or a partner terminal, which the session helper may carry\n')
  })

  it('only a Terminal only tab or a partner terminal is marked plain: the app\'s own sign-in, command and first-run install terminals are not', () => {
    const view = readFileSync(resolve(ROOT, 'src/renderer/components/TerminalView.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(view).toContain('const plainTerminal = shellOnly === true && !ssh && !session?.needsLogin && !session?.transient\n')
    // 2.1.3-beta.19 section 1.2: an SSH tab's saved mark (remoteVia) goes with its spawn, before shellOnly.
    expect(view).toMatch(/\.spawn\(sessionId, \{ cwd, cols, rows, ssh: sshWithReconnect, remoteVia: ssh && session\?\.remoteVia === 'helper' \? 'helper' : undefined, shellOnly, plainTerminal, /)
    // The first-run install terminal spawns on its own and never asks for it.
    const setup = readFileSync(resolve(ROOT, 'src/renderer/components/SetupDialog.tsx'), 'utf8')
    expect(setup).toContain('window.electronAPI.pty.spawn(')
    expect(setup).not.toContain('plainTerminal')
    // The sign-in, re-auth and command tabs carry the marks TerminalView reads.
    expect(readFileSync(resolve(ROOT, 'src/renderer/hooks/useAddAccount.ts'), 'utf8')).toContain('needsLogin: true')
    expect(readFileSync(resolve(ROOT, 'src/renderer/hooks/useReauthAccount.ts'), 'utf8')).toContain('needsLogin: true')
    expect(readFileSync(resolve(ROOT, 'src/renderer/utils/commandTerminal.ts'), 'utf8')).toContain('transient: true')
    // And the spawn schema checks the mark is a boolean.
    const handlers = readFileSync(resolve(ROOT, 'src/main/ipc/pty-handlers.ts'), 'utf8')
    expect(handlers).toContain('  plainTerminal: z.boolean().optional(),')
  })

  it('a re-attached held terminal is not typed into, and one whose take-over failed is: the lines wait for the answer', () => {
    // The lines are built as before beta.6 ...
    expect(src).toContain('      const typeCdLine = isWin || isShFamilyShell(localSessionShell(process.env, os.platform()))\n')
    expect(src).toContain('      const launchLine = buildTerminalLaunchLine(options?.terminalOptions, isWin)\n')
    // ... and typed once it is known whether the tab took over a held terminal
    // (at once for every terminal not through the helper).
    const timer = src.indexOf('      setTimeout(() => whenHeldKnown(ptyProcess, (held) => {\n')
    expect(timer).toBeGreaterThan(src.indexOf('Launching shell-only PTY'))
    const body = src.slice(timer, src.indexOf('      }), 300)\n', timer))
    expect(body).toContain("if (ptySessions.get(sessionId)?.ptyProcess !== ptyProcess) { abandonLaunchHold(); return }")
    expect(body).toContain("if (typeCdLine && !held) ptyProcess.write(cdCmd + '\\r')")
    expect(body).toContain('if (launchLine && !held) {')
    expect(body).toContain('releaseLaunchHold()')
    expect(src.match(/whenHeldKnown\(/g)).toHaveLength(1)
  })

  it('both agent session starts go through spawnAgentPty, with the same arguments as before; the SSH start stays node-pty\'s own', () => {
    // 2.1.3-beta.7 (plan section A3): the two agent spawns, and only they:
    // Claude Code's here, Codex's in its package, through this one's spawn.
    expect(src.match(/spawnAgentPty\(/g)).toHaveLength(1)
    expect(codexLaunch.match(/spawnAgentPty\(/g)).toHaveLength(1)
    expect(src).toMatch(/const localLaunchCore: LocalLaunchCore = \{[^}]*\bspawnAgentPty,/)
    expect(src.match(/pty\.spawn\(spawnCmd/g)).toBeNull()
    // The Claude Code start: the shell its launch line is typed into, as before.
    expect(src).toMatch(/claudeLaunchedAt = Date\.now\(\)\n\s+ptyProcess = spawnAgentPty\(\{ sessionId, kind: 'claude' \}, spawnCmd, spawnArgs, \{\n\s+name: 'xterm-256color',\n\s+cols,\n\s+rows,\n\s+cwd: claudeCwd,\n\s+env: finalSpawnEnv,\n\s+useConpty: true\n\s+\}\)/)
    // The Codex start: its exact command line when there is one, and the
    // ConPTY choice's own options (spawnCodexPty is called with the bundled
    // options, then the system ones when node-pty throws).
    expect(codexLaunch).toContain("    const spawnCodexPty = (conptyOptions: ConptySpawnOptions): pty.IPty => spawnAgentPty({ sessionId, kind: 'codex' }, spawnCmd, commandLine ?? spawnArgs, {\n      name: 'xterm-256color',\n      cols,\n      rows,\n      cwd: codexCwd,\n      env: spawnEnv,\n      ...conptyOptions,\n    })\n")
    expect(codexLaunch.match(/spawnCodexPty\(/g)).toHaveLength(2)
    // SSH: node-pty's own, untouched.
    expect(src.match(/pty\.spawn\(sshBin/g)).toHaveLength(1)
    expect(src).toContain("import { spawnAgentPty, spawnPlainPty, whenHeldKnown } from './session-helper/manager'\n")
  })
})
