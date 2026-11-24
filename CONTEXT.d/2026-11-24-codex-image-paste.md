## 2026-11-24 -- A pasted or snapped image goes into a Codex session as Codex's own paste (plan 2.1.3-beta.17 C6, aicc_planning#415)

What changed: main's image door (session-input `submitImage`) takes a Codex
session on this computer too. Since beta.16 X1 it pasted an image into a local
Claude Code session only; a Codex session answered `not-taken` and the
renderer typed the sentence and the path, which Codex reads as words (probe
P11). The door now hands a Codex session's image to the Codex package's image
rule through the registry (`SessionRunScreen.submitImage`,
`providers/codex/session-screen.ts` `pasteImageIntoCodexComposer`): wait for
Codex's ready, empty composer as a prompt button does; the path as a bracketed
paste; Codex's "[Image #1]" read on the screen the composer rule reads (the
holder's for a held session, main's pane otherwise); then the sentence through
the submit primitive, reading the composer with the placeholder taken as its
start (`src/shared/codex-image-screen.ts`), confirmed, then Enter. What it
cannot paste (not ready, no placeholder, Codex's warning count, the sentence
not confirmed) it takes back with Ctrl+U, only while the composer holds
nothing but the paste, and the renderer types today's line by its own Codex
rule, which types only into an empty composer and says why when it cannot.
Snap in a Codex tab goes the same way now and no longer types the raw line
(the sentence, the path and Enter in one write), which Codex never sent.

Why the rule is built this way (C6's reading, plan review finding 14, no
build; P11's stand-in, Codex 0.157.1 with GPT-5.5, the Windows test machine,
bundled ConPTY, 120 by 40): with the placeholder in the composer, Codex's
screen reads ready but not empty, so `submitCodexText` alone waits for an
empty composer and would never type the sentence; read past the placeholder
it reads ready and empty and the sentence typed after it confirms (4 of 4).
The placeholder showed 251 to 314 ms after the paste (7 of 7). Ctrl+U cleared
it in about 80 ms and the next turn carried no picture (4 of 4, with and
without the sentence typed); one Backspace left it (it took the space Codex
types after it). An em dash typed after the placeholder reached the turn
(3 of 3). The turn carried the picture, the same bytes (3 of 3).

Shape: both of the run screen's doors (a text, an image) share one per-run
chain (`onRun`), so an image and a marker, a prompt press or an Ask question
never interleave; the session input ownership test counts the new door as it
counts `submit`. `providers/codex/composer-submit.ts` and
`shared/codex-screen.ts` are unchanged (C7's files).

Not measured: a full-size Snap picture's placeholder time (the wait is 5 s);
a session held by the session helper on the real CLI; macOS and Linux; Codex
over SSH (not a route today).
