// Regression (mirror of the local vision-manager fix): the SSH remote setup
// program must NEVER unlinkSync the remote ~/.claude/CLAUDE.md. If stripping the
// legacy VISION-INSTRUCTIONS marker empties it, write an empty file instead.
import { describe, it, expect } from 'vitest'
import { generateRemoteSetupScript, buildRemoteSessionCleanupCommand, buildRemoteTmuxKillCommand } from '../../../../src/main/providers/claude/ssh-shim'
import { containerSessionStopScript } from '../../../../src/shared/container-command'

// #242 finding F1 (b): generateRemoteSetupScript now requires a nonce.
const NONCE = 'testnonce123abc'

describe('generateRemoteSetupScript -- remote CLAUDE.md handling', () => {
  it('never unlinks the remote CLAUDE.md; writes empty when the strip empties it', () => {
    const script = generateRemoteSetupScript('sess-abc', null, undefined, NONCE)
    // The CLAUDE.md cleanup is still present...
    expect(script).toContain("path.join(claudeDir,'CLAUDE.md')")
    // ...but it must not delete the user's file...
    expect(script).not.toContain('unlinkSync')
    // ...it writes an empty string instead when nothing remains.
    expect(script).toContain("fs.writeFileSync(md,c?c+'\\n':'')")
  })
})

describe('buildRemoteSessionCleanupCommand -- in-band SSH per-session cleanup (U8)', () => {
  it('rm -f the per-session settings + mcp files, and nothing else', () => {
    const cmd = buildRemoteSessionCleanupCommand('sess-abc')
    expect(cmd.startsWith('rm -f ')).toBe(true)
    expect(cmd).toContain('~/.claude/settings-sess-abc.json')
    expect(cmd).toContain('~/.claude/mcp-sess-abc.json')
    expect(cmd.endsWith('\n')).toBe(true)
    // Never touches the shared statusline shim (reused across sessions) or any
    // shared config file -- only per-session sidecars.
    expect(cmd).not.toContain('conductor-ssh-statusline')
    expect(cmd).not.toContain('settings.json ')
    expect(cmd).not.toContain('.claude.json')
    expect(cmd).not.toContain('CLAUDE.md')
  })

  it('sanitizes the session id so it cannot inject shell metacharacters', () => {
    const cmd = buildRemoteSessionCleanupCommand('a/b;x')
    expect(cmd).toContain('settings-a_b_x.json')
    expect(cmd).toContain('mcp-a_b_x.json')
    expect(cmd).toContain('~/.claude/ccc-attn-a_b_x.key')
    expect(cmd).toContain('~/.claude/ccc-attn-a_b_x.up')
  })

  // aicc_planning#93: the attention hook's two
  // per-session files go with the session, as the other sidecars do. A close
  // that left them would put one key file (and a marker, if an indicator was
  // up) on the host for every session ever opened there.
  it('also removes the attention hook\'s key and marker for this session', () => {
    const cmd = buildRemoteSessionCleanupCommand('sess-abc')
    expect(cmd).toContain('~/.claude/ccc-attn-sess-abc.key')
    expect(cmd).toContain('~/.claude/ccc-attn-sess-abc.up')
    // The shared hook script is reused by every session, so it stays.
    expect(cmd).not.toContain('conductor-ssh-attention')
  })
})

describe('the End command and the in-container stop script remove the attention files too', () => {
  it('End (tmux kill + sidecars) removes this session\'s key and marker', () => {
    const cmd = buildRemoteTmuxKillCommand('sess-abc')
    expect(cmd).toMatch(/rm -f [^;]*~\/\.claude\/ccc-attn-sess-abc\.key[^;]*2>\/dev\/null; true$/)
    expect(cmd).toMatch(/rm -f [^;]*~\/\.claude\/ccc-attn-sess-abc\.up[^;]*2>\/dev\/null; true$/)
    expect(cmd).not.toContain('conductor-ssh-attention')
  })

  it('a container session\'s End removes them inside the container, before the pkill', () => {
    const script = containerSessionStopScript('sess-abc')
    const pkillAt = script.indexOf('; exec pkill -f ')
    expect(pkillAt).toBeGreaterThan(0)
    expect(script.indexOf('~/.claude/ccc-attn-sess-abc.key')).toBeGreaterThan(0)
    expect(script.indexOf('~/.claude/ccc-attn-sess-abc.key')).toBeLessThan(pkillAt)
    expect(script.indexOf('~/.claude/ccc-attn-sess-abc.up')).toBeGreaterThan(0)
    expect(script.indexOf('~/.claude/ccc-attn-sess-abc.up')).toBeLessThan(pkillAt)
    // The pkill still names only the settings marker, so the added paths
    // cannot widen what it matches.
    expect(script.slice(pkillAt)).toBe('; exec pkill -f "/settings-sess-abc\\.json"')
  })
})
