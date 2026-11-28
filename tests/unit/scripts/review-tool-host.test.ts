import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { newToolHostSeen, serveReviewTool, type ReviewToolSpec, type ToolHostSeen } from '../../live/review-tool-host'
import type { HelperToolLink } from '../../../src/main/session-helper/tool-links'
import type { McpMessage } from '../../../src/main/session-helper/protocol'

/**
 * The tool host the review check (tests/live/remote-review.live.ts) hands
 * each tool stream a tab's relay opens: an MCP server made with the SDK the
 * app's tool host uses, connected to the stream's link, serving one review
 * tool. Here an SDK client is the CLI at the far end of a fake link, so the
 * handshake, the tool list and a call are read as a real MCP client reads
 * them. Nothing is started: no process, no socket.
 */

/** A link and the client at its far end, each message passed on a later tick. */
function pair(): { link: HelperToolLink; client: Client; clientTransport: { close(): Promise<void> }; end: () => void; closedHere: () => boolean } {
  let toServer: ((m: McpMessage) => void) | null = null
  let serverEnd: (() => void) | null = null
  let closed = false
  const clientTransport = {
    onmessage: undefined as ((m: JSONRPCMessage) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((e: Error) => void) | undefined,
    async start() {},
    async send(m: JSONRPCMessage) { queueMicrotask(() => toServer?.(m as unknown as McpMessage)) },
    async close() { this.onclose?.() },
  }
  const link: HelperToolLink = {
    send: (m) => { queueMicrotask(() => clientTransport.onmessage?.(m as unknown as JSONRPCMessage)) },
    take: (onMessage, onClose) => { toServer = onMessage; serverEnd = onClose },
    close: () => { closed = true },
  }
  const client = new Client({ name: 'cli-at-the-far-end', version: '0' })
  return { link, client, clientTransport, end: () => serverEnd?.(), closedHere: () => closed }
}

const TOOL = (run: ReviewToolSpec['run']): ReviewToolSpec => ({ name: 'review_tool', description: 'A review of a change.', run })

describe('the review check\'s tool host: one review tool on a tool stream, served by the SDK', () => {
  it('answers the handshake and lists the one tool with the review\'s arguments, mode required', async () => {
    const p = pair()
    const seen = newToolHostSeen()
    serveReviewTool(p.link, TOOL(async () => ({ text: 'x', isError: false })), seen)
    await p.client.connect(p.clientTransport as never)
    const { tools } = await p.client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['review_tool'])
    expect(tools[0].description).toBe('A review of a change.')
    const schema = tools[0].inputSchema as { properties: Record<string, { enum?: string[]; type?: string }>; required?: string[] }
    expect(Object.keys(schema.properties).sort()).toEqual(['cccSessionId', 'effort', 'focus', 'mode', 'model', 'paths', 'range', 'timeoutSeconds'])
    expect(schema.properties.mode.enum).toEqual(['working', 'range', 'paths'])
    expect(schema.required).toEqual(['mode'])
    expect(seen.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    await p.client.close()
  })

  it('a call reaches the review with its arguments, and its text and error flag come back as the tool result; both are recorded', async () => {
    const p = pair()
    const seen = newToolHostSeen()
    const got: Array<Record<string, unknown>> = []
    serveReviewTool(p.link, TOOL(async (args) => { got.push(args); return { text: 'the review\n\n---\nthe footer', isError: false } }), seen)
    await p.client.connect(p.clientTransport as never)
    const r = await p.client.callTool({ name: 'review_tool', arguments: { mode: 'working', effort: 'low', timeoutSeconds: 300 } })
    expect(r.content).toEqual([{ type: 'text', text: 'the review\n\n---\nthe footer' }])
    expect(r.isError).toBe(false)
    expect(got).toEqual([{ mode: 'working', effort: 'low', timeoutSeconds: 300 }])
    expect(seen.calls).toEqual([{ name: 'review_tool', args: { mode: 'working', effort: 'low', timeoutSeconds: 300 }, text: 'the review\n\n---\nthe footer', isError: false }])
    expect(seen.methods).toContain('tools/call')
    await p.client.close()
  })

  it('a refused review comes back with isError set', async () => {
    const p = pair()
    const seen = newToolHostSeen()
    serveReviewTool(p.link, TOOL(async () => ({ text: 'refused: why', isError: true })), seen)
    await p.client.connect(p.clientTransport as never)
    const r = await p.client.callTool({ name: 'review_tool', arguments: { mode: 'working' } })
    expect([r.isError, r.content]).toEqual([true, [{ type: 'text', text: 'refused: why' }]])
    expect(seen.calls[0]).toMatchObject({ isError: true, text: 'refused: why' })
    await p.client.close()
  })

  it('takes the link as it is served, so a message sent before the server is connected is not lost', async () => {
    const p = pair()
    const seen: ToolHostSeen = newToolHostSeen()
    const early: McpMessage[] = []
    const link: HelperToolLink = {
      send: (m) => { early.push(m) },
      take: (onMessage, onClose) => {
        p.link.take(onMessage, onClose)
        // The relay's first message, in the same tick as the serve.
        onMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } } as unknown as McpMessage)
      },
      close: () => {},
    }
    serveReviewTool(link, TOOL(async () => ({ text: 'x', isError: false })), seen)
    for (let i = 0; i < 20 && early.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    expect(early).toHaveLength(1)
    expect((early[0] as { id?: unknown; result?: { serverInfo?: { name?: string } } }).id).toBe(1)
    expect((early[0] as { result?: { serverInfo?: { name?: string } } }).result?.serverInfo?.name).toBe('conductor')
  })

  it('the stream ending from the far side is recorded, and the link is not closed from this side', async () => {
    const p = pair()
    const seen = newToolHostSeen()
    serveReviewTool(p.link, TOOL(async () => ({ text: 'x', isError: false })), seen)
    await p.client.connect(p.clientTransport as never)
    p.end()
    expect(seen.closed).toBe(true)
    expect(p.closedHere()).toBe(false)
  })
})
