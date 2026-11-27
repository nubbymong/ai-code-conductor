// tests/unit/renderer/session-launch.test.ts
import { describe, it, expect } from 'vitest'
import { shouldGateAccountChoice, canSwitchAccountForSession, isHelperTab, sshMappedProfileId, formatSpawnError, resolveResumeAccountMode, shouldPredetermineRestoredAccount, sessionAgentName, resumedSessionOwnAccount } from '../../../src/renderer/utils/sessionLaunch'
import { PROVIDER_IDS } from '../../../src/shared/providers/ids'
import fs from 'node:fs'
import path from 'node:path'

describe('the partner strip names the tab\'s own assistant (walk fix N4)', () => {
  it('Codex for a Codex tab; Claude for a Claude tab or one with no provider, as before', () => {
    expect(sessionAgentName('codex')).toBe('Codex')
    expect(sessionAgentName('claude')).toBe('Claude')
    expect(sessionAgentName(undefined)).toBe('Claude')
  })
  it('App\'s partner pane says it for the tab it sits in, in its note, its button and its title', () => {
    const app = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(app).toContain('const agentName = sessionAgentName(session.provider)')
    const pane = app.slice(app.indexOf('<PartnerTerminalPane'), app.indexOf('/>', app.indexOf('<PartnerTerminalPane')))
    expect(pane).toContain('agentName={agentName}')
    expect(pane).toContain('ptyId={partnerPtyId}')
    const strip = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/components/PartnerTerminalPane.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(strip).toContain('Partner terminal: a plain shell on {partner.where}, not {agentName}</span>')
    expect(strip).toContain('title={`Back to the ${agentName} terminal`}')
    expect(strip).toMatch(/\n\s*Back to \{agentName\}\n\s*<\/button>/)
    expect(strip).not.toContain('not Claude</span>')
    expect(strip).not.toMatch(/\n\s*Back to Claude\n/)
  })

  // The strip's markup (P3.7's corner rule, #86's machine) is rendered and
  // pinned in partner-terminal-pane.test.tsx. App keeps no strip of its own.
  it('App renders the partner through PartnerTerminalPane only: no second strip, no second partner view', () => {
    const app = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(app).not.toContain('data-ux-id="partner-identity-strip"')
    expect(app).not.toContain('sessionId={partnerPtyId}')
    expect(app.split('<PartnerTerminalPane').length - 1).toBe(1)
  })
})

describe('shouldGateAccountChoice', () => {
  it('gates a Claude session with >= 2 account profiles', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 2, provider: 'claude' })).toBe(true)
  })
  it('does NOT gate a Codex session even with >= 2 profiles (BUG-1: account isolation is Claude-only)', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 3, provider: 'codex' })).toBe(false)
  })
  it('treats an unspecified provider as Claude', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 2 })).toBe(true)
  })
  it('does not gate with fewer than 2 profiles', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 1, provider: 'claude' })).toBe(false)
  })
  it('does not gate shell-only panes', () => {
    expect(shouldGateAccountChoice({ shellOnly: true, hasSession: true, profileCount: 2, provider: 'claude' })).toBe(false)
  })
  it('does not gate when there is no session record', () => {
    expect(shouldGateAccountChoice({ hasSession: false, profileCount: 2, provider: 'claude' })).toBe(false)
  })
  it('does NOT gate an SSH session even if provider is Claude (remote host uses its own login)', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 2, provider: 'claude', isSsh: true })).toBe(false)
  })
})

describe('resolveResumeAccountMode (#446)', () => {
  it("returns 'ask' only for the exact string 'ask'", () => {
    expect(resolveResumeAccountMode('ask')).toBe('ask')
  })
  it("defaults to 'auto-last' for absent/unknown/legacy values", () => {
    for (const v of [undefined, null, '', 'auto-last', 'AUTO', 'Ask', 1, {}, true]) {
      expect(resolveResumeAccountMode(v)).toBe('auto-last')
    }
  })
})

describe('shouldPredetermineRestoredAccount (#446)', () => {
  it('predetermines (auto-last) by default and for any non-ask value', () => {
    for (const v of [undefined, null, 'auto-last', 'anything', 1]) {
      expect(shouldPredetermineRestoredAccount(v)).toBe(true)
    }
  })
  it("does NOT predetermine under 'ask' (the gate opens per restored session)", () => {
    expect(shouldPredetermineRestoredAccount('ask')).toBe(false)
  })
})

describe('resumedSessionOwnAccount (O9): the account a resumed session last ran on', () => {
  const profiles = [{ id: 'primary', isPrimary: true }, { id: 'p2' }, { id: 'p3', isPrimary: false }]
  it('its saved account while that account is still set up here', () => {
    expect(resumedSessionOwnAccount('p2', profiles)).toEqual({ id: 'p2', gone: false })
  })
  it('the primary when no account was saved with it (main runs a pinless session there)', () => {
    expect(resumedSessionOwnAccount(undefined, profiles)).toEqual({ id: 'primary', gone: false })
    expect(resumedSessionOwnAccount('', profiles)).toEqual({ id: 'primary', gone: false })
  })
  it('none, and gone, when its saved account was removed (never the primary in its place)', () => {
    expect(resumedSessionOwnAccount('deleted', profiles)).toEqual({ id: undefined, gone: true })
  })
  it('none, not gone, with no saved account and no primary', () => {
    expect(resumedSessionOwnAccount(undefined, [{ id: 'p2' }])).toEqual({ id: undefined, gone: false })
  })
})

describe('Settings, Resuming sessions wording (O9)', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/components/SettingsPage.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const start = src.indexOf('<Section title="Resuming sessions"')
  const section = src.slice(start, src.indexOf('</Section>', start)).replace(/\s+/g, ' ')
  it('names whose account each option uses, in plain words', () => {
    expect(start).toBeGreaterThan(-1)
    expect(section).toContain('>Use the account each session last ran on (default)</option>')
    expect(section).toContain('>Ask each time, with that account already chosen</option>')
    expect(section).not.toContain('Auto-resume last')
  })
  it('says which sessions it does not touch, and nothing about a Codex sign-in on this computer', () => {
    expect(section).toContain("Only matters with two or more Claude accounts. Applies when the app restarts and reopens your sessions. Codex sessions keep their own Codex account, and SSH sessions use the remote machine's sign-in.")
    expect(section).not.toMatch(/this computer/i)
    expect(section).not.toContain(String.fromCodePoint(0x2014))
  })
})

describe('canSwitchAccountForSession', () => {
  it('allows a local Claude session with >= 2 profiles', () => {
    expect(canSwitchAccountForSession({ provider: 'claude', profileCount: 2 })).toBe(true)
  })
  it('treats an unspecified provider as Claude', () => {
    expect(canSwitchAccountForSession({ profileCount: 2 })).toBe(true)
  })
  it('does NOT allow a Codex session (account isolation is Claude-only)', () => {
    expect(canSwitchAccountForSession({ provider: 'codex', profileCount: 3 })).toBe(false)
  })
  it('does NOT allow an SSH session (remote host uses its own login)', () => {
    expect(canSwitchAccountForSession({ provider: 'claude', isSsh: true, profileCount: 3 })).toBe(false)
  })
  it('does not allow with fewer than 2 profiles', () => {
    expect(canSwitchAccountForSession({ provider: 'claude', profileCount: 1 })).toBe(false)
  })
  it('refuses shell-only panes (the add-account /login shell must never switch profile)', () => {
    expect(canSwitchAccountForSession({ provider: 'claude', shellOnly: true, profileCount: 2 })).toBe(false)
  })

  // 2.1.3-beta.20 section 5: a tab through the session helper resolves and
  // switches its account as a local tab does (each account's own folder on
  // the machine). Today's plain SSH path and shell-only panes still never do.
  it('allows a Claude tab through the session helper with >= 2 profiles', () => {
    expect(canSwitchAccountForSession({ provider: 'claude', isSsh: true, viaHelper: true, profileCount: 2 })).toBe(true)
    expect(canSwitchAccountForSession({ isSsh: true, viaHelper: true, profileCount: 3 })).toBe(true)
  })
  it('still refuses today\'s plain SSH tab, whatever the profile count', () => {
    expect(canSwitchAccountForSession({ provider: 'claude', isSsh: true, viaHelper: false, profileCount: 5 })).toBe(false)
    expect(canSwitchAccountForSession({ provider: 'claude', isSsh: true, profileCount: 5 })).toBe(false)
  })
  it('still refuses a shell-only pane through the helper, another provider\'s tab, or one account only', () => {
    const other = PROVIDER_IDS.find((p) => p !== 'claude')!
    expect(canSwitchAccountForSession({ provider: 'claude', isSsh: true, viaHelper: true, shellOnly: true, profileCount: 3 })).toBe(false)
    expect(canSwitchAccountForSession({ provider: other, isSsh: true, viaHelper: true, profileCount: 3, providerAccountCount: 3 })).toBe(false)
    expect(canSwitchAccountForSession({ provider: 'claude', isSsh: true, viaHelper: true, profileCount: 1 })).toBe(false)
  })
})

describe('isHelperTab (2.1.3-beta.20 section 5)', () => {
  it('an SSH tab kept by the helper, or one main says runs through it now', () => {
    expect(isHelperTab({ sessionType: 'ssh', remoteVia: 'helper' }, false)).toBe(true)
    expect(isHelperTab({ sessionType: 'ssh' }, true)).toBe(true)
  })
  it('not today\'s plain SSH tab, a local tab, a shell-only pane or a sign-in tab', () => {
    expect(isHelperTab({ sessionType: 'ssh' }, false)).toBe(false)
    expect(isHelperTab({ sessionType: 'local' }, true)).toBe(false)
    expect(isHelperTab({ sessionType: 'ssh', shellOnly: true, remoteVia: 'helper' }, true)).toBe(false)
    expect(isHelperTab({ sessionType: 'ssh', remoteAccountSignIn: true }, true)).toBe(false)
    expect(isHelperTab(null, true)).toBe(false)
  })
  // NIT-6 (round 1): main counts a saved mark only on an SSH Persistent tab
  // (marked = persistent && remoteVia), so a kept tab whose Connection was
  // changed to SSH is not a helper tab by its mark alone.
  it('the kept mark counts only while the Connection is SSH Persistent', () => {
    expect(isHelperTab({ sessionType: 'ssh', remoteVia: 'helper', sshConfig: { detachable: false } }, false)).toBe(false)
    expect(isHelperTab({ sessionType: 'ssh', remoteVia: 'helper', sshConfig: { detachable: true } }, false)).toBe(true)
    expect(isHelperTab({ sessionType: 'ssh', remoteVia: 'helper', sshConfig: {} }, false)).toBe(true)
    // Main saying it runs through the helper now still counts.
    expect(isHelperTab({ sessionType: 'ssh', sshConfig: { detachable: false } }, true)).toBe(true)
  })
})

describe('sshMappedProfileId (harmonise-remote: SSH → local profile)', () => {
  const profiles = [
    { id: 'p1', accountEmail: 'me@work.co' },
    { id: 'p2', accountEmail: 'other@x.com' },
  ]

  it('maps an SSH session to the local profile whose email matches its live accountEmail', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', accountEmail: 'me@work.co' }, profiles)).toBe('p1')
  })
  it('falls back to the setup-sentinel sshRemoteAccount when there is no live accountEmail', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', sshRemoteAccount: 'other@x.com' }, profiles)).toBe('p2')
  })
  it('prefers the live accountEmail over the sshRemoteAccount snapshot', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', accountEmail: 'me@work.co', sshRemoteAccount: 'other@x.com' }, profiles)).toBe('p1')
  })
  it('returns undefined when no local profile matches the remote account', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', accountEmail: 'stranger@nowhere.dev' }, profiles)).toBeUndefined()
  })
  it('returns undefined when the SSH session reports no remote account at all', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude' }, profiles)).toBeUndefined()
  })
  it('is SSH-only: a LOCAL session never maps (its own profile drives affordances)', () => {
    expect(sshMappedProfileId({ sessionType: 'local', provider: 'claude', accountEmail: 'me@work.co' }, profiles)).toBeUndefined()
  })
  it('is Claude-only: an SSH Codex session never maps (auth is not profile-scoped)', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'codex', accountEmail: 'me@work.co' }, profiles)).toBeUndefined()
  })
  it('never maps a shell-only SSH pane (no in-session /login to act on)', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', shellOnly: true, accountEmail: 'me@work.co' }, profiles)).toBeUndefined()
  })

  // First-connect fallback: the launch profileId stands in ONLY while no
  // remote identity has arrived. Once an email is known, the email mapping
  // alone decides — a stand-in must never fabricate affordances for a remote
  // account that deliberately matched nothing (Double Review F1).
  it('falls back to the launch profileId while NO remote identity has arrived yet', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', profileId: 'p1' }, profiles)).toBe('p1')
  })
  it('rejects a launch profileId that no longer exists (deleted profile)', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', profileId: 'p9' }, profiles)).toBeUndefined()
  })
  it('a KNOWN remote identity matching no profile stays unmapped — the launch profileId never stands in', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', accountEmail: 'stranger@nowhere.dev', profileId: 'p1' }, profiles)).toBeUndefined()
  })
  it('an email match always wins over a differing launch profileId', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', accountEmail: 'other@x.com', profileId: 'p1' }, profiles)).toBe('p2')
  })
})

describe('formatSpawnError', () => {
  it('surfaces the underlying Error message', () => {
    expect(formatSpawnError(new Error('Codex CLI not found on PATH. Install with npm i -g @openai/codex')))
      .toContain('Codex CLI not found on PATH')
  })
  it('strips the IPC invoke wrapper noise', () => {
    expect(formatSpawnError(new Error("Error invoking remote method 'pty:spawn': Error: boom"))).toBe('boom')
  })
  it('handles a non-Error value', () => {
    expect(formatSpawnError('plain failure')).toBe('plain failure')
  })
  it('falls back for a nullish error', () => {
    expect(formatSpawnError(undefined)).toBe('unknown error')
  })
})
