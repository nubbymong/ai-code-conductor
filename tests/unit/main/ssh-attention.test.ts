// aicc_planning#93: the attention signal of a remote SSH Claude session.
//
// The remote hook prints `ESC ]9999;CMATTN=<json> BEL` into the session's
// terminal; pty-manager lifts the JSON out of the stream and asks
// parseSshAttentionPayload whether it is this session's own. These cases pin
// that check (only this spawn's attention key and this session's id, only the events
// and notification types the attention source acts on) and that what it
// builds is routed by the attention source exactly as a local hook event is.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { HOOK_EVENT_KINDS } from '../../../src/shared/hook-types'
import {
  parseSshAttentionPayload,
  remoteAttentionKey,
  deliverRemoteAttention,
  remoteSafeSessionId,
  REMOTE_ATTENTION_HOOK_EVENTS,
  REMOTE_ATTENTION_CLEAR_EVENTS,
  REMOTE_ATTENTION_NOTIFICATIONS,
  SSH_ATTENTION_OSC_PREFIX,
} from '../../../src/main/ssh-attention'
import { attentionForEvent, startAttentionSource, _resetAttentionSourceForTest, ATTENTION_NOTIFICATIONS, ATTENTION_CLEAR_EVENTS } from '../../../src/main/attention-source'

const SID = 'lv20attn0000001'
const NONCE = 'n0nceAbC123'
/** What the remote setup writes to the key file and the hook sends. */
const KEY = remoteAttentionKey(NONCE)
const body = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ s: SID, n: KEY, e: 'Notification', t: 'permission_prompt', ...over })

afterEach(() => { _resetAttentionSourceForTest() })

describe('parseSshAttentionPayload', () => {
  it('takes this session\'s raise, carrying only the notification type', () => {
    const e = parseSshAttentionPayload(body({ extra: 'ignored' }), SID, NONCE, 123)
    expect(e).toEqual({ sessionId: SID, event: 'Notification', payload: { notification_type: 'permission_prompt' }, ts: 123 })
  })

  it('takes each clearing event with an empty payload', () => {
    for (const ev of REMOTE_ATTENTION_CLEAR_EVENTS) {
      const e = parseSshAttentionPayload(body({ e: ev, t: undefined }), SID, NONCE, 1)
      expect(e).toEqual({ sessionId: SID, event: ev, payload: {}, ts: 1 })
    }
  })

  // Mutation to prove this can fail: drop the attention key check.
  it('refuses a payload without this spawn\'s attention key (text printed into the terminal cannot raise or clear)', () => {
    expect(parseSshAttentionPayload(body({ n: 'someOtherNonce' }), SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload(body({ n: undefined }), SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload(body({ n: 42 }), SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload(body({ n: KEY }), SID, undefined)).toBeNull()
    expect(parseSshAttentionPayload(body({ n: '' }), SID, '')).toBeNull()
    expect(parseSshAttentionPayload(body({ n: remoteAttentionKey('anotherSpawn1') }), SID, NONCE)).toBeNull()
  })

  // The spawn's nonce is printed to the terminal by the remote setup's
  // completion line (setup ok <nonce> ...) and by the tmux staging steps, so
  // the attention key is a value those lines do not show. Mutation to prove
  // this can fail: make remoteAttentionKey return the nonce.
  it('refuses a payload carrying the spawn\'s nonce itself, the value the setup prints', () => {
    expect(KEY).not.toBe(NONCE)
    expect(KEY).not.toContain(NONCE)
    expect(KEY).toMatch(/^[0-9a-f]{64}$/)
    expect(parseSshAttentionPayload(body({ n: NONCE }), SID, NONCE)).toBeNull()
    // One key per nonce, and another spawn's nonce gives another key.
    expect(remoteAttentionKey(NONCE)).toBe(KEY)
    expect(remoteAttentionKey('n0nceAbC124')).not.toBe(KEY)
  })

  // Mutation to prove this can fail: drop the `s !== remoteSafeSessionId(...)` check.
  it('refuses a payload naming another session, even with the right nonce', () => {
    expect(parseSshAttentionPayload(body({ s: 'lv20other000002' }), SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload(body({ s: undefined }), SID, NONCE)).toBeNull()
  })

  it('compares the id the way the remote files spell it', () => {
    expect(remoteSafeSessionId("a'b c")).toBe('a_b_c')
    expect(parseSshAttentionPayload(body({ s: 'a_b_c' }), "a'b c", NONCE)).not.toBeNull()
  })

  it('refuses events and notification types the attention source does not act on', () => {
    expect(parseSshAttentionPayload(body({ e: 'Stop', t: undefined }), SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload(body({ e: 'SessionStart', t: undefined }), SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload(body({ t: 'auth_success' }), SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload(body({ t: undefined }), SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload(body({ e: 42 }), SID, NONCE)).toBeNull()
  })

  it('refuses anything that is not a short JSON object', () => {
    expect(parseSshAttentionPayload('not json', SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload('[1,2]', SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload('null', SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload('', SID, NONCE)).toBeNull()
    expect(parseSshAttentionPayload(body({ pad: 'x'.repeat(600) }), SID, NONCE)).toBeNull()
  })

  it('uses the statusline\'s OSC family, so both are taken out of the stream the same way', () => {
    expect(SSH_ATTENTION_OSC_PREFIX).toBe(String.fromCharCode(27) + ']9999;CMATTN=')
  })
})

describe('the remote lists match the attention source', () => {
  // A remote raise the source would ignore, or a raise the source acts on that
  // the remote never sends, is the same defect: an indicator that does not
  // match a local session's.
  it('every notification type the remote sends raises, and the informational ones do not', () => {
    for (const t of REMOTE_ATTENTION_NOTIFICATIONS) {
      expect(attentionForEvent({ sessionId: SID, event: 'Notification', payload: { notification_type: t }, ts: 0 })).toBe(true)
    }
    for (const t of ['auth_success', 'agent_completed', 'elicitation_complete', 'elicitation_response']) {
      expect(REMOTE_ATTENTION_NOTIFICATIONS).not.toContain(t)
    }
  })

  it('every clearing event the remote sends clears, and the event list is exactly raise plus clears', () => {
    for (const ev of REMOTE_ATTENTION_CLEAR_EVENTS) {
      expect(attentionForEvent({ sessionId: SID, event: ev, payload: {}, ts: 0 })).toBe(false)
    }
    expect([...REMOTE_ATTENTION_HOOK_EVENTS].sort()).toEqual(['Notification', ...REMOTE_ATTENTION_CLEAR_EVENTS].sort())
  })

  // The check runs both ways, and the source's sets are built from the one
  // list, so a type or event added to the attention source alone (Claude Code
  // keeps adding blocking notification types, #274) cannot leave remote
  // sessions silent for it with no test failing. Mutation to prove this can
  // fail: in attention-source.ts, build ATTENTION_NOTIFICATIONS (or
  // ATTENTION_CLEAR_EVENTS) from the list plus one more entry.
  it('the attention source acts on exactly the remote lists, both ways', () => {
    expect([...ATTENTION_NOTIFICATIONS].sort()).toEqual([...REMOTE_ATTENTION_NOTIFICATIONS].sort())
    expect([...ATTENTION_CLEAR_EVENTS].sort()).toEqual([...REMOTE_ATTENTION_CLEAR_EVENTS].sort())
    // And by behaviour, over every hook event the gateway knows: an event
    // clears exactly when the remote sends it as a clear, and nothing but
    // Notification raises.
    for (const ev of HOOK_EVENT_KINDS) {
      const v = attentionForEvent({ sessionId: SID, event: ev, payload: {}, ts: 0 })
      if (REMOTE_ATTENTION_CLEAR_EVENTS.includes(ev)) expect(v, ev).toBe(false)
      else expect(v, ev).toBeNull()
    }
  })

  // Mutation to prove this can fail: replace attention-source.ts's
  // `new Set(REMOTE_ATTENTION_NOTIFICATIONS)` with a literal copy of the five.
  it('a notification type added to the one list raises a local session too (no second copy to forget)', async () => {
    vi.resetModules()
    vi.doMock('../../../src/main/ssh-attention', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../../src/main/ssh-attention')>()
      return { ...real, REMOTE_ATTENTION_NOTIFICATIONS: [...real.REMOTE_ATTENTION_NOTIFICATIONS, 'future_blocking_prompt'] }
    })
    try {
      const fresh = await import('../../../src/main/attention-source')
      expect(fresh.attentionForEvent({ sessionId: SID, event: 'Notification', payload: { notification_type: 'future_blocking_prompt' }, ts: 0 })).toBe(true)
    } finally {
      vi.doUnmock('../../../src/main/ssh-attention')
      vi.resetModules()
    }
  })
})

describe('the attention source takes remote events', () => {
  // Mutation to prove this can fail: remove setRemoteAttentionSink from
  // startAttentionSource -- nothing is pushed.
  it('routes a delivered remote event exactly as a local hook event: raise, then clear', () => {
    const pushed: Array<[string, boolean]> = []
    startAttentionSource({ push: (sid, v) => { pushed.push([sid, v]) } })
    deliverRemoteAttention(parseSshAttentionPayload(body(), SID, NONCE)!)
    deliverRemoteAttention(parseSshAttentionPayload(body({ e: 'PostToolUse', t: undefined }), SID, NONCE)!)
    expect(pushed).toEqual([[SID, true], [SID, false]])
  })

  it('a consumer fault never escapes into the terminal stream', () => {
    startAttentionSource({ push: () => { throw new Error('renderer gone') } })
    expect(() => deliverRemoteAttention(parseSshAttentionPayload(body(), SID, NONCE)!)).not.toThrow()
  })
})
