## 2026-11-20 -- The reviewed 2.1.3-beta.11 changes land in one PR, with Codex 0.171.0 as the newest tested

**Why one PR.** The twelve reviewed changes of 2.1.3-beta.11 were built and
reviewed one by one, then merged (or, for the five built on a local branch,
cherry-picked) in the planned order onto one branch from beta. One CI run and
one final review of that head replace about ten rounds of replay, CI and merge.
Each constituent's own PR body still says what it does and what it owes.

**Conflicts, each resolved by keeping both sides.**
- ADR-030 and `helper/probes/README.md` (P18 from beta.10, P19 from A1): both
  probe rows, both result paragraphs and both README sections, P18 first; the
  probe count reads nineteen.
- `.github/workflows/ci.yml` (A1's probe-p19 job and the upstream CLI watch's
  claude-conformance job, added at the same place): both jobs whole, probe-p19
  first, and the trigger comment names both.
- The WP1 ledger: rows merged one by one. Two rows both sides wrote:
  `helper/probes/README.md` (one row now names P18 and P19) and `ci.yml` (both
  evidence clauses kept, A1's first). The manifest was taken from either side
  during the merges and written again once, at the end.
- `scripts/wp1/legacy-codex-manifest.mjs`: the isCode comment names P18 and
  P19, as A1's merge notes asked (a comment only; the predicate digest hashes
  the function).

**Codex 0.171.0 is the newest tested version.** CI run 44688602365 ran every
real-CLI conformance check of Codex 0.171.0 on Windows, macOS and Linux, on the
head of the 0.170.0 change (6d58e04f), and all nine Codex legs were green. Its
first attempt had the macOS rc leg red at `npm ci` (a network reset, before
Codex was installed); the second attempt ran that leg again, green. 0.171.0
lists the same eleven models as 0.170.0, in the same order, so the registry
does not change; the catalogue names 0.171.0 among its versions.
`CODEX_MAX_TESTED_VERSION`, README.md, docs/USER_GUIDE.md, the Feature Guide's
known issue, ADR-022 and the evidence record follow it. The too-new examples
move from 0.170.1 to 0.171.1, which is above the new top. The new expectations
were seen red against 0.170.0 (5 cases in cli-discovery, codex-usage-read,
model-catalogue and app-knowledge). Not shown: a usage reading on 0.171.0 needs
a signed-in account, and 0.171.0's app-server schema was not compared.

**The screen corpus lists no known misread.** Since #740 (beta.10) Codex's
reader reads the four Codex 0.157.1 ready recordings as ready, so the test
reported each as reading right and all four entries were removed.

**A new Codex config still starts on GPT-6-Astra.** C4 put the four models
Codex 0.170.0 and 0.171.0 list first at the head of the picker, so a new
config would have started on GPT-6.2-Sol, which no supported Codex from 0.153.4
to 0.169.x lists (the pinned 0.155.1 and the test VM's 0.157.1 included). What
such a CLI does with `-m gpt-6.2-sol` was not measured: this pass could not use
the VM. So the rule now counts only the models every supported version in
resources/codex-model-catalogue.json lists, and a new config starts on the first
of those, GPT-6-Astra, as before C4. It moves to the head of the list by itself
once every supported version lists that model; Default (Codex chooses) is the
fallback when none does. GPT-6.2-Sol stays in the list to pick.

**Owed text applied here.** B2's known issue: with Claude Code and Codex
sessions through the session helper on, a dropped and restored connection to
the helper ends a held session's tool server; the workaround is /mcp in Claude
Code, or restarting the tab.
