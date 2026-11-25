/**
 * A tab through the session helper on another machine gets its status line,
 * its hook events and its tool calls through its holder (2.1.3-beta.18, plan
 * section 3.2; aicc_planning#431). The helper carries frames only and has no
 * provider branch: what each frame means is the app's, and what of it is kept
 * is the tab's provider's (its launch's keep-lists, ./session-files.ts
 * keepFields).
 *
 * - The status line: the CLI runs the helper's status mode, the holder keeps
 *   the newest and sends it as `status` on the tab's connection (it acked
 *   `status`). The payload is cut to the launch's `statusKeep`, mapped by the
 *   provider (statusLine), and delivered for the tab's own id: never a
 *   session id the payload names. A remote path in it is display text only.
 * - Hook events: the CLI runs the helper's hook mode, the holder queues each
 *   event while no app is attached and sends it as `event` on the tab's
 *   connection (it acked `hooks`). The payload is cut to `hookKeep` and goes
 *   to the session signals module for the tab's id.
 * - Tool calls: the CLI's `conductor` tool server is the helper's relay; each
 *   stream it opens comes as `mcp.open` on the tab's connection (it acked
 *   `mcp`) and is served by the tool host for the tab, with no credential.
 *
 * A dropped link attaches again: the holder sends the newest status once on
 * the new connection's ack and the events it queued meanwhile, and gives the
 * tool streams it kept back. A status or an event whose `seq` this tab has
 * had already is not delivered twice.
 *
 * This file imports nothing of Electron: the app's side comes in as
 * RemoteSignalDeps (ipc/remote-machines-handlers.ts gives it).
 */
import type { HolderConnection } from '../session-helper/connection'
import type { HookEventFrame, McpMessage } from '../session-helper/protocol'
import type { HelperToolLink } from '../session-helper/manager'
import type { ProviderId } from '../../shared/providers/ids'
import type { ProviderRemoteLaunch, RemoteLaunch, RemoteStatusLine } from '../providers/types'
import { keepFields } from './session-files'

/** What a remote tab's status line, hook events and tool streams need of the app. */
export interface RemoteSignalDeps {
  /** The app serves its tools now: the built-in tools are on and their server is started. */
  toolsServed(): boolean
  /** One status line for the tab `appPtyId` (statusline-watcher.ts
   *  dispatchHelperStatus: the sanitiser's bounds, then deliverStatus). */
  status(appPtyId: string, line: RemoteStatusLine): void
  /** One hook event of the tab (session-signals/hooks.ts helperHookEvent, its
   *  transcript path kept from the binder). */
  event(appPtyId: string, e: HookEventFrame): void
  /** Serve one tool stream for the tab, as provider `provider`'s session
   *  (conductor-mcp-server.ts recordHeldToolSession, then serveToolStream).
   *  False when it was refused: the link is closed then. */
  serve(appPtyId: string, provider: ProviderId, link: HelperToolLink): boolean
}

/** One tool stream the tab's holder opened on a connection, as the tool host
 *  is handed it (the same shape session-helper/manager.ts StreamLink gives a
 *  held session on this computer). */
class RemoteToolLink implements HelperToolLink {
  private onMessage: ((message: McpMessage) => void) | null = null
  private onClose: (() => void) | null = null
  private over = false

  constructor(private readonly conn: HolderConnection, private readonly stream: number, private readonly forget: () => void) {}

  send(message: McpMessage): void {
    if (this.over) return
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

  deliver(message: McpMessage): void {
    if (!this.over) this.onMessage?.(message)
  }

  ended(): void {
    if (this.over) return
    this.over = true
    this.conn.closeMcp(this.stream)
    this.forget()
    try { this.onClose?.() } catch { /* the tool host's own */ }
  }
}

/** What one tab's signals are routed by. */
export interface RemoteSignalsOptions {
  appPtyId: string
  provider: ProviderId
  via: ProviderRemoteLaunch
  /** The launch as it went: its keep-lists. */
  launch: Pick<RemoteLaunch, 'statusKeep' | 'hookKeep'>
  /** The launch names the app's tool server. */
  tools: boolean
  deps: RemoteSignalDeps
  log: (message: string) => void
}

/** One remote tab's status line, hook events and tool streams. */
export class RemoteSignals {
  private lastStatus = 0
  private lastEvent = 0
  private launch: Pick<RemoteLaunch, 'statusKeep' | 'hookKeep'>

  constructor(private readonly o: RemoteSignalsOptions) {
    this.launch = o.launch
  }

  /** The keep-lists of the launch that went (the one asked with the host's reads). */
  launched(launch: Pick<RemoteLaunch, 'statusKeep' | 'hookKeep'>): void {
    this.launch = launch
  }

  /** What the tab's connections ask for: hooks and the status line when the
   *  launch keeps any of them, tool streams when it names the app's tool server. */
  get asks(): { hooks: boolean; mcp: boolean; status: boolean } {
    return {
      hooks: this.launch.hookKeep.length > 0,
      mcp: this.o.tools,
      status: this.launch.statusKeep.length > 0 && typeof this.o.via.statusLine === 'function',
    }
  }

  /** A connection of the tab's (its launch's or one that attached again). */
  connected(conn: HolderConnection): void {
    const { appPtyId, deps } = this.o
    // The connection reports each only when it acked its capability (connection.ts).
    conn.on('status', (s) => {
      if (s.seq <= this.lastStatus) return
      this.lastStatus = s.seq
      let line: RemoteStatusLine | null = null
      try {
        line = this.o.via.statusLine?.(keepFields(s.payload, this.launch.statusKeep)) ?? null
      } catch (err) {
        this.o.log(`[remote-helper] ${appPtyId}: a status line did not read (${(err as Error).message})`)
      }
      if (line) deps.status(appPtyId, line)
    })
    conn.on('event', (e) => {
      if (e.seq <= this.lastEvent) return
      this.lastEvent = e.seq
      deps.event(appPtyId, { ...e, payload: keepFields(e.payload, this.launch.hookKeep) })
    })
    const links = new Map<number, RemoteToolLink>()
    conn.on('mcpOpen', (stream) => {
      const link = new RemoteToolLink(conn, stream, () => { if (links.get(stream) === link) links.delete(stream) })
      links.set(stream, link)
      let served = false
      try {
        served = deps.serve(appPtyId, this.o.provider, link)
      } catch (err) {
        this.o.log(`[remote-helper] ${appPtyId}: the tool host failed on a tool stream: ${(err as Error).message}`)
      }
      if (!served) {
        link.close()
        this.o.log(`[remote-helper] ${appPtyId}: a tool stream its holder opened was not served`)
      }
    })
    conn.on('mcp', (stream, m) => links.get(stream)?.deliver(m))
    conn.on('mcpClose', (stream) => links.get(stream)?.ended())
    conn.on('close', () => { for (const link of [...links.values()]) link.ended() })
  }
}
