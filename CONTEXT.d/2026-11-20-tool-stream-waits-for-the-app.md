## 2026-11-20 -- A tool stream waits for the app: a call made while the app is away is held 30 seconds, then answered "updating"

Plan 2.1.3-beta.12, section B1 (aicc_planning#354). The tool half of ADR-030 protocol change 9,
written by the slice that first uses it. It changes behaviour only for a relay, and a relay exists
only for a session switched under the agent sessions' setting (off by default). With the switch
off, nothing a user sees changes.

- **The holder.** Its hello offers a fifth capability, `away`, and only a relay acks it. For a
  stream whose relay acked it, while the session's program runs, the holder keeps the stream with
  no app side when the attached connection lets go, and tells the relay `mcp.away` instead of
  `mcp.close`; an `mcp.open` while nothing takes tool streams is kept the same way and answered
  `mcp.away` instead of `not-connected`. A kept stream counts toward the 8, an `mcp` on it is
  `not-connected` and the stream goes on, and the next attach that acked `mcp` and carries live
  output gets `mcp.open` for each kept stream, then each relay gets `mcp.back`. A session keeps
  nothing past its program: the clock ends every kept stream on the tick after the exit. A stream
  changes its app side only under its relay's gate and the gate of the app connection it leaves
  or joins, so either gate held keeps it in place; a message the holder read before the stream
  left an app is refused, never passed to the next one.
- **The relay.** It acks `away` only when the hello offers it, so a holder from 2.1.3-beta.10 or
  11 is acked as before and sent nothing new. With it acked, it reads of each message only whether
  it is a call and that call's id and method, and of each answer its id. A call the app had when
  it went is answered at once with D1's words and never sent again (a tool call may not be safe
  to repeat); an answer the app sends to one all the same is dropped. Calls made while away wait,
  32 calls and 4 MiB at most, 30 s each in the release build and 4 s in the debug build the tests
  run (`cfg!(debug_assertions)`, so a test can wait one out); then the fixed answer. A cancel
  drops a held call, a batch is answered at once, and `mcp.back` sends the held calls in order.
  It now pings when it has sent nothing for 15 s, so the pings go on while calls are held.
- **Tests.** Seven new tests in helper/tests/relay.rs, a new fixtures test, unit tests of the
  relay's call book and the holder's ack, and the hello pinned with five capabilities in
  hooks.rs and probe_transport.rs. The stand-in relays of the existing cases now ack the three
  capabilities of 2.1.3-beta.10 by name, so those cases still test a relay that did not ack
  `away`, unchanged. The existing cases that ran the real relay into an end it now survives
  changed: one uses a second stand-in relay, one ends the stream by the program's exit, and one
  line (a relay of an app that did not ack `mcp`) moved to the new tests. The real relay of a
  holder with nothing launched is still refused, `away` or not.
- **Fixtures.** local.json gains an `away` part (what a holder offers and a relay acks now, the
  two new messages, the two forms of the fixed answer, the limits). Its `mcp` part keeps
  2.1.3-beta.10's `offered` and `relay_caps`, which tests/unit/main/session-helper-protocol.test.ts
  pins and section A3 owns this beta; that test can move to the `away` part when A3 next edits it.
- **Docs.** helper-protocol.md, "Tool streams": the two messages in the table, the relay mode,
  "Kept streams", "The relay while away", and "What is not here yet" (a stream is given back inside
  one app run only). helper-threat-model.md 3.13: what a kept stream holds open, and its bounds.
- **Owed.** The VM line at the beta.12 release smoke (the relay alive 5 s after the app's process
  ends, a tool list answered with the fixed answer 25 to 40 s later, the relay gone within 2 s of
  the away clock's end). An ADR-009 pass before stable (aicc_planning #320 list).
