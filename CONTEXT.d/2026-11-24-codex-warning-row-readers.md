## 2026-11-24 -- Codex's screen reader takes the warning count, so the app types into a Codex session while it shows

Plan 2.1.3-beta.17, section C7 (aicc_planning #371, its reader steps). One file of product code:
src/shared/codex-screen.ts. composer-submit.ts, the renderer's typing, the Watchdog and
pty-manager.ts are unchanged; they read the screen through it.

- **The recordings (#371 step 1).** C7's recording hold ran P19's recorder (helper/probes/p19-record.cjs
  at origin/beta, sha256 7ac8f649...) on the Windows test machine with a scenario file of its own
  (c7-scenarios.json, sha256 1965f197..., committed byte for byte as helper/probes/c7-scenarios.json):
  Codex 0.157.1 on the probe's stand-in model, every launch with the config of P19's warning launch (a tool server whose program does not exist), both ConPTYs, 3 runs
  of each of its two sequences (the wrapped draft, the paste and the queue hint once each). Every run
  drew the same rows: at an idle composer the hint and the count at the
  right of the row under the footer, one cell from the right edge; once a text is typed (a draft, a
  draft Codex wraps onto two rows, its paste placeholder at 1,200 characters, a draft typed after a
  reply) the hint goes and the count stays ALONE there, as Codex's snapshot test warning_notice_styles
  says; while a draft waits during a turn, the queue hint with no count. After the first reply the count
  read 2 ("2 warnings"). The hold's agent ended before it copied the recordings back; the section's
  builder copied them (scp), ran the hold's own clean-up script on the machine (its working folder
  removed, nothing left in TEMP, the beta.16 installer kept) and released the VM lock the hold held.
  Two recordings joined the corpus as Codex's new state warning-draft (the bundled and the system
  ConPTY, 15,636 and 10,667 bytes; the corpus is 2,998,899 bytes of recordings, 146,829 under its
  3 MiB cap). The wrapped draft, the paste and the draft after a reply are copied as rows into
  tests/unit/shared/codex-screen-warning-row.test.ts instead (the paste alone is 124 to 232 KB).
- **What changed.** The reader takes one more row under the footer: Codex's warning count,
  `<warning sign> N warning(s) . f2 to view` (1 says warning, more say warnings), ending one cell
  from the right edge where the reader knows the row's width, with at its left one of the hint rows
  Codex draws at rest, or nothing. With a hint at its left it reads as that hint row alone did (ready,
  or busy while a turn runs). Alone, it is taken only under a composer that holds something (as
  recorded), and the three readers that confirm a typed text (codexTextTyped, codexCommandTyped,
  codexPastedContentShown) take it as the last row under the footer; no other row there. So
  composer-submit types, confirms and presses Enter once, and when the text is not confirmed it reads
  the draft over the count and takes it back. Still refused: another key than f2, the count beside the
  queue hint, the count alone under an empty composer, a count not at the right edge, a slash command's
  popup with the count under it (none recorded).
- **Result.** Of the 14 recordings in KNOWN_MISREADS, the 8 that ended in the count at the right of the
  hint row read their state now (ready). Codex 0.157.1's macOS mid-reply now reads ready, not
  unrecognised: it shows no busy row and, on macOS, no title spinner (aicc_planning#370, the known
  issue about macOS that ships already); it stays listed, on #370, reading ready. The 5 with Codex
  0.170.0's wrapped footer (#357) stay unrecognised. Mutants each seen failing a test: the count check
  dropped, the right-edge check dropped, the empty-composer rule dropped, any row taken by the confirm
  readers, any left text taken beside the count.
- **Not measured.** A signed-in Codex: whether a real model's session shows the count and how often
  (#371 step 1's signed-in count; no account on the test machine, nobody signs in). Codex 0.170.0 with a
  draft over the count, and macOS and Linux (the hold ran Codex 0.157.1 on Windows only). The VM line
  on the section's head (a prompt button press at rest and mid-reply, a canvas note, with the count) is
  run by the orchestrator.
