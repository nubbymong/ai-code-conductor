import { describe, it, expect } from 'vitest'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'

// The responder registry seam went with the gateway's permission hold
// (2.1.3-beta.14, aicc_planning#358): the gateway holds no request open.
describe('HooksGateway seams', () => {
  it('registerSessionWithSecret stores a caller-supplied secret; hasSecret reflects it', () => {
    const gw = new HooksGateway({ emit: () => {} })
    expect(gw.hasSecret('s1')).toBe(false)
    gw.registerSessionWithSecret('s1', 'sekret')
    expect(gw.hasSecret('s1')).toBe(true)
  })

  it('metrics().eventsTotal increments on a real ingest', async () => {
    const gw = new HooksGateway({ emit: () => {} })
    const secret = gw.registerSession('s1')
    await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/s1',
      headers: { 'x-ccc-hook-token': secret },
      body: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Glob' }),
    })
    expect(gw.metrics().eventsTotal).toBe(1)
    expect(gw.metrics().dropsTotal).toBe(0)
  })
})
