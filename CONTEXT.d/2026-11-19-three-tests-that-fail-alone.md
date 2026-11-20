## 2026-11-19 -- Three tests that failed with no code change

Section C3 of the 2.1.3-beta.11 plan (aicc_planning #210, #187, #293). Tests
only: no product file changes, no test asserts anything new or less, and
nothing retries.

**Ports (#210).** Six Conductor MCP test files start the real server on a
random port in a fixed range of 1,000, with no retry. Three ranges (32000,
33000 and 36000) reached into Linux's outgoing-port range, which starts at
32768, and a port an outgoing socket already held failed one release PR's
listen with EADDRINUSE. Those three move to 27000 (codex-browser), 26000
(token-epoch) and 25000 (ended-session). 29000, 30000 and 31000 were already
below 32768 and stay. Each file keeps a range of its own and says why in one
comment line. The server's start function is not changed. 28000-28999 is left
free because Windows can reserve single ports there (one development PC
reserves 28385 and 28390). A new MCP test file takes a free range below 32768:
20000-24999, or 28000-28999 if it can live with those two.

**The timing check (#187).** account-log-folders.test.ts judges that a path
four times as long takes under eight times as long to check. A loaded macOS
runner failed it at 8.5 (3.54 ms, then 30.09 ms). The three runs of each size
came one after the other, so a slow spell during the larger size's runs
inflated that size alone. Now the input is twice as large (100,000 and 400,000
segments), the two sizes are timed in turn after one warm-up run of each, and
each keeps its best of seven. Under a named floor of 5 ms the smaller time is
not used in a ratio: the larger time is held to eight times the floor (40 ms).
The floor was 1 ms before, unnamed. The assertion is the same.

On the owner's PC under the test runner: 2.83 ms, then 12.16 ms (under the
floor, so held to 40 ms). Planted slow versions of the function, in the product
file and never committed:
- each segment scans the whole path again: 546.58 ms, then 9232.89 ms, ratio
  16.9: red.
- every hundredth segment scans the whole path again: 8.78 ms, then 108.28 ms,
  ratio 12.3: red.
- each segment's own name scanned a second time (twice the work, still
  linear): green, as a growth check should be.

The plan's "scan twice per segment" is read as the first plant, a scan of the
path for each segment. A constant slowdown is not growth, and this check never
judged one.

**One regex escape (#293).** `tests/helpers/escape-regexp.ts` escapes every
character a pattern reads specially. The plan's three places escaped only some
(tests/unit/credential-file-mode-hardening.test.ts:57 has the same dots-only
shape and is left for its own ticket): the
parentheses in window-ipc-registered-once.test.ts, and the dots in
onboarding-layout-contract.test.ts and tests/wp1/binding.ts. That is the shape
code scanning flags as an incomplete sanitization. All three use the helper
now, and binding.ts's own two full copies (its escapeRe and an inline one in
the cites pattern) give way to it. A planted text that an
unescaped pattern would accept turns each check red: the call without its
parentheses, `xmark` for `.mark`, and `WP1x11` for `WP1.11`.
`tests/unit/meta/escape-regexp.test.ts` checks the helper on every special
character, with and without the u flag, and is red on the old dots-only shape.
The ticket's fourth place (a single replace in app-server-client.test.ts) is
not in this section. The code scanning alerts on main for the three places
were already dismissed as used in tests on 2026-10-14; this removes the shape
they flagged.

**Not changed here.** docs/wp1/evidence/skip-ledger.md (lines 288-294) still
lists #187 and #210 as known flaky tests, with the old ranges, and says a red
Test job that names one is re-run once. It is WP1.65 evidence pinned by its
sha256 at d1525759, so it is retaken at the next WP1 binding, not edited here.
After this change, a red run that names one of these tests is read as a new
failure, not re-run.
