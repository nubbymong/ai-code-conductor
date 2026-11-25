/**
 * The tool streams a holder opens on one connection, as the tool host is
 * handed them: one place for both kinds of session the app serves through a
 * holder, a held session on this computer (./manager.ts toolRoute) and a tab
 * through the session helper on another machine (../remote-helper/signals.ts).
 * A fix to how a stream is sent on, refused or closed is made here once.
 *
 * Each `mcp.open` on the connection becomes a link (StreamLink) the caller
 * serves under the tab's id: the session a call acts for is the tab, never
 * anything a message says. Each `mcp` goes to its stream's link, and the
 * stream's `mcp.close`, or the connection's close, ends it. The connection
 * reports these only when it acked `mcp`, and only for a stream the holder
 * opened on it (connection.ts): that is the guard.
 *
 * This file imports nothing of Electron or node-pty: the remote helper's
 * modules load it under plain Node (tests/live/remote-helper-device.live.ts).
 */
import type { HolderConnection } from './connection'
import type { McpMessage } from './protocol'

/** One tool stream as the tool host is handed it (conductor-mcp-server.ts
 *  ToolStreamLink). */
export interface HelperToolLink {
  /** One JSON-RPC message to the session's CLI. */
  send(message: McpMessage): void
  /** What takes each message the CLI sends, and what hears the stream end
   *  from the holder's side. Once; a message before it is dropped. */
  take(onMessage: (message: McpMessage) => void, onClose: () => void): void
  /** End the stream from the tool host's side. */
  close(): void
}

/**
 * One tool stream a holder opened on a connection, as the tool host is handed
 * it: what the tool host sends goes on the stream, and what the relay sends
 * reaches it, until either side ends the stream or the connection goes.
 */
export class StreamLink implements HelperToolLink {
  private onMessage: ((message: McpMessage) => void) | null = null
  private onClose: (() => void) | null = null
  private over = false

  constructor(private readonly conn: HolderConnection, private readonly stream: number, private readonly forget: () => void) {}

  send(message: McpMessage): void {
    if (this.over) return
    // One the holder would not read is answered and ends the stream on the
    // connection's side (connection.ts sendMcp): the tool host's side ends too.
    if (this.conn.sendMcp(this.stream, message) === 'refused') this.ended()
  }

  take(onMessage: (message: McpMessage) => void, onClose: () => void): void {
    if (this.over || this.onMessage) return
    this.onMessage = onMessage
    this.onClose = onClose
  }

  close(): void {
    if (this.over) return
    this.over = true
    this.conn.closeMcp(this.stream)
    this.forget()
  }

  /** One message the relay sent on the stream. */
  deliver(message: McpMessage): void {
    if (!this.over) this.onMessage?.(message)
  }

  /** The stream ended from the holder's side, or its connection went. */
  ended(): void {
    if (this.over) return
    this.over = true
    this.conn.closeMcp(this.stream)
    this.forget()
    try { this.onClose?.() } catch { /* the tool host's own */ }
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The four listeners that route one connection's tool streams. At each
 * `mcp.open`, `refuse` (when given) is asked first: a sentence when the
 * stream is not to be served now, logged, and the stream closed. Otherwise
 * the link is handed to `serve`; one it does not take (false, or a throw) is
 * closed, with one log line. `log` takes a line's own words: the caller says
 * whose session it is.
 */
export function wireToolStreams(conn: HolderConnection, serve: (link: StreamLink) => boolean, log: (m: string) => void, refuse?: () => string | null): void {
  const links = new Map<number, StreamLink>()
  conn.on('mcpOpen', (stream) => {
    const link = new StreamLink(conn, stream, () => { if (links.get(stream) === link) links.delete(stream) })
    const why = refuse ? refuse() : null
    if (why !== null) {
      link.close()
      log(why)
      return
    }
    links.set(stream, link)
    let served = false
    try {
      served = serve(link)
    } catch (err) {
      log(`the tool host failed on a tool stream: ${messageOf(err)}`)
    }
    if (!served) {
      link.close()
      log('a tool stream its holder opened was not served')
    }
  })
  conn.on('mcp', (stream, m) => links.get(stream)?.deliver(m))
  conn.on('mcpClose', (stream) => links.get(stream)?.ended())
  conn.on('close', () => { for (const link of [...links.values()]) link.ended() })
}
