/**
 * One function says what a session can do. The bar, the dialog, the Logs button
 * and the Settings page read it and nothing else -- so a Codex session is never
 * called "Claude" again, and an SSH session's partner shell is described where
 * it runs: since #86 (2.1.1) on the host, as the session is.
 */
import { describe, it, expect } from 'vitest'
import { sessionCapabilities, describeTarget } from '../../../src/renderer/lib/session-capabilities'

const local = (over: Record<string, unknown> = {}) => ({ provider: 'claude', sessionType: 'local', configId: 'cfg', ...over }) as never
const ssh = (over: Record<string, unknown> = {}) => ({ provider: 'claude', sessionType: 'ssh', configId: 'cfg', sshConfig: { host: 'build-box', port: 22, username: 'u', remotePath: '/' }, ...over }) as never

describe('sessionCapabilities', () => {
  it('local Claude: an agent named Claude, everything local, logs indexable, snap allowed', () => {
    const c = sessionCapabilities(local())
    expect(c.agent).toBe('claude')
    expect(c.agentName).toBe('Claude')
    expect(c.mainAccepts).toBe('prompt')
    expect(c.mainRunsOn).toBe('local')
    expect(c.panesOnDifferentMachines).toBe(false)
    expect(c.canIndexLogs).toBe(true)
    expect(c.logsEmptyReason).toBeNull()
    expect(c.canSendImageToAgent).toBe(true)
    expect(c.hasConfig).toBe(true)
    expect(c.mainPaneIsShell).toBe(false)
  })

  it('local Codex: the agent is Codex -- never the word Claude -- and (P3.12) its logs are indexed', () => {
    const c = sessionCapabilities(local({ provider: 'codex' }))
    expect(c.agent).toBe('codex')
    expect(c.agentName).toBe('Codex')
    expect(c.logsEmptyReason).toBeNull()
    expect(c.canIndexLogs).toBe(true)
    expect(describeTarget(c, 'claude')).toBe('the Codex terminal')
  })

  it('terminal-only: no agent, the main pane accepts a shell line, no snap, no transcript', () => {
    const c = sessionCapabilities(local({ shellOnly: true }))
    expect(c.agent).toBeNull()
    expect(c.agentName).toBe('')
    expect(c.mainAccepts).toBe('shell')
    expect(c.mainPaneIsShell).toBe(true)
    expect(c.canSendImageToAgent).toBe(false)
    expect(c.logsEmptyReason).toBe('shell-only')
    expect(describeTarget(c, 'claude')).toBe('this shell')
  })

  // #86: the partner of an SSH session is a plain shell on the session's own
  // host (PartnerTerminalPane). It was a shell on this PC, and every label that
  // said so becomes false; they all read this function.
  it('SSH Claude: the main pane and the partner are both on the host, logs live on the host', () => {
    const c = sessionCapabilities(ssh())
    expect(c.mainRunsOn).toBe('remote')
    expect(c.partnerRunsOn).toBe('remote')
    expect(c.remoteHost).toBe('build-box')
    expect(c.panesOnDifferentMachines).toBe(false)
    expect(c.logsEmptyReason).toBe('ssh')
    expect(c.runsOn('claude')).toBe('remote')
    expect(c.runsOn('partner')).toBe('remote')
    expect(describeTarget(c, 'claude')).toBe('Claude on build-box')
    expect(describeTarget(c, 'partner')).toBe('the partner shell on build-box')
  })

  it('an SSH tab with no ssh block: its partner is a shell on this PC (PartnerTerminalPane has nothing to connect with), and the labels say so', () => {
    const c = sessionCapabilities(ssh({ sshConfig: undefined }))
    expect(c.mainRunsOn).toBe('remote')
    expect(c.partnerRunsOn).toBe('local')
    expect(c.panesOnDifferentMachines).toBe(true)
    expect(c.runsOn('partner')).toBe('local')
    expect(describeTarget(c, 'partner')).toBe('the partner shell (this PC)')
    expect(c.canDeliverSecret('partner')).toBe(true)
  })

  it('a local session\'s partner is on this PC, as before, and its label names no machine', () => {
    const c = sessionCapabilities(local())
    expect(c.partnerRunsOn).toBe('local')
    expect(c.runsOn('partner')).toBe('local')
    expect(describeTarget(c, 'partner')).toBe('the partner shell')
  })

  it('shell-only takes precedence over ssh and codex for the logs reason, as LogsPane does', () => {
    expect(sessionCapabilities(ssh({ shellOnly: true })).logsEmptyReason).toBe('shell-only')
    expect(sessionCapabilities(local({ provider: 'codex', shellOnly: true })).logsEmptyReason).toBe('shell-only')
  })

  describe('canDeliverSecret -- a secret reaches only a LOCAL shell spawn', () => {
    it('local Claude: the partner shell yes, the agent pane no (a reference typed into a TUI is text)', () => {
      const c = sessionCapabilities(local())
      expect(c.canDeliverSecret('partner')).toBe(true)
      expect(c.canDeliverSecret('claude')).toBe(false)
    })
    it('local terminal-only: both shells are local spawns', () => {
      const c = sessionCapabilities(local({ shellOnly: true }))
      expect(c.canDeliverSecret('claude')).toBe(true)
      expect(c.canDeliverSecret('partner')).toBe(true)
    })
    it('SSH: never -- the main pane and (#86) the partner both run on the host, where main sets no env var', () => {
      expect(sessionCapabilities(ssh()).canDeliverSecret('claude')).toBe(false)
      expect(sessionCapabilities(ssh()).canDeliverSecret('partner')).toBe(false)
      expect(sessionCapabilities(ssh({ shellOnly: true })).canDeliverSecret('claude')).toBe(false)
      expect(sessionCapabilities(ssh({ shellOnly: true })).canDeliverSecret('partner')).toBe(false)
    })
  })

  it('a session with no config (Ask Conductor, a resumed folder) says so', () => {
    const c = sessionCapabilities(local({ configId: undefined, kind: 'ask' }))
    expect(c.hasConfig).toBe(false)
    expect(c.isAsk).toBe(true)
  })

  it('tolerates a missing session (defaults to local Claude with no config)', () => {
    const c = sessionCapabilities(undefined)
    expect(c.agent).toBe('claude')
    expect(c.hasConfig).toBe(false)
    expect(c.mainRunsOn).toBe('local')
  })
})
