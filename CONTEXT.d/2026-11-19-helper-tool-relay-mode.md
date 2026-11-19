## 2026-11-19 -- The helper gains a relay mode that carries a session's tool calls through its holder (dormant)

Plan 2.1.3-beta.10, section B2 (aicc_planning#338). The first step of ADR-030 slice S15. Nothing in
the app starts the relay or acks `mcp`, so no tool call goes this way yet and nothing a user sees
changes.

- **The relay.** `aicc-helper mcp --store <folder> --session <sid>` (helper/src/relay.rs) is a
  tool server as a CLI starts one: it reads the session's record with the store's strict reader,
  connects with the client list mode and the hook mode use, and only when the hello offers `mcp`
  acks `core`, `local` and `mcp` and opens its one stream. Each line on its standard input goes to
  the holder as one `mcp`; each `mcp` back goes to standard output as one line, and nothing else
  does (not on standard error either). It exits 0 at the end of its input, after `mcp.close`, and
  1 at once whenever its stream cannot be had or cannot go on. It pings every 15 s so the holder
  does not drop it as idle.
- **What probe P18 (section B1, PR #731) changed in it.** Each CLI starts its tool server as its
  direct child with pipes and no shell. Codex passes only 17 system variables (no home or
  config folder), so the relay takes its store and session from its command line alone. Claude
  Code sends `server/discover` before `initialize`, so the relay passes whatever method comes and
  waits for none. Only Claude Code's normal end closes the program's input (Codex's end and an end
  from outside do not), so the holder treats a relay's dropped connection as the end of its
  stream and tells the app, as it does for `mcp.close`. Each relay process gets its own console
  host on Windows; that is the wiring step's to weigh, not this one's.
- **The holder** (serve.rs) offers `mcp` (HOLDER_CAPS now has four) and passes `mcp.open`, `mcp`
  and `mcp.close` between a relay and the attached connection that acked `mcp`, and nothing else.
  It numbers each stream itself, so each side sees only its own number. With no such connection
  attached, `mcp.open` is `not-connected`; at most 8 streams; a relay's message over 1,048,320
  bytes is `too-large` and its stream goes on. A connection that opened a stream is a relay for
  life: a terminal message from it is `unknown-type` and a close. When the attached connection
  lets go, each relay is told. The hook mode now acks its own fixed list (hook::ACK_CAPS), so it
  acks exactly what it did before and an older holder still takes it.
- **The app side** (session-helper/protocol.ts, connection.ts): readers for the three messages
  and an `mcp` option on a connection, which no caller sets. The fake holder in the unit tests now
  offers `mcp` as a real one does, so the unchanged manager tests show no connection acks it.
- **From the PR's review** (three points, each fixed with a test): the relay pings right after
  `mcp.open` and reads nothing from the CLI until the `pong`, so an input that ends at once never
  passes for a stream that was had (exit 1, not 0); standard output has a writer thread of its
  own behind a 64 MiB queue, so the end of the stream is seen while the CLI is not reading; and
  an attach that only replays a program that has exited takes no tool streams.
- **Two existing helper tests changed**: hooks.rs and probe_transport.rs pinned the holder's
  hello caps as three; they now name four. hooks.rs's stand-in app also acks `hook::ACK_CAPS`
  (the app's real hook ack) instead of `HOLDER_CAPS`, so each hooks test runs on the ack it used
  before, and its stand-in holder that offers all four caps checks the hook mode's ack is exactly
  `core`, `local` and `hooks`.
- **Not built here** (later steps): the tool host serving a stream and a session's config naming
  the relay (behind the agent sessions' setting); holding a call while the app is away and the
  fixed updating answer (protocol change 9). Threat model 3.13 names two
  things that step must settle (protocol section 15 names the second): a slow relay can hold the
  attached connection's other messages for up to 5 s, and the app must send only JSON the holder
  reads.
- **Tests**: helper/tests/relay.rs (CI only: no cargo on the owner's PC), the relay's and the
  holder's unit tests, the shared vectors (local.json `mcp`, hello.json); on the app side the
  protocol and connection tests, with two mutants run locally (the ack taken whatever the caller
  asked; the reader's size check removed), each caught by its test. The Rust mutants were not
  run; the PR body says which test each is aimed at. ADR-009 pass owed before stable
  (aicc_planning#320).
