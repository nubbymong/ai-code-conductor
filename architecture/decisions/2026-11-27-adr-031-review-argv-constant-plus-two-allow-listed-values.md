# ADR-031: A review's argv is a constant plus two allow-listed values

- Status: Accepted (owner approval of the 2.1.3-beta.20 plan, 2026-11-27,
  phase 1, nubbymong/aicc_planning#446; questions Q1 and Q2 decided there)
- Date: 2026-11-27
- Amends: owner decision D3 as `src/main/providers/codex/cli-runner.ts` states
  it ("the argv is a constant per operation"), for the review operation only;
  the same rule for the Claude reviewer (`src/main/providers/claude/review.ts`,
  `CLAUDE_REVIEW_ARGS`)
- Related: ADR-009 (adversarial review), ADR-028 (beta cadence)

## Context

The Conductor MCP tools `codex_review` (offered to a Claude session) and
`claude_review` (offered to a Codex session) each start a one-off reviewer
CLI. Until now each reviewer's argv was a constant: no text from the request
reached a command line, and the review ran on whatever model and effort the
reviewer CLI chose for the account (Codex at a fixed medium effort since
2.1.3-beta.8). The asking agent could not choose a deeper or a cheaper review,
and the result did not say which model or effort had run.

The owner asked for both in 2.1.3: the caller chooses the model and the
effort, and every result names what ran.

## Decision

1. **The argv is the constant plus two allow-listed values.** A review's argv
   is the operation's constant, plus at most two elements of its own: the
   model and the effort.
   - Codex: `-m <id>`, placed just before the effort override, and the level
     of `-c model_reasoning_effort=<level>` (medium when none is chosen).
     Every other element is the constant's, in its order.
   - Claude Code: `--model <id>` and `--effort <level>`, after the constant.
2. **Allow-lists, read when the review runs.** Main
   (`src/main/codex-review-mcp-tool.ts`) checks each value against lists it
   reads from the model registry at the time of the review, before anything is
   read, leased or run:
   - Codex model: the Codex picker's own models (the installed Codex's list
     once it has been read, else the registry's Codex models), each an id
     `isCodexModelId` accepts.
   - Codex effort: the Codex CLI's efforts less `none`, each one the model
     runs (`codexEffortRuns`).
   - Claude model: a Claude id or alias of the registry, whose first
     character is a letter or digit. A pattern or a label is never a match.
   - Claude effort: the registry's Claude levels the model supports
     (`buildEffortRows`).
   A value off a list is refused with the list. It is never dropped, so the
   caller always knows that what it asked for is what ran.
3. **Checked again where the argv is built.** Each package checks the two
   values again before it builds the argv (`codexReviewArgs`,
   `claudeReviewArgs`): a model of the form a launch takes, with a letter or
   digit first, and an effort of the CLI's own form. Every element then passes
   `PLAIN_ARG` through the shared command-line rules, as before. On the Windows
   `.cmd` shim route the line reaches cmd.exe verbatim, so the allow-list is
   the control there and `PLAIN_ARG` stays the backstop. Each value is always
   one whole argv element.
4. **Defaults.** With nothing chosen, a review runs exactly as it did in
   2.1.3-beta.19: its argv is the constant, word for word. A Codex review with
   no model chosen passes no `-m`. The installed Codex's list is not used to
   name a default: it is the catalogue built into the binary, read in an empty
   home with no sign-in, not the list Codex refreshes for the reviewer
   account, so its first model is not known to be that account's default.
   Naming the account's default needs a read of the account's own list, which
   this decision leaves for later.
5. **The environment is kept and reported (Q1).** `ANTHROPIC_MODEL` and
   `CLAUDE_CODE_EFFORT_LEVEL` in the app's environment stay in the Claude
   reviewer's environment. A Claude review with no model chosen runs on
   `ANTHROPIC_MODEL` when it is set; `--model` comes before it. A chosen
   effort is refused while `CLAUDE_CODE_EFFORT_LEVEL` is set, because that
   variable comes before `--effort` and the choice would not run.
6. **Every result says what ran.** The footer, and a log line before and
   after the run, name the model, the effort and where each came from:
   `caller`, `default` or `environment`. Codex's model is the one on its argv,
   or "the reviewer account's default model, not named" when there is none.
   Claude Code's model is the one its result reports (its model usage); when
   it reports several, the footer lists them all as reported, and when it
   reports none, the footer says the model was requested and is not
   confirmed. A value nothing confirms is said as requested, not confirmed:
   Claude Code's effort (its result does not report one), and Codex's effort
   when no model is named (it was checked against no model's levels). A
   reviewer that never started names no model. The app never guesses.
7. **No cap on cost (Q2).** A caller may choose the most expensive model and
   effort. One review runs per session at a time, within 30 to 900 seconds,
   and the footer shows the choice. Whether that is enough is judged in the
   pre-stable security round.

## Consequences

- An agent can ask for a deeper or a cheaper review, and can tell which model
  and effort a review it relies on ran on.
- The rule "no request text reaches a command line" becomes "no request text
  reaches a command line except a value taken from a fixed allow-list, as one
  whole element". Any later change that adds an argv value goes through the
  same two checks and gets an ADR note.
- The lists follow the registry: a model the installed Codex adds, or one the
  model data adds, can be chosen with no app release.
- `ReviewRunInput` carries `model` and `effort` and `ReviewRunResult` carries
  `reportedModels`, so a review on the session's own machine (helper path,
  2.1.3-beta.21) can carry them unchanged.
- The ADR-009 pass for this change is owed before stable (the pre-stable list,
  aicc_planning#320), as for the other 2.1.3 betas.
