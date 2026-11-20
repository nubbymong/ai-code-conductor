## 2026-11-20 -- beta.10 smoke fixes: the off-PATH notice takes the not-found words' place, and What's New dates

Found by the 2.1.3-beta.10 pre-publish VM smoke and fixed on the release PR before the cut
(aicc_planning #288 and #366), so beta.10 does not ship either as a known issue.

- **Set up Codex page (#288).** With Codex installed by npm in %APPDATA%\npm and that folder off
  PATH, the page showed "Codex CLI not found" and both install commands ABOVE the notice saying
  Codex is installed. A path hint that says what helps (Codex is in a folder PATH lacks, or a
  restart would help) now takes the place of the not-found row and the install commands; a hint
  that is only a note (a restart that may help) keeps the row and the commands and follows them,
  as before. The same rule as the setup screen and the footer's CLI help (`pathHintIsNote`),
  with one difference kept on purpose: those two Claude Code surfaces still list the install
  commands under their notice, while the Set up Codex page and every provider row in Settings,
  Accounts (the Claude Code row included) drop them, because installing again does not help a
  tool that is installed. The notice stays while a check runs, so Check again
  no longer brings the not-found row back for a moment, and a Check again that still finds the
  folder off PATH says "Checked again just now: Codex was still not found." under it, as the
  setup screen does (aicc_planning #194). Focus goes to Add it to PATH for me (or the line's
  Copy on macOS and Linux) when the notice replaces the commands: PathHintNotice takes a
  `primaryAutofocus` flag that marks it data-autofocus. Until the page's entry check answers, a
  snapshot that says not found shows "Checking for the Codex CLI..." instead of the not-found
  row and the commands, so they no longer show for a moment, with live Run it for me buttons,
  before the notice takes their place; focus then goes straight to the notice.
- **Settings, Accounts (#288).** The same rule for a provider row's status line and its install
  commands. A row first shown with its CLI not found now looks again once by itself (the same
  discover its Check again runs, through notePathHint), once per provider while the renderer
  runs, never while that provider's install tab runs, and never for a provider main found (too
  old included) or has not looked for yet. Why in the renderer: main computes the hint only inside `checkAgain`
  (accounts-service.ts), never in the snapshot, and putting it there would read the registry on
  every snapshot and change the IPC shape. The look applies to the Claude Code row too. Main
  pushes a check's snapshot before it answers, so the row's own checks (Check now or Check
  again, and the check when its install tab ends) count as its look: a check of its own that
  turns the provider into not found starts no second discover behind it. While the look is
  out, the row reads "Checking for Codex..." (or Claude Code) in place of its not-found line
  and its install commands, also when the card is shown again meanwhile; a snapshot that says
  found is shown at once. The same holds for a check of the row's own that starts while the row
  does not show the CLI as not found (Check now, Check again from too old, and the check when an
  update tab ends). A row that drops its notice, because the provider was switched off or its
  CLI was found, also forgets that it looked, so switched back on (or not found again) it looks
  once more and the notice returns with nothing pressed (found by the final-head review).
- **What's New dates (#366).** `new Date('YYYY-MM-DD')` is midnight UTC, the day before
  anywhere west of UTC (the VM on Pacific time showed beta.10 as 19 Nov 2026). The changelog
  date is now built from its parts and formatted in UTC (`formatChangelogDate`,
  WhatsNewEntries.tsx), the only place a changelog date is shown. Build times and run
  timestamps are real instants and stay local. The test sets `process.env.TZ` at run time,
  which Node honours on Windows too; a sanity assertion proves the zone took effect.
- Each new test was seen red against the old code or a named mutant (no look on first view, no
  replacement, a look while the install tab runs, a look on every mount, a look for a found
  provider, no focus mark, the old date formatter; then, after review, a second look behind
  the row's own Check now and behind an install tab's end check, no checking line on the row
  or on the page, a look held only by the row and not the card, a checking line over a found
  snapshot, and the focus rule's wait for the commands when the notice replaces them; then, after
  the re-review, no checking line behind the row's own Check now, Check again from a CLI that
  did not run, could not be checked or is too old, and the end check of an install tab, the
  checking line kept after an answer, and the row's check from not found changing its layout).
