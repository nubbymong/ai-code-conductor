## 2026-11-22 -- The Codex model picker comes from the installed Codex's own list (aicc_planning#362)

2.1.3-beta.14, section C9.

What changed:

- The Codex picker and its effort list now come from the installed Codex's
  own list (`codex debug models --bundled`), read in main whenever the app
  finds Codex, finds another version, or Codex is switched on, and on
  Sentinel's Re-run (`src/main/installed-codex-models.ts`). The list is the
  registry's last layer (`setInstalledCodexModels`, model-registry-service.ts),
  so the pickers in the renderer, the Codex launch's effort check in main and
  Sentinel all see it. A registry row only adds a price or corrects a label
  (`withInstalledCodexModels`, src/shared/model-registry.ts); a Codex row the
  list does not name stays, not offered, so a running session is still placed.
  With no list (Codex off or not found, a version the app cannot use, a read
  that failed) the registry is offered alone, as before.
- The reader now reads each model's `supported_reasoning_levels` too, as
  strictly as the rest: a level list it cannot read makes the whole list
  unreadable.
- A new config starts on the installed list's first model.
- The read counts as Codex in use (provider-in-use.ts), so a switch-off
  either sees it or refuses it. Sentinel's start-up check takes the read the
  app made when it found Codex, so a start runs one read. When Sentinel asks
  first (its read then waits for the look for Codex), the app takes that
  read's answer as its own when it is for the version found, so the order
  does not matter.
- Release gate check 3 and the shared rule no longer fail on a listed id
  with no registry row (reported as INFO); they fail on an empty list, a
  Codex id listed twice, or a listed id a Claude model holds as its id or
  alias (the picker never offers that id). The real-CLI conformance case
  checks that the list is read with its levels and offered as read.
- Sentinel no longer raises the Codex "not in the model picker" notice; one
  an earlier build raised closes at the first completed check. With a live
  list the picker is that list, so no "still selectable" notice is raised
  either, and one an earlier build raised closes on a live read; offline the
  registry alone is compared with the shipped list, as before.

Limits, by design: a level the installed Codex lists that the app's launch
does not take (the fixed CODEX_EFFORTS set) is not offered. Nothing is kept
on disk: each start reads the list again.
