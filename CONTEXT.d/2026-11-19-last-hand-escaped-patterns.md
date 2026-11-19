## 2026-11-19 -- The last two hand-escaped patterns in the tests

Section C2 of the 2.1.3-beta.12 plan (aicc_planning #350). Tests only: no
product file changes, and neither test asserts anything new or less.

**Two sites.** tests/unit/credential-file-mode-hardening.test.ts:58 (57 before
the import line) built the staging file's pattern with `base.replace(/\./g,
'\\.')`, which escapes only the dots. It now goes through `escapeRegExp`
(tests/helpers/escape-regexp.ts, from #739). The file has a HOST QUARANTINE
header, so it ran in CI only. For the two base names it passes
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

**Code scanning.** Alerts 21 (the CRLF line) and 16 (the staging pattern),
both js/incomplete-sanitization and dismissed on main as used in tests, no
longer have the shape they flagged once this reaches main.
