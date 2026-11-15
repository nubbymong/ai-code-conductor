// A Terminal only SSH tab is a terminal.
//
// Two things follow from that, and both are driven here through the real
// pty-manager SSH flow over a recording stand-in for node-pty (nothing is
// started, no host is reached):
//
// 1. Its "After connecting, run" command needs no click. The app types it once
//    login is detected, at the moment it used to offer a "Run post-connect
//    command" button, and when the command is done nothing is offered: no
//    "Launch Claude", no "launch anyway". A config that starts Claude keeps
//    every prompt it had. The command is typed only at a shell prompt, read
//    the way the partner terminal's folder line reads one, checked again at
//    the moment of typing, and never after the user has typed into the tab.
//    The phase has an end: a deadline after the command is typed, or a CLI
//    screen showing. After it the app types nothing more into the tab.
//
// 2. Quitting the app types the exit keys (Escape, Ctrl-C, /exit) only into a
//    terminal the app itself started a CLI in. A Terminal only tab, and an SSH
//    tab where the app never typed the launch line, is just closed: whatever
//    runs on the far side (a tmux session the user attached to, say) is left
//    as a dropped connection leaves it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))

const h = vi.hoisted(() => ({
  dataCbs: [] as Array<(d: string) => void>,
  exitCbs: [] as Array<(e: { exitCode: number }) => void>,
  writes: [] as string[],
  kills: 0,
  sent: [] as Array<{ channel: string; payload: unknown }>,
}))
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 5454, process: 'ssh', cols: 80, rows: 24,
    onData: (cb: (d: string) => void) => { h.dataCbs.push(cb); return { dispose() {} } },
    onExit: (cb: (e: { exitCode: number }) => void) => { h.exitCbs.push(cb); return { dispose() {} } },
    write: (d: string) => { h.writes.push(String(d)) }, resize() {}, kill() { h.kills++ },
  }),
}))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ getWatchdogManager: () => null }))

const { spawnPty, writePty, getSshFlow, killPty, gracefulExitPty, _getSshNonceForTest, _getSshEntryNonceForTest } = await import('../../../src/main/pty-manager')
const { entrySentinel } = await import('../../../src/shared/container-command')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const win = { webContents: { send: (channel: string, payload: unknown) => { h.sent.push({ channel, payload }) } }, isDestroyed: () => false } as never
const HOST = { username: 'user', host: 'invalid.example', port: 22, remotePath: '~' }
const PROMPT = 'user@host:~ $ '
/** A command that attaches to a tmux session on the host. */
const ATTACH = 'tmux attach -t work'
const SUDO_SECRET = 'synthetic-sudo-secret'
const SSH_SECRET = 'synthetic-ssh-secret'
/** A CLI's screen: the long box rule the flow reads as one. */
const CLI_SCREEN = '\x1b[2J\x1b[H\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e\r\n\u2502 > \u2502\r\n\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f\r\n'
/** The phase's deadline, counted from the moment the command is typed. */
const DEADLINE_MS = 15000
const CONTAINER = { type: 'container', engine: 'docker', container: 'review' }
const EXIT_KEYS = ['\x1b', '\x03', '/exit\r']

const feed = (text: string): void => { for (const cb of h.dataCbs) cb(text) }
const stateOf = (id: string) => getSshFlow(id)?.getState()
/** Every flow state main told the renderer about for `id`, in order. */
const shown = (id: string): string[] => h.sent
  .filter((m) => m.channel === `ssh:flowState:${id}`)
  .map((m) => (m.payload as { state: string }).state)
const typedExitKeys = (): string[] => h.writes.filter((w) => EXIT_KEYS.includes(w))
/** A pane that never goes quiet: a line every second for `seconds`. */
const busyFor = (seconds: number): void => {
  for (let i = 0; i < seconds; i++) { feed(`job ${i} of many\r\n`); vi.advanceTimersByTime(1000) }
}
/** The PTY reports its end. */
const ptyEnds = (): void => { for (const cb of h.exitCbs.slice()) cb({ exitCode: 0 }) }

let seq = 0
let SID = ''
/** A Terminal only SSH tab (`shellOnly`), as the saved config launches it. */
const openTerminal = (sshExtra: Record<string, unknown> = {}): void => {
  spawnPty(win, SID, { ssh: { ...HOST, ...sshExtra }, shellOnly: true } as never)
}
/** An SSH config that starts Claude. */
const openClaude = (sshExtra: Record<string, unknown> = {}): void => {
  spawnPty(win, SID, { ssh: { ...HOST, ...sshExtra } } as never)
}

beforeEach(() => {
  vi.useFakeTimers()
  SID = `sshterm${String(++seq).padStart(17, '0')}`
  h.dataCbs = []; h.exitCbs = []; h.writes = []; h.kills = 0; h.sent = []
})
afterEach(() => {
  try { killPty(SID) } catch { /* gone */ }
  try { killPty(`${SID}-partner`) } catch { /* not started */ }
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('a Terminal only SSH tab with a post-connect command', () => {
  // Mutation to prove these can fail: offer the command (awaiting-postcommand)
  // for every session, as before this change.
  it('types the command by itself at the first shell prompt: no "Run post-connect command" offer', () => {
    openTerminal({ postCommand: ATTACH })
    feed(`Linux host 6.6\r\n${PROMPT}`)
    expect(stateOf(SID)?.state).toBe('running-postcommand')
    vi.advanceTimersByTime(201)
    expect(h.writes).toEqual([`${ATTACH}\r`])
    expect(shown(SID)).not.toContain('awaiting-postcommand')
  })

  it('then offers nothing: once the pane goes quiet the tab is a terminal, with no launch prompt', () => {
    openTerminal({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    feed('\x1b[2J\x1b[H[work] 0:claude*')
    vi.advanceTimersByTime(1600)
    expect(stateOf(SID)).toEqual({ state: 'shell-only', info: undefined })
    expect(shown(SID)).toEqual(['running-postcommand', 'shell-only'])
  })

  it('a command that hands a shell prompt back is a terminal at once, with no "launch anyway"', () => {
    openTerminal({ postCommand: 'cd /srv/app' })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    feed('cd /srv/app\r\nuser@host:/srv/app $ ')
    expect(stateOf(SID)?.state).toBe('shell-only')
    expect(shown(SID)).toEqual(['running-postcommand', 'shell-only'])
    vi.advanceTimersByTime(5000)
    expect(shown(SID)).toEqual(['running-postcommand', 'shell-only'])
    expect(h.writes).toEqual(['cd /srv/app\r'])
  })

  it('a host whose prompt the app does not recognise (zsh): the command is typed once the pane goes quiet', () => {
    openTerminal({ postCommand: ATTACH })
    feed('Last login: today\r\nuser@host ~ % ')
    expect(h.writes).toEqual([])
    vi.advanceTimersByTime(1500)
    expect(stateOf(SID)?.state).toBe('running-postcommand')
    vi.advanceTimersByTime(201)
    expect(h.writes).toEqual([`${ATTACH}\r`])
    expect(shown(SID)).not.toContain('awaiting-postcommand')
  })

  // The command is never typed into a sign-in prompt: there the offer stays,
  // as before, and the user runs the command once they are signed in.
  it('a second sign-in step that ends like a prompt gets nothing typed: the offer stays', () => {
    openTerminal({ postCommand: ATTACH })
    feed('Enter OTP> ')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
  })

  it('a key passphrase prompt left waiting gets nothing typed: the offer stays', () => {
    openTerminal({ postCommand: ATTACH })
    feed("Enter passphrase for key '/home/user/.ssh/id_ed25519': ")
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
  })

  // Mutation to prove these two can fail: type the command whenever the pane
  // goes quiet, whatever line was last read.
  it('the silence after a sign-in banner, with no shell prompt read yet, gets nothing typed: the offer stays', () => {
    openTerminal({ postCommand: ATTACH })
    feed('*** Authorised access only ***\r\n')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
  })

  it('a zsh host whose own prompt names a sign-in word keeps the offer', () => {
    openTerminal({ postCommand: ATTACH })
    feed('user@token ~ % ')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
  })

  it('run from that offer, the command still ends in a terminal with no launch prompt', () => {
    openTerminal({ postCommand: ATTACH })
    feed('Enter OTP> ')
    getSshFlow(SID)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(h.writes).toEqual([`${ATTACH}\r`])
    feed('[work] 0:claude*')
    vi.advanceTimersByTime(1600)
    expect(stateOf(SID)?.state).toBe('shell-only')
    expect(shown(SID)).not.toContain('awaiting-claude')
  })

  it('a Skip is kept: the command is not typed at the next prompt behind the user\'s back', () => {
    openTerminal({ postCommand: ATTACH })
    feed('Enter OTP> ')
    getSshFlow(SID)!.skip()
    feed(PROMPT)
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
  })

  it('a saved sudo password still answers the command\'s own sudo, and nothing after the command is done', () => {
    openTerminal({ postCommand: 'sudo -u svc tmux attach', sudoPassword: SUDO_SECRET })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    expect(h.writes).toEqual(['sudo -u svc tmux attach\r', `${SUDO_SECRET}\r`])
    feed('\r\n[svc] 0:bash*')
    vi.advanceTimersByTime(1600)
    expect(stateOf(SID)?.state).toBe('shell-only')
    h.writes = []
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    expect(h.writes).toEqual([])
  })

  it('a second prompt before the command is typed does not type it twice', () => {
    openTerminal({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(100)
    feed(`\r\n${PROMPT}`)
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([`${ATTACH}\r`])
  })
})

// The command is typed only at a shell prompt, read as the partner terminal's
// folder line reads one: the prompt the last read ended in, with the tab's
// recent output (the prompt's own line across reads, and the line above it),
// and once more at the moment of typing.
describe('where a Terminal only SSH tab types its post-connect command', () => {
  it('a sign-in step whose words are on the line above a bare prompt gets nothing typed: the offer stays', () => {
    openTerminal({ postCommand: ATTACH })
    feed('Enter your one-time password\r\n> ')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
  })

  it('a sign-in prompt that two reads split gets nothing typed: the offer stays', () => {
    openTerminal({ postCommand: ATTACH })
    feed('Enter pass')
    feed('word> ')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
  })

  it('a bare prompt straight after the saved password was typed gets nothing typed: the offer stays', () => {
    openTerminal({ postCommand: ATTACH, password: SSH_SECRET })
    feed("user@host's password: ")
    vi.advanceTimersByTime(101)
    expect(h.writes).toEqual([`${SSH_SECRET}\r`])
    feed('\r\n> ')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([`${SSH_SECRET}\r`])
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
  })

  // Mutation to prove this can fail: keep the answered password prompt in the
  // recent output the check reads.
  it('a full shell prompt after the saved password still gets the command, on a host that prints nothing in between', () => {
    openTerminal({ postCommand: ATTACH, password: SSH_SECRET })
    feed("user@host's password: ")
    vi.advanceTimersByTime(101)
    feed(`\r\n${PROMPT}`)
    vi.advanceTimersByTime(201)
    expect(h.writes).toEqual([`${SSH_SECRET}\r`, `${ATTACH}\r`])
  })

  it('output that ends like a prompt, then a sign-in prompt before the command is typed: nothing is typed, the offer stays', () => {
    openTerminal({ postCommand: ATTACH, password: SSH_SECRET, sudoPassword: SUDO_SECRET })
    feed('*** Authorised access only ***\r\n##########')
    vi.advanceTimersByTime(50)
    feed('\r\nPassword: ')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
    // Run from the offer once signed in, the command is typed as asked.
    feed(`\r\n${PROMPT}`)
    getSshFlow(SID)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(h.writes).toEqual([`${ATTACH}\r`])
  })

  it('keys typed at a zsh prompt before the pane goes quiet: the command is not added to their line, the offer appears', () => {
    openTerminal({ postCommand: ATTACH })
    feed('user@host ~ % ')
    writePty(SID, 'cd ~')
    feed('cd ~')
    vi.advanceTimersByTime(3000)
    expect(h.writes.join('')).toBe('cd ~')
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
  })

  it('keys typed in the moment before the command is typed withdraw it: the offer appears', () => {
    openTerminal({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(100)
    writePty(SID, 'l')
    feed('l')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual(['l'])
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
  })

  // Mutation to prove these two can fail: count every write into the tab as
  // the user typing.
  it('a password typed by hand at its prompt is not typing at the shell: the command is still typed', () => {
    openTerminal({ postCommand: ATTACH })
    feed("user@host's password: ")
    writePty(SID, 'synthetic-typed-secret\r')
    feed(`\r\nLast login: today\r\n${PROMPT}`)
    vi.advanceTimersByTime(201)
    expect(h.writes).toEqual(['synthetic-typed-secret\r', `${ATTACH}\r`])
    expect(shown(SID)).not.toContain('awaiting-postcommand')
  })

  it('the terminal\'s own replies to the host are not typing: the command is still typed', () => {
    openTerminal({ postCommand: ATTACH })
    writePty(SID, '\x1b[I')
    writePty(SID, '\x1b[?1;2c')
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    expect(h.writes).toEqual(['\x1b[I', '\x1b[?1;2c', `${ATTACH}\r`])
  })
})

// The post-connect phase of a Terminal only tab has an end, whatever the
// command attached to: a deadline counted from the moment the command is
// typed, or a CLI screen showing. From then on the tab is a terminal and the
// app types nothing more into it.
describe('the end of a Terminal only SSH tab\'s post-connect phase', () => {
  it('the Terminal only post-connect phase ends within its deadline when the pane never goes quiet', () => {
    openTerminal({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    busyFor(DEADLINE_MS / 1000)
    expect(stateOf(SID)).toEqual({ state: 'shell-only', info: undefined })
    expect(shown(SID)).toEqual(['running-postcommand', 'shell-only'])
    // The connection ending later is not a failed connection.
    ptyEnds()
    expect(shown(SID)).not.toContain('failed')
  })

  it('a CLI screen ends the phase at once', () => {
    openTerminal({ postCommand: 'sudo -u svc tmux attach', sudoPassword: SUDO_SECRET })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    feed(CLI_SCREEN)
    expect(shown(SID)).toEqual(['running-postcommand', 'shell-only', 'claude-running'])
    h.writes = []
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
  })

  it('after the phase ends the flow writes nothing more to the terminal whatever later output shows', () => {
    openTerminal({ postCommand: 'sudo -u svc tmux attach', password: SSH_SECRET, sudoPassword: SUDO_SECRET })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    busyFor(DEADLINE_MS / 1000)
    expect(stateOf(SID)?.state).toBe('shell-only')
    h.writes = []
    for (const later of ['[sudo] password for user: ', '\r\nPassword: ', `\r\n${PROMPT}`, "\r\nuser@host's password: ", CLI_SCREEN, '[sudo] password for user: ']) {
      feed(later)
      vi.advanceTimersByTime(3000)
    }
    expect(h.writes).toEqual([])
  })

  it('a container entry still unanswered at the deadline ends the same way', () => {
    openTerminal({ runtime: CONTAINER, sudoPassword: SUDO_SECRET })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    busyFor(DEADLINE_MS / 1000)
    expect(stateOf(SID)?.state).toBe('shell-only')
    h.writes = []
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
  })

  it('a CLI screen showing before the command is typed: the command is not typed into it', () => {
    openTerminal({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(100)
    feed(CLI_SCREEN)
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
  })

  it('a config that starts Claude keeps its saved-answer step as it was: the answer is typed even with a CLI screen showing', () => {
    openClaude({ postCommand: 'sudo -u svc tmux attach', sudoPassword: SUDO_SECRET })
    feed(PROMPT)
    getSshFlow(SID)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed(CLI_SCREEN)
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual(['sudo -u svc tmux attach\r', `${SUDO_SECRET}\r`])
  })

  it('a config that starts Claude keeps its saved-answer step as it was: a CLI screen inside the 100 ms window does not withdraw the answer', () => {
    openClaude({ postCommand: 'sudo -u svc tmux attach', sudoPassword: SUDO_SECRET })
    feed(PROMPT)
    getSshFlow(SID)!.runPostCommand()
    vi.advanceTimersByTime(201)
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(50)
    feed(CLI_SCREEN)
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual(['sudo -u svc tmux attach\r', `${SUDO_SECRET}\r`])
  })

  it('a Terminal only tab: a CLI screen inside the 100 ms window of the saved answer withdraws it', () => {
    openTerminal({ postCommand: 'sudo -u svc tmux attach', sudoPassword: SUDO_SECRET })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(50)
    feed(CLI_SCREEN)
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual(['sudo -u svc tmux attach\r'])
  })

  // The withdrawn write ends in the offer only while this attempt's own state
  // (running-postcommand) is still the state; a Skip or an ended connection in
  // the 200 ms window is kept. Mutation to prove these can fail: set
  // awaiting-postcommand unconditionally on withdrawal.
  it('a Skip inside the 200 ms window of a refused write is kept: the offer does not replace it', () => {
    openTerminal({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(100)
    writePty(SID, 'l')
    getSshFlow(SID)!.skip()
    expect(stateOf(SID)?.state).toBe('skipped')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual(['l'])
    expect(stateOf(SID)?.state).toBe('skipped')
    expect(shown(SID)).not.toContain('awaiting-postcommand')
  })

  // A Skip hands the terminal to the user. With the prompt still valid and no key
  // typed, the unasked write must still not happen: the flow is no longer in
  // running-postcommand when the timer fires. Mutation to prove this can fail:
  // drop the running-postcommand check before the unasked write.
  it('a Skip inside the 200 ms window with the prompt still valid and no key typed: nothing is typed', () => {
    openTerminal({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(100)
    getSshFlow(SID)!.skip()
    expect(stateOf(SID)?.state).toBe('skipped')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
    expect(stateOf(SID)?.state).toBe('skipped')
    expect(shown(SID)).not.toContain('awaiting-postcommand')
    // The attempt is given up for this connection: a later prompt types
    // nothing (at most it offers the command, as a prompt after a Skip always did).
    feed(`\r\n${PROMPT}`)
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
  })

  it('control: the same window with no Skip types the command', () => {
    openTerminal({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(100)
    expect(stateOf(SID)?.state).toBe('running-postcommand')
    vi.advanceTimersByTime(101)
    expect(h.writes).toEqual([`${ATTACH}\r`])
  })

  it('the connection ending inside the 200 ms window of a refused write stays a failed connection', () => {
    openTerminal({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(100)
    writePty(SID, 'l')
    // The exit handler runs before the flow is destroyed, as in a real exit.
    getSshFlow(SID)!.handlePtyExit()
    expect(stateOf(SID)?.state).toBe('failed')
    vi.advanceTimersByTime(3000)
    expect(stateOf(SID)?.state).toBe('failed')
    expect(shown(SID)).not.toContain('awaiting-postcommand')
  })
})

describe('a Terminal only SSH tab that enters a container', () => {
  const IN = (): string => `${entrySentinel(_getSshEntryNonceForTest(SID)!, 'IN')}\r\n`
  const OUT = (): string => `${entrySentinel(_getSshEntryNonceForTest(SID)!, 'OUT')}\r\n`

  it('enters by itself and is a terminal once inside: no "launch Claude?" in the inner shell', () => {
    openTerminal({ runtime: CONTAINER })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]).toContain('docker exec')
    feed(`${IN()}root@0a1b2c3d4e5f:/# `)
    expect(stateOf(SID)?.state).toBe('shell-only')
    expect(shown(SID)).toEqual(['running-postcommand', 'shell-only'])
  })

  it('leaving the container by hand raises nothing: the tab stays a terminal', () => {
    openTerminal({ runtime: CONTAINER })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    feed(`${IN()}root@0a1b2c3d4e5f:/# `)
    feed(`exit\r\n${OUT()}${PROMPT}`)
    vi.advanceTimersByTime(3000)
    expect(stateOf(SID)?.state).toBe('shell-only')
    expect(shown(SID)).not.toContain('failed')
  })

  it('an entry that fails still says so (Run again and Skip are the overlay\'s, unchanged)', () => {
    openTerminal({ runtime: CONTAINER })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    feed('Error response from daemon: No such container: review\r\n')
    expect(stateOf(SID)?.state).toBe('failed')
  })
})

describe('what is unchanged', () => {
  it('a Terminal only SSH tab with no post-connect command is a terminal at its first prompt, nothing typed', () => {
    openTerminal()
    feed(PROMPT)
    vi.advanceTimersByTime(3000)
    expect(stateOf(SID)?.state).toBe('shell-only')
    expect(h.writes).toEqual([])
  })

  // Mutation to prove this can fail: type the command by itself for every
  // session with one, not only a Terminal only tab.
  it('an SSH config that starts Claude still offers its post-connect command, then asks before launching', () => {
    openClaude({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(3000)
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
    expect(h.writes).toEqual([])
    getSshFlow(SID)!.runPostCommand()
    vi.advanceTimersByTime(201)
    expect(h.writes).toEqual([`${ATTACH}\r`])
    feed('[work] 0:claude*')
    vi.advanceTimersByTime(1600)
    expect(stateOf(SID)).toEqual({ state: 'awaiting-claude', info: 'unverified' })
    expect(shown(SID)).toEqual(['awaiting-postcommand', 'running-postcommand', 'awaiting-claude'])
  })

  it('an SSH config that starts Claude with no post-connect command still asks to launch at its first prompt', () => {
    openClaude()
    feed(PROMPT)
    expect(stateOf(SID)).toEqual({ state: 'awaiting-claude', info: 'host' })
    expect(h.writes).toEqual([])
  })

  it('a zsh host still gets the offer for a config that starts Claude', () => {
    openClaude({ postCommand: ATTACH })
    feed('user@host ~ % ')
    vi.advanceTimersByTime(1600)
    expect(stateOf(SID)?.state).toBe('awaiting-postcommand')
    vi.advanceTimersByTime(3000)
    expect(h.writes).toEqual([])
  })
})

describe('quitting the app', () => {
  /** Ask for the quit-time exit of this test's session and let its timers run. */
  const quit = (id: string = SID): void => {
    void gracefulExitPty(id, 5000)
    vi.advanceTimersByTime(500)
  }

  // Mutation to prove these can fail: type the exit keys into every session
  // that is not wrapped in the app's own tmux, as before this change.
  it('a Terminal only SSH tab attached to something by its post-connect command gets no exit keys: it is closed', () => {
    openTerminal({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    feed('[work] 0:claude*')
    vi.advanceTimersByTime(1600)
    h.writes = []
    quit()
    expect(typedExitKeys()).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.kills).toBe(1)
    ptyEnds()
  })

  it('a Terminal only SSH tab attached to a pane that shows a CLI screen gets no exit keys: it is closed', () => {
    openTerminal({ postCommand: ATTACH })
    feed(PROMPT)
    vi.advanceTimersByTime(201)
    feed(CLI_SCREEN)
    expect(stateOf(SID)?.state).toBe('claude-running')
    h.writes = []
    quit()
    expect(h.writes).toEqual([])
    expect(h.kills).toBe(1)
    ptyEnds()
  })

  it('a Terminal only SSH tab with no post-connect command gets no exit keys', () => {
    openTerminal()
    feed(PROMPT)
    h.writes = []
    quit()
    expect(h.writes).toEqual([])
    expect(h.kills).toBe(1)
    ptyEnds()
  })

  it('an SSH session\'s partner terminal gets no exit keys', () => {
    const partner = `${SID}-partner`
    spawnPty(win, partner, { ssh: { ...HOST }, shellOnly: true } as never)
    feed(PROMPT)
    expect(stateOf(partner)?.state).toBe('shell-only')
    h.writes = []
    quit(partner)
    expect(h.writes).toEqual([])
    expect(h.kills).toBe(1)
    ptyEnds()
  })

  it('an SSH config that starts Claude, quit before the app typed the launch line, gets no exit keys', () => {
    openClaude()
    feed(PROMPT)
    expect(stateOf(SID)?.state).toBe('awaiting-claude')
    quit()
    expect(h.writes).toEqual([])
    expect(h.kills).toBe(1)
    ptyEnds()
  })

  it('an SSH tab the user took over with Skip gets no exit keys, whatever they started in it by hand', () => {
    openClaude()
    feed(PROMPT)
    getSshFlow(SID)!.skip()
    feed('claude\r\n\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e\r\n')
    h.writes = []
    quit()
    expect(h.writes).toEqual([])
    expect(h.kills).toBe(1)
    ptyEnds()
  })

  it('an SSH session whose launch line the app typed still gets Escape, Ctrl-C and /exit', () => {
    openClaude({ detachable: false })
    feed(PROMPT)
    getSshFlow(SID)!.launchClaude()
    vi.advanceTimersByTime(300)
    feed(`setup ok ${_getSshNonceForTest(SID)} tmux=none\r\n`)
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    expect(h.writes.some((w) => /(^|\s)claude(\s|\r)/.test(w)), 'the app typed the launch line').toBe(true)
    h.writes = []
    quit()
    expect(typedExitKeys()).toEqual(EXIT_KEYS)
    expect(h.kills).toBe(0)
    ptyEnds()
  })

  it('an SSH session whose CLI the app started, and which has since ended at the shell, gets no exit keys', () => {
    openClaude({ detachable: false })
    feed(PROMPT)
    getSshFlow(SID)!.launchClaude()
    vi.advanceTimersByTime(300)
    feed(`setup ok ${_getSshNonceForTest(SID)} tmux=none\r\n`)
    vi.advanceTimersByTime(1500)
    vi.advanceTimersByTime(300)
    expect(h.writes.some((w) => /(^|\s)claude(\s|\r)/.test(w)), 'the app typed the launch line').toBe(true)
    // The CLI ended: the pane is back at the shell prompt and stays quiet.
    feed(`\r\n${PROMPT}`)
    vi.advanceTimersByTime(1600)
    expect(stateOf(SID)).toEqual({ state: 'failed', info: 'claude exited to shell' })
    h.writes = []
    quit()
    expect(h.writes).toEqual([])
    expect(h.kills).toBe(1)
    ptyEnds()
  })
})
