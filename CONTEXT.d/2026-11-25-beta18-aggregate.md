## 2026-11-25 -- 2.1.3-beta.18 lands in one PR, with its release commit

**One PR for the beta.** The reviewed sections of 2.1.3-beta.18 were merged at
their frozen heads with real merge commits onto one branch from beta (#762),
in the order 1, 2, 3.1, 7.3, 7.4, 4, 7.1, 7.5, 7.2, 5 and 3.2. Each join had
one commit for its owed user text and docs (plan rule 38); 7.2 owed none. A
fix round after section 3.2's host line followed (its own fragment, below).
The version bump, the changelog entry's last lines and the release surface
sweep are one commit, the release commit. Nothing in the plan was dropped.

**Sections and their fragments (15.8).** 1, aicc_planning#429:
`2026-11-25-provider-ratchet-blind-spots.md`. 2, aicc_planning#430:
`2026-11-25-remote-launch-from-package.md`. 3.1, aicc_planning#431 (its hook
half #433): `2026-11-25-helper-status-mode.md`. 3.2, aicc_planning#431:
`2026-11-25-remote-helper-status-hooks-tools.md`. 4, aicc_planning#432:
`2026-11-25-one-input-seam.md`. 5, aicc_planning#433:
`2026-11-25-codex-hooks-through-holder.md`. 7.1, aicc_planning#407:
`2026-11-25-uninstall-codex-pick-folders.md`. 7.2, aicc_planning#418:
`2026-11-25-ci-node-24.md`. 7.3, aicc_planning#426:
`2026-11-25-tip-sweep-unrendered-body.md`. 7.4, aicc_planning#427:
`2026-11-25-codex-0172-terra-corpus.md`. 7.5, aicc_planning#428:
`2026-11-25-snap-codex-warning-count.md`. The fix round after the host line:
`2026-11-25-beta18-host-line-fix-round.md`. Section 6 has no fragment of its
own; its line follows.

**Section 6 (aicc_planning#425), a reading with no fix.** On the signed
2.1.3-beta.17, 17 runs in four tab kinds (local 4, SSH 4, SSH Persistent 4,
helper 5) on the Windows test machine, with Claude Code's "Press up to edit
queued messages" hint shown: its first letter was never missing in the PTY
bytes, the terminal's buffer, the pictures or the pixel reads. No app cause
was found, so nothing was changed; #425 stays open for the owner's own step.

**The release commit.** Version 2.1.3-beta.18; the changelog entry (dated
2026-11-25) gains its highlights line and says the remote preview is a
Windows one; CHANGELOG.md regenerated. The surface sweep: app-knowledge
names what the remote preview does not carry yet (SSH Persistent, password
sign-in, containers, post-connect commands, macOS and Windows hosts, Codex
sessions; the account, per-model weekly limits and extra usage on its status
line were already named) and gains one known issue with its workaround: a
Codex session that 2.1.3-beta.17 or earlier started still misses hook events
made during an update. The Feature Guide's Settings card says a remote tab
has its status line, hooks and the Conductor's tools. ADR-030 names
aicc_planning#434 (the account label, per-model weekly buckets and extra
usage on a helper tab's status line) as a gate beside P1, and Rocky's P1 as
owed. The threat model lists the Codex hook forwarder of section 5 as owed to
the security round. pr-title.yml, issue-disposition.yml and
close-in-beta-on-promotion.yml move from Node 20 to 24: commitlint 21.2.3
asks for Node 22.12 or later, and the PR Title job's npm ci printed
EBADENGINE warnings on Node 20.20.2 (run 45627167014).

**Checked, no change: the old SSH setup and ~/.claude.json.** Section 6's
reading saw a plain SSH tab's connect add 84 bytes to the host account's
~/.claude.json while its Claude Code used a config folder of its own (a
test-only wrapper). The old setup script
(providers/claude/ssh-shim.ts, the #25 block) marks the tab's configured
remote folder as trusted in ~/.claude.json, so Claude Code does not stop on
its first-run trust question; one such entry for a folder of that name is
75 to 98 bytes by the folder's name (the keys were not read on the host).
That is intended, not a defect. It writes ~/.claude.json, not a config
folder named by CLAUDE_CONFIG_DIR, so on a host that moves Claude Code's
config, Claude Code asks its trust question itself.

**The seam audit re-run.** The audit's numbers were measured again at the
aggregate's head by the audit's own method (git grep over src, the two
provider folders left out); the table and the exact commands are in PR #762.

**Release smoke fixes.** The release smoke on 449c8b02 (a Windows test VM
driving an Ubuntu 24.04 host) found five things a user sees, fixed here with
a test each, red before and green after. On the Machines page the Remove
question opened under the notice of an earlier action; opening it now clears
that notice (RemoteMachinesSection). A tab through the session helper never
reports its account yet, so its header showed three loading pills for 20 s,
then nothing; it now shows one pill, "Account not shown through the helper
yet" (SessionHeader, through useThroughHelper, which reads main's SSH flow
state as the SSH flow overlay does). A session card with ATTENTION, SSH, the
working mark, the type mark and an effort badge cut its name to "S.."; the
name column now keeps about ten characters (its own length when shorter) and
the badges wrap (SessionRow). What's New on an update named only the model
list and Fable 5.2 for the whole 2.1.3 line; the line now also tells the
Machines page, Snap's own overlay, the broadcast chooser and the remote
sessions preview, each tagged with its first build. The Feature Guide's
Machines card now names the remote sessions switch. Two wording fixes: the
uninstall line says "a Codex session's resume list", and app-knowledge's
remote paragraph says "A tab through the helper has its status line..." so
the sentence is not read as the other tabs'.
