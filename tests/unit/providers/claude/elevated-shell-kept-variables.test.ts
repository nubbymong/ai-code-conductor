// An elevated terminal tab on macOS and Linux starts through `sudo`, which
// resets the environment, so the protective CLAUDE_CODE_* variables the launch
// stamps (they stop a hand-run `claude` taking the mouse and the alternate
// screen) were dropped. They are now handed on through `sudo env NAME=value`.
// Only those variables, and only plain values: no secret ever goes on the
// command line, where `ps` shows it to every user. Argument shape only; no
// shell runs.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const host = vi.hoisted(() => ({ platform: 'linux' as NodeJS.Platform }))
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  return { ...real, platform: () => host.platform }
})
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return { ...real, existsSync: (p: string) => (String(p).startsWith('/bin/') ? p === '/bin/bash' : real.existsSync(p)) }
})

const { buildClaudeLocalSpawn, elevatedKeptVariables } = await import('../../../../src/main/providers/claude/spawn')

const BASE = { sessionId: 'ses-1', cwd: '/work', cols: 80, rows: 24, shellOnly: true, elevated: true }
const SOURCE = { SHELL: '/bin/bash', PATH: '/usr/bin' }
const ALL_FOUR = [
  'CLAUDE_CODE_DISABLE_MOUSE=1',
  'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1',
  'CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1',
]

beforeEach(() => { host.platform = 'linux' })

describe('an elevated terminal tab keeps the protective variables through sudo', () => {
  it('runs sudo env NAME=value ... <shell> -l on Linux and macOS', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      host.platform = platform
      const spawn = buildClaudeLocalSpawn({ ...BASE }, SOURCE)
      expect(spawn.cmd, platform).toBe('sudo')
      expect(spawn.args, platform).toEqual(['env', ...ALL_FOUR, '/bin/bash', '-l'])
    }
  })

  it('leaves out a variable the user opted out of, and passes only what is set', () => {
    const spawn = buildClaudeLocalSpawn({ ...BASE, classicTerminalCopyPaste: false, clickableQuestions: true, disableBackgroundTasks: false }, SOURCE)
    expect(spawn.args).toEqual(['/bin/bash', '-l'])
    const some = buildClaudeLocalSpawn({ ...BASE, clickableQuestions: true }, SOURCE)
    expect(some.args).toEqual(['env', 'CLAUDE_CODE_DISABLE_MOUSE=1', 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1', '/bin/bash', '-l'])
  })

  it('never puts a secret value on the command line', () => {
    const spawn = buildClaudeLocalSpawn({
      ...BASE,
      terminalSecret: 'hunter2-terminal',
      commandSecrets: { abc: 'hunter2-command' },
    } as never, SOURCE)
    const line = spawn.args.join(' ')
    expect(line).not.toContain('hunter2')
    expect(line).not.toMatch(/CCC_ARG_SECRET|CCC_CMD_SECRET/)
    for (const arg of spawn.args.slice(1, -2)) expect(arg).toMatch(/^CLAUDE_CODE_DISABLE_[A-Z_]+=1$/)
  })

  it('keeps a plain terminal tab as it was', () => {
    expect(buildClaudeLocalSpawn({ ...BASE, elevated: false }, SOURCE)).toMatchObject({ cmd: '/bin/bash', args: ['-l'] })
  })
})

describe('elevatedKeptVariables', () => {
  it('names only the four protective variables, and only with a plain value', () => {
    expect(elevatedKeptVariables({ CLAUDE_CODE_DISABLE_MOUSE: '1', PATH: '/usr/bin', SECRET: 'x' })).toEqual(['env', 'CLAUDE_CODE_DISABLE_MOUSE=1'])
    expect(elevatedKeptVariables({ CLAUDE_CODE_DISABLE_MOUSE: '1 2' })).toEqual([])
    expect(elevatedKeptVariables({ CLAUDE_CODE_DISABLE_MOUSE: '' })).toEqual([])
    expect(elevatedKeptVariables({})).toEqual([])
  })
})
