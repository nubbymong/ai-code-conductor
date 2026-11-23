## 2026-11-23 -- P11 measured; a local Claude Code session gets an image as its own paste

Plan 2.1.3-beta.16, section X1 (aicc_planning #405).

Probe P11 (helper/probes/p11-probe.cjs with p11-model-stand-in.cjs) ran on the
Windows test machine, build 22621, on node-pty's bundled ConPTY, with Claude
Code 2.1.330 and Codex 0.157.1, each in a fresh environment with no account
and no key, pointed at a stand-in model on a loopback port that records
whether the turn carries an image. The picture was a 96 by 64 JPEG in the app's
default screenshots folder shape (a path with spaces). Verdicts, 3 of 3 runs
each, on the decision lines written in the probe's header before measuring:
both CLIs ATTACH the path given as a bracketed paste (the same bytes reached
the model; each showed "[Image #1]" in its prompt) and do NOT attach it as
typed text (the path reached the model as words only). A path with no space
and a path in quotes also attached as a paste (one run each, recorded only).

Two probe fixes before the measured run, found by a one-run check: Codex
0.157.1 started with gpt-5.5 first offers a newer model (the probe now keeps
the existing one), and its footer names the model in capitals (the ready
pattern now matches any case). Claude Code 2.1.330 puts a reminder block of
its own before the user's text, so the stand-in records only the text part
that names the run.

X1.2, built on that result for Claude Code only: a saved image (Snap's
picture, Alt+V's) for a Claude Code session on this computer is typed by main
(session-input submitImage, asked over pty:submitPrompt with the path) as a
bracketed paste of the path, then the sentence 1.5 s later, then Enter 0.7 s
after that: the waits P11 measured with. The prompt buttons' Type it only
setting does not apply. A Codex session and an SSH Persistent session answer
not-taken and keep today's typed line; SSH sessions keep the host fetch line.
Codex's paste waits for beta.17 (its submit primitive refuses a control
character). The request rides pty:submitPrompt because ipc-channels.ts was
another section's this beta.

Not measured: shorter waits than 1.5 s and 0.7 s; a session held by the
session helper (the same bytes through the helper's PTY); a path long enough
to be written in slices; macOS and Linux; Claude Code below 2.1.330.
