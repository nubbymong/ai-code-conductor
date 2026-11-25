## 2026-11-25 -- test(codex): Codex 0.172.0 on GPT-6.1 Terra recorded in the screen corpus (#427)

Plan 2.1.3-beta.18, section 7.4 (aicc_planning #427). No product code changes. Beta.17's fix for a
footer that names its model in two words ("GPT-6.1 Terra low", src/shared/codex-screen.ts footerRe)
rested on one composed row (tests/unit/shared/codex-screen-footer-model.test.ts); the corpus now holds
the real screen.

- **The recording.** 7.4's recording hold (the orchestrator's VM line, 08:14Z to 08:31Z) ran P19's
  recorder and stand-in exactly as at origin/beta d0be048e on the Windows test machine, with Codex
  0.172.0 unpacked in the hold's own folder (nothing installed) and a scenario file of its own,
  committed byte for byte as helper/probes/h74-scenarios.json (sha256 0df0cb11...): P19's ready
  composer, then /model, GPT-6.1 Terra marked (2 Down presses in every run), Enter, "s" (this session
  only), then ready (idle with the Terra footer), one turn, after-reply. Every mark is record only.
  Three launches (P19's short prompt, P19's long prompt, a 14-character prompt), 3 runs each on both
  ConPTYs: 18 of 18 reached both marks. The hold's converter (P19's README rule, as C7 applied it)
  gave the corpus files; re-run here from the hold's recordings it gives the same bytes, and the 20
  pulled files match the sha256 the VM printed.
- **What joined.** Four recordings, program codex172 (Codex 0.172.0): ready and after-reply on the
  bundled and the system ConPTY, run 1 of the long-prompt launch (19,582, 23,792, 13,582 and 16,802
  bytes; 73,758 in all). The corpus is 3,072,657 bytes of recordings, 73,071 under its 3 MiB cap
  (146,829 before). Every other codex172 state is in LEFT_OUT with its reason. Case 6 of
  screen-corpus.test.ts reads each with no model list, with gpt-6.1-terra alone and in a list (ready
  and empty) and with a list that lacks it (no-prompt), and checks the footer row is the display name.
  Red: with the footer rule's two-word match removed, case 2 and case 6 fail on all four (8 tests);
  with a listed id's hyphen no longer matching a space, case 6 fails on all four; with the four
  recordings moved out, 3 tests fail (the fixed sets, case 5's every-version check, case 6's count).
  codex-held-screen.test.ts now takes every Codex version's recordings (its filter named codex and
  codex170 only); session-helper-replay-queries.test.ts counts 54 of 67 recordings holding queries.
- **Findings.** On GPT-6.1 Terra, Codex 0.172.0 sent each turn with no tools (all 36 requests), so
  P19's stand-in answered with its one word and no mid-reply could be recorded. After P19's short
  prompt the footer wraps onto a second row (folder and thread title over 120 columns) and the reader
  reads the after-reply unrecognised on both ConPTYs, as Codex 0.170.0's wrapped footers do
  (aicc_planning #357, still listed on the codex170 recordings); the corpus holds the long-prompt
  launch, whose footer fits, so its after-reply shows the two words with a thread title.
- **Not measured.** Codex 0.170.0 and 0.171.0 on GPT-6.1 Terra (the hold fetched 0.172.0 only),
  macOS and Linux, a signed-in Codex.
