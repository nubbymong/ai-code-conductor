## 2026-11-19 -- Seven partial escapes and first-only replaces in the tests

Section C2 of the 2.1.3-beta.12 plan (aicc_planning #350), widened in review to
five more sites of the same shape that the plan's premise check missed. Tests
only: no product file changes, and no changed site asserts anything new or less.

**The two sites of #350.** tests/unit/credential-file-mode-hardening.test.ts:58
(57 before the import line) built the staging file's pattern with
`base.replace(/\./g, '\\.')`, which escapes only the dots. It now goes through
`escapeRegExp` (tests/helpers/escape-regexp.ts, from #739). The file has a HOST
QUARANTINE header, so it runs in CI only. For the two base names it passes
(`ssh-credentials.json` and `.claude.json`) the full escape gives the same
pattern text as the dots-only one, checked against the real helper off the
test runner; the helper's own test is red on the dots-only shape.
tests/unit/providers/codex/app-server-client.test.ts:164 used
`.replace('\n', '\r\n')`, which changes only the first line end. The intent is
an answer whose line ends are all CRLF, so it is now `.replace(/\n/g, '\r\n')`.
The helper is not the tool there: the line builds a text, not a pattern. The
answer is one line today, so the bytes fed to the reader are the same. The
case passes, and is red when the reader is made to refuse a line that ends in
CR (planted in app-server-client.ts, never committed).

**Five more, found in review.**
- tests/unit/renderer/onboarding-overflow.test.ts:26 escaped only the first dot
  of a selector (`selector.replace('.', '\\.')`); it is the twin of the
  onboarding-layout-contract line #739 moved to the helper. It now calls
  `escapeRegExp`, as does tests/unit/shared/app-knowledge.test.ts:725, which
  escaped only the first dot of an image name.
- tests/unit/main/installer-nsis-behaviour.test.ts:1858 escaped only the dots
  of an exe name, twice on the line (from #720). It now calls `escapeRegExp`.
  The file is HOST QUARANTINE, so it runs in CI only.
- tests/unit/main/canvas-distroot-confinement.test.ts:161 builds a text, not a
  pattern: `'index.html%20'.replace('%20', ' ')` becomes a global replace, like
  the CRLF line. HOST QUARANTINE, CI only.
- tests/unit/scripts/verify-bundled-helper.test.ts:92 escaped only the dots and
  backslashes of the helper's path (`replace(/[\\.]/g, '\\$&')`, from #719). It
  now calls `escapeRegExp`.

For every text the seven sites pass, the new call gives exactly the old pattern
or text (a scratch check against the real helper, with two controls that show
it can tell a difference), so no check got weaker or stronger. The helper's
own test now also matches one text from each new caller as itself.

**What is left.** A search of tests/ finds no other escape of only some special
characters before a text goes into a pattern, except two kinds on purpose: the
glob converter at tests/unit/scripts/helper-packaging.test.ts:42, which turns
`*` and `?` into wildcards itself, and the character-class escapes at
tests/helpers/home-guard-core.mjs:746 and :819. It finds no other first-only
replace of a line end or a `%20`. The remaining first-only replaces in tests/
each swap one known word or character in a fixed text (a `#` off a colour, a
word in a page), which is their intent.

**Code scanning.** Alerts 21 (the CRLF line, dismissed on main as used in
tests) and 16 (the staging pattern, dismissed on main as a false positive),
both js/incomplete-sanitization, no longer have the shape they flagged once
this reaches main.

Alert 17 (the `%20` line, dismissed as used in tests) is the same. The
installer line reached beta after main's last scan, so it now never raises an
alert there.
