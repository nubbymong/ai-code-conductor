## 2026-11-25 -- beta.18 fix round after section 3.2's host line

Section 3.2's host line (Ubuntu 24.04 from the Windows test VM) passed every
check but one, and found two things outside the section. All three are fixed
on the aggregate (PR #762).

**Image paste and Snap into a helper tab typed the request and did not send
it.** Measured from Claude Code's own binary (2.1.332, its input tokenizer):
a control character is a key of its own only when the whole read it arrives
in is shorter than 64 characters; in a longer read a CR stays in the text. A
helper tab hands each write to the holder as one frame, and the holder writes
each frame whole, so the fetch request and its CR (about 175 characters, one
write) reached Claude Code as one read. A canvas marker is under 64
characters, so its CR was the Enter, which is why the marker sent itself in
the same tab. Today's SSH tab sends the same one write through ConPTY and
ssh.exe and submits; how they split it was not measured. Fix (`src/renderer/utils/imageTransfer.ts`
sendFetchRequest): for a tab main says runs through the helper
(`ssh.getState` answers `through-helper`), the request, then the Enter as its
own write 300 ms later, as a prompt button's Enter goes into a Claude Code
session (#333); no Enter if the tab started again or closed meanwhile. Every
other tab types what it typed. Every door that types a line and its Enter
into a helper tab now sends the Enter as a separate write (image paste and
Snap here, the Watchdog's retry since the second pass below, prompt buttons
and broadcast since #333); a canvas marker's line and Enter stay under 64
characters.

**Second pass (PR #762 review).** The Watchdog's retry still typed its line
and Enter in one write, and its message is the user's own, up to 200
characters: in a helper tab a message of 63 characters or more was typed and
not sent, and each later retry added to the same line. Fix
(`src/main/providers/claude/run-screen.ts` retryClaudeLine, told by
`RunScreenTyping.wholeWrites`, which session-input reads from the remote
helper's record of the tabs it started): the line, then the Enter as its own
write 300 ms later, only while the run is the same; every other tab keeps its
one write. And input typed while a helper tab was detached was flushed back
to back at the attach again, so a request and its Enter queued during a link
drop reached Claude Code as one read once the link was back. Fix
(`src/main/session-helper/helper-pty.ts` flushQueued): the queue goes in
order, but a lone Enter goes 300 ms after the frame before it, with new input
queued behind it until it has gone.

**A helper tab ran at the model's default effort.** Measured from the same
binary (its effort resolution): a top-level `effortLevel` is the session's
effort from every settings source but the user's own; in
`~/.claude/settings.json` it is a legacy effort applied to some models only
(Fable 5.2 was not one on the host line). Today's SSH setup copies every key
of the user's settings into its `--settings` file, so there it is the
session's effort; the helper's file held only `statusLine` and `hooks`. Fix
(`src/main/providers/claude/remote-launch.ts` claudeRemoteSettings): the
helper's session `settings.json` carries the host user's own keys less
`mcpServers`, as today's file does, with the app's `statusLine` and `hooks`
over them.

**The re-attach line blamed the helper for a killed local ssh.** A bridge
exit before the launcher's hash line was told as "the session helper on the
machine ended (exit 4294967295)": Windows' -1 read unsigned, from the local
ssh.exe ended by force. `localSshEnd` (`src/main/remote-helper/ssh-exec.ts`)
names an end on this computer (a signal, or an exit outside 0 to 255, printed
signed): "the ssh link on this computer ended before the session helper
answered (ssh exit -1)".

Owed: ADR-009 pass before stable (aicc_planning #320 list), with section 3.2's.
