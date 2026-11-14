## 2026-11-14 -- Remote helper design (R1)

- The owner approved the remote shape for 2.1.3-beta.2: devices added once, a small Rust helper per device, one long-lived helper process per session, no daemon.
- ADR-029 records the decision, the step plan R1 to R14 and the six R1 probes. `docs/remote/helper-protocol.md` is protocol version 1; `docs/remote/helper-threat-model.md` is its threat model.
- No probe has run: they wait for the owner to name the host and allow host probes.
- The design-stage adversarial pass ran: four fix rounds and a minors pass. No blocker or major is open. The test requirements it raised are written into the steps they belong to (R2, R6, R8, R9 and R11).
