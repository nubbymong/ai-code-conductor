## 2026-10-17 -- Always start a new conversation (aicc_planning#117, 2.1.3)

Owner ask: some configs should never ask to resume. New opt-in config field
`alwaysNewConversation` (only `true` is stored; absent = today's behaviour),
a checkbox under Allow Multi Spawn for local Claude Code / Codex configs.

Ticket open questions, as decided here:

1. Covers launch, relaunch restore, plain Restart and Recover ("brand new every
   single time"). The explicit "Restart and pick a conversation" (Codex menu)
   still opens the picker. Claude users keep /resume inside Claude Code.
2. Per-config only; no global default (not asked for).
3. Dialog only; no card badge.
4. No other surface depends on the picker being armed (askConductor already
   skips it).

Mechanism: the renderer skips `markSessionForResumePicker` at the four arm
sites, and TerminalView sends a new spawn option `freshConversation: true`
(and drops a restored tab's exact target), so main resumes neither the
persisted nor the self-captured / kept conversation and skips the Codex
account carry. The flag is read live from the config store by `configId`
(`utils/alwaysNewConversation.ts`), so an edit applies to the next start.
