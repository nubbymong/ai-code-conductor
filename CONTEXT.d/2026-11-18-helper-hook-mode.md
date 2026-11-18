## 2026-11-18 -- The helper takes hook events: a short-lived hook mode and a queue in the holder (dormant)

Section A3 of the 2.1.3-beta.8 plan (ADR-030 slice S12). Built because A1
recorded probe P16 as a pass. Nothing in the app uses it: A4 switches held
Claude sessions to it, behind the agent-sessions switch.

**What was added.**
- A capability, `hooks`. A holder's hello now offers
  `["core","local","hooks"]`. The app's own ack stays `["core","local"]`, so
  today's app is never sent a hook event.
- `aicc-helper hook --store <folder> --session <sid>` (helper/src/hook.rs):
  Claude Code runs it as a command hook. It reads the event on standard input
  (at most 4 MiB kept), takes one of the nine kinds the app injects, cuts the
  payload to fit (48 KiB, then the tool's input and output become their size
  and long strings are cut to 4 KiB as JSON, then only five fields), reads the
  record with the store's reader, connects with list mode's client, and sends
  one `hook.event`. All within 2 s. It always exits 0 and prints nothing, a
  panic included: Claude Code reads a hook's output and exit code.
- In the holder: `hook.event` from any connection that acked `hooks`, a
  `hook.taken {re, seq}` reply, and an `event {seq, kind, payload, lost?}` to
  the attached connection if it acked `hooks`. Otherwise events wait in a
  queue of 256 events and 2 MiB (helper/src/holder.rs, `HookQueue`), oldest
  dropped first, and the next attach that acked `hooks` gets them right after
  its reply and replay, the first carrying how many were lost.
- Protocol section 15 and threat model 3.13 describe it; the shared vectors
  are the `hooks` part of helper/fixtures/local.json.

**Decisions taken while building.**
- A string is cut to 4 KiB measured as JSON (quotes and escapes counted), not
  as raw bytes. Measured raw, the kept fields, filled with control
  characters, could still come to about 100 KiB and break the 64 KiB frame. Measured as JSON,
  the last step is at most about 21 KiB, so a `hook.event` always fits.
- The payload is also kept to 31 levels deep, so the message carrying it
  stays within the protocol's 32. Input deeper than 32 does not read and the
  event is lost.
- An event posted while a connection that did not ack `hooks` holds the
  terminal waits in the queue: it is never sent to that connection.
- The holder's offered caps are a new constant (`serve::HOLDER_CAPS`);
  `hello::LOCAL_CAPS` stays `["core","local"]`, the app's ack, which
  tests/unit/scripts/helper-fixtures.test.ts pins.
- Outside the plan's file list, each forced by the change: helper/src/lib.rs
  (the new module), the one holder-caps assertion in
  helper/tests/probe_transport.rs, and the command list in helper/README.md.

**Owed.** ADR-009 pass before stable (aicc_planning #320 list): a new message
type into the holder, and a new mode that reads untrusted standard input.
