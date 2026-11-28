/**
 * The app's side of a tab's tool stream in the review check
 * (tests/live/remote-review.live.ts), under plain Node: an MCP server made
 * with the SDK the app's tool host uses, named `conductor` as the app names
 * its own, connected to the stream's link as the app's ToolStreamTransport
 * connects one (conductor-mcp-server.ts serveToolStream), serving the one
 * review tool the check hands it, with the arguments the app's review tools
 * take (reviewToolShape). The app's own tool host (conductor-mcp-server.ts)
 * loads here only with Electron, its config and its data folders mocked, as
 * statusline-harness.ts does; this check serves the one tool it needs
 * instead, with the app's remote review as its run, as the running app wires
 * it.
 *
 * What it saw is kept in a ToolHostSeen for the readings: every method the
 * CLI sent, each call's arguments and its answer, and whether the stream
 * ended from the far side. It starts nothing.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { HelperToolLink } from '../../src/main/session-helper/tool-links'
import type { McpMessage } from '../../src/main/session-helper/protocol'

export interface ReviewToolSpec {
  name: string
  description: string
  /** The review, given the call's arguments as the server read them. */
  run: (args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>
}

export interface ToolHostSeen {
  methods: string[]
  calls: Array<{ name: string; args: Record<string, unknown>; text?: string; isError?: boolean }>
  closed: boolean
}

export function newToolHostSeen(): ToolHostSeen {
  return { methods: [], calls: [], closed: false }
}

/** The arguments a review tool takes, as the app's reviewToolShape gives them. */
const reviewShape = {
  cccSessionId: z.string().optional().describe('Ignored: the session id is resolved from the connection. Leave unset.'),
  mode: z.enum(['working', 'range', 'paths']).describe('Scope: working diff, git range, or explicit paths'),
  range: z.string().optional().describe('Git range, required when mode is "range"'),
  paths: z.array(z.string()).optional().describe('File paths, required when mode is "paths"'),
  focus: z.string().max(500).optional().describe('Optional focus directive'),
  timeoutSeconds: z.number().int().min(30).max(900).optional().describe('Optional timeout, 30 to 900 seconds'),
  model: z.string().optional().describe('Optional model'),
  effort: z.string().optional().describe('Optional effort'),
}

/** A link as a transport, as the app's ToolStreamTransport is one: taken when
 *  it is served, so nothing the CLI sends first is lost; each message of a
 *  batch passed on alone. */
class LinkTransport {
  onmessage?: (message: never) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  private early: unknown[] | null = []
  private over = false

  constructor(private readonly link: HelperToolLink, private readonly seen: ToolHostSeen) {
    link.take((message) => this.receive(message), () => this.end(false))
  }

  async start(): Promise<void> {
    const early = this.early ?? []
    this.early = null
    for (const m of early) this.deliver(m)
  }

  async send(message: unknown): Promise<void> {
    if (this.over) return
    try { this.link.send(message as McpMessage) } catch { this.end(true) }
  }

  async close(): Promise<void> {
    this.end(true)
  }

  private receive(message: unknown): void {
    if (this.over) return
    for (const m of Array.isArray(message) ? message : [message]) {
      const method = (m as { method?: unknown } | null)?.method
      if (typeof method === 'string') this.seen.methods.push(method)
      if (this.early) this.early.push(m)
      else this.deliver(m)
    }
  }

  private deliver(m: unknown): void {
    if (!this.over) this.onmessage?.(m as never)
  }

  private end(fromHere: boolean): void {
    if (this.over) return
    this.over = true
    if (fromHere) { try { this.link.close() } catch { /* already closed */ } }
    else this.seen.closed = true
    this.onclose?.()
  }
}

/** Serve one tool stream: one server, the one review tool, until the stream ends. */
export function serveReviewTool(link: HelperToolLink, tool: ReviewToolSpec, seen: ToolHostSeen): void {
  const transport = new LinkTransport(link, seen)
  const server = new McpServer({ name: 'conductor', version: 'e2e' }, { capabilities: {} })
  server.tool(tool.name, tool.description, reviewShape, async (args: Record<string, unknown>) => {
    const call: ToolHostSeen['calls'][number] = { name: tool.name, args: { ...args } }
    seen.calls.push(call)
    const r = await tool.run({ ...args })
    call.text = r.text
    call.isError = r.isError
    return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError }
  })
  void server.connect(transport as never).catch(() => { void transport.close() })
}
