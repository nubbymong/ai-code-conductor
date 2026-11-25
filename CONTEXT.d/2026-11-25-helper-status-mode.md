## 2026-11-25 -- helper: a status mode, a status capability, and hook kinds that come with the launch

2.1.3-beta.18 section 3.1 (aicc_planning#431, its hook half #433). The helper's
Rust half of the remote status line and of another CLI's hook events; the app
half is sections 3.2 and 5. Built on d0be048e as feat/helper-status-mode,
joined into the beta.18 aggregate at 19331daf.

- `aicc-helper status [--store <folder>] [--session <sid>]` is a CLI's status
  line command: it reads its standard input (at most 4 MiB kept), sends one
  JSON object of at most 65,280 bytes as compact JSON to the session's holder
  as `status.set`, and always exits 0, silent, within 2 s.
- A holder offers `status`, last in its hello. It keeps the newest status in
  one slot (`seq` from 1, its own count, apart from the hook events') and
  sends it as `status` to each connection that acked `status` beside `local`:
  the newest once right after the ack, then newer ones in rounds at least
  100 ms apart, newest wins.
- `term.launch` may carry `hookKinds` (at most 16 plain words of at most 64
  ASCII letters or digits; `[]` takes none). A holder launched with it takes
  hook events of those kinds only; one launched without it takes the nine, as
  before. The hook mode's own check is now the kind's shape; the holder
  decides.
- The hook and status modes read a store and a session left out of the
  command line from `AICC_HELPER_STORE` and `AICC_HELPER_SESSION`.

Two choices beyond the plan's words. Status frames go only to connections that
acked `status` beside `local` (the app's), not to every `status` ack: the
status mode itself acks `status` to post, and pushing a status near 64 KiB to
it while it is still writing its own could block on a small socket buffer
(macOS's 8 KiB Unix socket default). The status `seq` is its own count:
sharing the hook events' counter would put gaps in the event `seq` the app's
hook reader checks.

Evidence: the Helper job on 19331daf, run 45570181579, green on windows-2025,
macos-latest and ubuntu-latest; its helper-linux-musl artifact is the one
section 3.2's host line packages. Six mutants (slot made a queue, status ack
ignored, kinds list ignored, variables ignored, no rate, the hook mode
dropping kinds outside the nine) were each red on all three systems on
throwaway branches (runs 45570252073 and 45570305235), since deleted. Review:
PASS (four wording findings, applied at the join with the protocol and ADR-030
text this section owed). ADR-009 pass owed before stable (aicc_planning#320).
