## 2026-11-19 -- A held session keeps its Conductor tools when the app's link to its holder drops and comes back (the app side)

Plan 2.1.3-beta.12, section B2 (aicc_planning#355). The app's half of ADR-030 slice S15's third
step; plan section B1 is the holder's and the relay's half (helper/, Rust). A behaviour change only
with "Claude Code and Codex sessions through the session helper" on, which is off by default; with
it off nothing changes.

- **The decision line, settled by test:** a stream the holder gives back after an attach again
  starts with a call, not `initialize`, because the relay passed the CLI's handshake on the stream
  that went. The tool host answers a tool list and a tool call on a fresh stream with no handshake
  (the MCP library's server does not ask for one; version 1.32.2), so `serveToolStream` is not
  changed. Two cases in tests/unit/main/conductor-mcp-tool-stream.test.ts pin it: a tool list
  first, for a Claude Code and a Codex record, and a tool call first, which acts for the stream's
  session, and is refused when its arguments name another session, as on the routes. A library bump
  that starts to ask for the handshake turns them red.
- **The manager** (session-helper/manager.ts `toolRoute`): no change in what is served. The switch
  is remembered per launch, and every connection of the launch acks `mcp`, so a stream given back
  on the connection that attached again is served as a new one is: under the tab's id, never an id
  a message names; only for a launch that was switched; and only while the tool host has the
  session's record (a tab closed meanwhile refuses it). One log line is new, for each stream served
  on a connection that attached again: "a tool stream is served on the connection that attached
  again (one its holder kept while the link was down, or a new one)". The app cannot tell a kept
  stream from a new one there (the holder sends `mcp.open` for both), so the line names both. It is
  one line per stream; a session usually has one.
- **The fake holder** (tests/unit/main/session-helper-fake-holder.ts) keeps and gives back streams
  as B1's holder does: a stream opened with `away` is kept when the attached connection lets go (its
  relay told `mcp.away`), what the relay sends meanwhile is held, and the next connection that
  attaches with `mcp` and a running program gets `mcp.open` on the same number, then `mcp.back` goes
  to the relay and the held messages follow in order. A stream of a session that ended, or of a
  program that has exited, is not kept: its relay is told `mcp.close`. The give-back runs after an
  attach from the connection's frame loop, so the attach answer (plan section A1's part of the file)
  is not edited. Not modelled: the relay's 30 s hold, its bounds, its fixed answer and the
  notifications it drops while away (B1's Rust tests).
- **Tests:** five new manager cases: a Claude Code and a Codex tab keep their stream through a
  dropped link (the call held meanwhile is answered once; the answer to a call that was with the app
  when the link dropped goes nowhere); a session not switched is served nothing; a tab whose record
  was released meanwhile refuses the stream, and when the tab ends nothing is kept; two streams
  through one drop, one of them opened while the link was down, are each served on a link of their
  own with one log line each, and a new stream on that connection has its line too; a kept stream
  its relay ended, and one of a program that exited during the gap, are not given back. Every
  existing hooks and tools case is unchanged.
- **Not touched:** the tool host's request handler, routes and tools; helper-pty.ts; pty-manager.ts;
  helper/; the SSH radius files. No live SSH matrix is owed by path.
- **Owed:** an ADR-009 pass before stable (aicc_planning #320 list), recorded although the stream
  function was not edited: a stream served in the middle of a conversation; attack a given-back
  stream that claims another session, and one served after its launch ended. Release surface, for
  the release PR: with B1 merged, the known-issues entry for the dropped link goes; no tip.
