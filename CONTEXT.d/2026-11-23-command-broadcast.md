## 2026-11-23 -- A Global prompt button can send to every open session

Plan 2.1.3-beta.16, section B4 (aicc_planning#399). Until now a button's scope decided only
where it shows (Global: on every config's bar); a press typed into its own tab only. The owner
asked for a press that reaches every open terminal, and answered the four open points in chat
on 2026-11-23: a per-button option, Shift+click as well with a warning in case it was an
accident, a subtle pill on a broadcast button; every open agent tab; each tab decides, with a
count; and "Broadcasty should onlly be for simple prompts".

- **The rules** (`src/renderer/lib/commandBroadcast.ts`, no React, no store). Who:
  every open agent tab, local or SSH, shown or in the background; never a terminal-only tab
  (the add-account and install tabs are terminal-only too), Ask Conductor, a tab whose process
  ended, or a tab whose last launch started nothing. Which buttons: a Global prompt for the
  agent with no arguments, no remembered Ctrl+click arguments and no secret; a shell line
  never, as one press would run a command in every terminal. How: the same text to each
  session once, all at once, through main's own prompt path (`pty.submitPrompt`, #333), so each
  session's submit rule and the Type it only setting hold and main's per-session queue keeps one
  busy session from holding up the rest. Main is unchanged: that path already took any
  session's id. The pressed tab shows one note, e.g. "Sent to 5 of 7 sessions (2 busy or
  ended)."; a press every session dropped as a 300 ms repeat says nothing, as a single press does.
- **The option** (`CommandDialog.tsx`, `commandStore.ts`): "Send to every open session",
  offered on a simple Global prompt, shown off with a one-line reason on any other button. A
  save always writes the field (the store merges), and a button that takes it forgets its
  remembered Ctrl+click arguments. A move to the Session band clears it (`moveCommand`), so a
  move back does not revive it unasked; the scope and section-band confirmations say so. A
  button with the option on sends on a plain press with no confirmation.
- **Shift+click** (`CommandBar.tsx`): on a simple Global prompt it asks "Send to N open
  sessions?" (Send, Cancel; Enter sends, Escape cancels). The first answer clears the question,
  so a second Enter before the card goes cannot send twice; an Enter on the card's own focused
  button is left to that button. A held key's repeats are swallowed and never send: holding
  Shift+Enter on a chip opens the card on the first keydown, and its auto-repeats must not
  answer the card before it is read. On any other button, Shift+click is a plain press. The
  overflow list passes Shift on the same way.
- **The pill** (`command-bar/chips.tsx`, `BandOverflow.tsx`): a small rounded "all" tag with an
  SVG broadcast mark, in the bar's muted surface and text tones, labelled "Sends to every open
  session" for a tooltip and a screen reader; on the bar, the overflow row and the dialog's
  preview, only while the option is on and the button is a simple prompt. The chip's own
  tooltip and its right-click menu header (one string, `layout.ts` `chipTitle`) end "sends to
  every open session" on the same buttons, so hovering anywhere on the chip says it.
- **Usage id** `commands.broadcast` (tipsStore's DIRECT_FEATURE_IDS), recorded by a broadcast
  press, for the Shift+click tip to key on.
- **Tests.** `tests/unit/renderer/command-broadcast.test.ts` (the rules),
  `commandbar-broadcast.test.tsx` (the bar: option, Shift+click, a held Enter's repeat, pill,
  overflow pill, the scope confirmation), `commandbar-broadcast-overflow.test.tsx` (Shift+click
  on a folded button's overflow row asks, then Send reaches each tab once),
  `command-bar-layout.test.ts` (the chip title), `command-dialog-broadcast.test.tsx` (the option
  and the preview pill), `commandbar-focus-handoff.test.tsx` (a Claude Code tab and a Codex tab
  once each through the prompt path), `tests/unit/stores/commandStore-bands.test.ts` (a Session
  move clears it). Each new case was run red against the code before its commit; mutants run:
  the Enter guard dropped, the scope sentence dropped, the repeat guard dropped, the overflow
  row's Shift dropped, the chip title's broadcast part dropped.
- **Owed.** ADR-009 pass before stable (aicc_planning #320 list): one press types into many
  PTYs. VM line on the frozen head: three tabs (Claude Code, Codex, a shell).
