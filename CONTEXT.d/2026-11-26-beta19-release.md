## 2026-11-26 -- 2.1.3-beta.19 lands in one PR, with its release commit

**One PR for the beta.** The reviewed sections of 2.1.3-beta.19 were merged
at their frozen heads with real merge commits onto one branch from beta
(#763), in seven joins: 1.1 and 5; 1.3, 3 and 4 (with the raise of the
tested Codex to 0.172.0); 6.1 and 6.5; 6.2; 6.4; 2 (joined before 1.2, as
1.2's fix round touched section 2's file); and 1.2 with 6.3, last. Each join
but 6.4's (which owed none) had one commit for its owed user text and docs
(plan rule 38). Five fix rounds ran on the aggregate, the first before any host line;
PR #763's comments hold each cause and its evidence. The release commit is the version
bump, the changelog entry's highlights line, beta.18's date and the release
surface sweep. Section 2 dropped its part 2.1.4, the plan's one droppable part of it:
every group it would fold is read in files other sections held this beta
(aicc_planning#439 keeps it); nothing else was dropped. Section 7 is readings
only, at the release smoke.

**Sections and their fragments (15.8).** 1.2 with 6.3, aicc_planning#437
(6.3: aicc_planning#440): `2026-11-26-remote-persistent-through-holder.md`. 2, aicc_planning#439:
`2026-11-26-local-launch-and-lifecycle.md`. 3, aicc_planning#434:
`2026-11-26-remote-helper-account-usage.md`. 4, aicc_planning#436:
`2026-11-26-codex-two-row-footer.md`, and the raise in
`2026-11-26-beta19-aggregate.md`. 5, aicc_planning#435:
`2026-11-26-remove-screenshot-history-menu.md`. 6.2, 6.4 and 6.5,
aicc_planning#440: `2026-11-26-enter-wait-provider-rule.md`,
`2026-11-26-installer-why-probe-bound.md` and
`2026-11-26-helper-off-leftovers.md`. 1.1, 1.3 and 6.1 have no fragment of
their own; their lines follow.

**1.1 (aicc_planning#437), the helper.** `hold --until-ended` starts a holder
with no away clock: with nobody attached it ends once its program has exited;
until an app has attached for the first time, no sooner than the default
120 s after its start. It also ends at `term.end`, or with the machine. Its
record carries `"away":null` and `"lifetime":"until-ended"`, and list mode
prints it. The holder marks its socket as used every hour and binds it again
if a clean-up of /tmp takes it. The field mode reads one string from a JSON
file under the home (section 3's account label).

**1.3 (aicc_planning#438), an arm64 Linux helper.** The helper builds for
aarch64-unknown-linux-musl natively on GitHub's arm64 runner, with no change
to its source; the installer carries both Linux helpers and the manifest
lists both. The machine's own `uname -m` picks one row of a fixed table, by
equality (x86_64 or aarch64); 32-bit Arm is refused. Its device line ran on
the owner's Raspberry Pi 5 (arm64).

**6.1 (aicc_planning#440), a canvas line into a helper tab.** A canvas
decision line typed into a Claude Code tab through the session helper goes as
the line, then its own Enter, so a line of any length is sent; before, one
of 63 characters or more would have stayed typed at the prompt.

**Decided in the release commit.** The 2.1.3-beta.18 entry is dated
2026-11-25, its publish day (23:17Z), not 2026-11-26. The 2.1.3-beta.19
entry is dated 2026-11-26, the planned cut day (rule 39; `date -u` read
2026-11-26 at the commit). `ci.yml`'s `codex_rc_version` is a dispatch input
with an empty default, so no tested-version pin there needed the 0.172.0
raise; the P19 probe and the Snap e2e keep Codex 0.157.1, the version their
readings were taken with. ADR-030 now records P1 on Rocky Linux 10.2
(x86-64) and on the owner's Raspberry Pi 5 (arm64) as measured by section
1.2's lines, and aicc_planning#434 as a gate on any default beside P1.
pty-manager.ts stays at 7,517 lines, its cap.
