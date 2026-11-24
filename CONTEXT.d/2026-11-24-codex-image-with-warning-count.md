## 2026-11-24 -- An image goes into a Codex session as Codex's own paste while Codex shows its warning count

Plan 2.1.3-beta.17, section C9 (aicc_planning#420), a follow-up to C6 (aicc_planning#415, Codex
image paste) and C7 (aicc_planning#371, the warning row readers), found where the two met at the
aggregate's C7 join. Base: loop/beta/beta17-aggregate at 1320cde5.

- **The bug.** C6 was built before C7. Its image rule refused while Codex showed its warning
  count (`codexWarningCountShown`: any row under the composer matching the count) and answered
  `warning-count`, so the renderer's Codex rule took over. Once C7 taught the readers the count
  row, that rule typed the sentence and the file path into the prompt instead of attaching the
  image as Codex's own paste.
- **Measured first.** The image rule was driven over recorded Codex 0.157.1 screens (Windows
  test machine, bundled ConPTY): P19's idle screen with the count at the right of the hint row,
  P19's mid-reply screen with the count and a spinning title, and C7's recorded draft screen
  with the count alone under the footer, its composer row replaced by the rows C6's reading
  recorded after the paste ("[Image #1]") and after the sentence. At 1320cde5 the rule answered
  `warning-count` and typed nothing at rest, so the image was not pasted (12 of 46 tests red in
  the two image test files).
- **Why C6 had the guard.** At C6's build the readers could not read a count screen (#371's
  known issue), so C6 stopped on the count itself, independent of C7's change (plan review
  finding 13). Read against C7's readers, the guard catches no screen they do not already
  refuse: with the count, a ready reading has only the footer and Codex's anchored count row
  under the composer. So the guard goes, and nothing replaces it in the rule.
- **The fix.** The rule reads the count as C7's readers do. At rest the hint row with the count
  reads ready and empty, so the paste goes; "[Image #1]" over the count alone reads as the
  placeholder; the sentence is typed and confirmed; Enter goes once. One gap needed code: the
  screen read past the placeholder (`codexScreenPastPlaceholder`) cuts the placeholder, so the
  composer reads empty, and C7 refuses the count alone under an empty composer (not recorded).
  A new reader in src/shared/codex-screen.ts, `codexScreenLessCountAlone`, blanks the count
  alone exactly where C7's `rowsUnder` takes it (the last row, at the footer's indent, one cell
  from the right edge, under a composer that holds something). The cut screen uses it.
  `RunScreenImageNotPasted` loses `warning-count`, which nothing produces now.
- **Still refused, as without the count.** A reply running (its busy row or the title's
  spinner): the rule waits, as a prompt button does, and types nothing while it runs. A prompt
  up. The count alone under an empty composer, or a row under the placeholder that is not
  Codex's count. A reply that ends within the 5 s wait now gets the image; before, the count
  refused at once.
- **Tests.** tests/unit/main/codex-image-paste.test.ts (the simulated Codex draws the count as
  Codex does; a new block over the recorded screens) and tests/unit/shared/codex-image-screen.test.ts
  (the cut screen over C7's recorded count rows). Red at 1320cde5: 12 of 46. Green: 68 of 68 in
  the 4 changed test files; 1,079 of 1,079 in 30 files with C6's and C7's tests, the
  provider-name ratchet and the WP1 gate. Five mutants, each red: the count alone kept in the cut
  screen; any last row with a warning sign blanked; the count alone blanked under an empty
  composer; a running reply read as ready; the title's spinner not read.
- **Not recorded.** "[Image #1]" over the count itself. Codex keeps the count alone under any
  composer that holds something (C7's hold: a draft, a wrapped draft, its paste placeholder, a
  draft after a reply), and the screen with the hint row kept is read as well. A VM line on
  Codex 0.157.1 with the count showing is owed. Also not covered: macOS, Linux, Codex versions
  other than 0.157.1, a session held by the session helper on the real CLI.
