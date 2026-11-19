## 2026-11-19 -- The tool host can serve a session's tool calls over its holder's tool stream (dormant)

Plan 2.1.3-beta.11, section B1 (aicc_planning#343). The second step of ADR-030 slice S15, built on
the relay of beta.10 (#733). Nothing at run time changes: app-wiring.ts gives the session helper no
tool functions yet (section B2 does), so no connection the app makes asks for `mcp`.

- **The tool host** (conductor-mcp-server.ts `serveToolStream`): one stream for one session, over
  a small link (send, take, close), served by the same `createServer` the /sse and /mcp routes use,
  with a third transport kind, `stream`. The session is the id the manager gives (the tab), never
  anything a message says, and its CLI, so its tool set, is the one its record names. No record, or
  a tool host that is not started, refuses the stream and closes the link. The stream is kept with
  the session's other streams, so `releaseMcpSessionProvider` and `stopMcpServer` close it, and a
  message that comes after its launch is over closes it too. `createServer` is reached through one
  module reference, set when the server starts and cleared when it stops. The request handler and
  the routes are not changed, and no credential is made or checked for a stream. A message is read
  as the /mcp route reads a body: each message of a batch on its own, a batch over 100 refused
  whole, and one that is not a JSON-RPC message answered Invalid Request when it has an id.
- **The connection** (session-helper/connection.ts): `sendMcp` writes one `mcp` frame, only on a
  stream the holder opened on a connection that acked `mcp`. A message the holder would not read
  (an escaped lone surrogate, more than 31 levels, over 16,776,960 bytes) is never sent, because
  such a frame closes the app's whole connection (or, over the size, draws a `too-large` refusal,
  20 of which in a minute close it): the call it answered gets a JSON-RPC error in its place, the
  app's side of the stream ends, and the connection stays up. The connection keeps the calls the
  relay sent on each stream that the app has not answered (at most 1,024 a stream, less the ones
  the relay cancels), and when the app's side of a stream ends, each of them is answered with a
  JSON-RPC error, so a call in flight is not left waiting.
- **One change from the plan's words.** The plan has the connection send `mcp.close`. The holder
  takes no `mcp.close` from the attached connection (protocol section 15: it answers `not-found`,
  and the streams end with the attach), and helper/ is out of scope here, so `closeMcp` ends the
  app's side only: nothing more goes on the stream or is reported from it, and each call the relay
  sends on it later is answered with a JSON-RPC error by the connection. The relay is not told and
  the holder keeps the stream (one of its 8) until the relay ends it, so the CLI's tool server stays
  connected but every call fails until it is started again (in Claude Code, /mcp). An app-side end
  that reaches the relay is a protocol change for the next helper/ step.
- **The manager** (session-helper/manager.ts): an optional set of tool functions per provider
  (`deps.tools`, beside `deps.hooks`). With one for the tab's provider, the tab's connections ask
  for `mcp`, each `mcp.open` becomes a link handed to the tool host under the tab's id, each `mcp`
  goes to its link, and the stream's `mcp.close` or the connection's close ends it. Never for a
  run of the app's own.
- **Tests**: the new tests/unit/main/conductor-mcp-tool-stream.test.ts (over a stand-in link, with
  node's http.createServer replaced so nothing listens and no port is taken), and new cases in
  session-helper-connection.test.ts and session-helper-manager.test.ts; the fake holder now stands
  in for a relay. The existing assertion that a manager without the tool functions acks only `core`
  and `local` is unchanged.
- **Owed before stable** (aicc_planning #320): an ADR-009 pass on this new way into the tool host:
  a stream that claims another session, a stream that outlives its session or its launch, a
  message that kills the app's connection, and a tool set wider than the session's route gives.
