## 2026-10-12 -- the Codex reviewer is sent the change and runs no commands (2.1.1-beta.3)

- **Why:** on Windows a Codex code review could run no command at all.
  Codex's exec policy treats a read-only run with no Windows sandbox set as
  needing approval for every command, and `codex exec` never asks, so every
  command (even `git status`) was refused. The reviewer had only a scope
  line, answered by asking for the diff, and that reply came back as a
  finished review. Same on 0.153.4 and 0.155.1, and in every release with
  the reviewer. The owner chose "diff in the prompt, no commands" on every OS
  over changing the reviewer's Windows sandbox setting.
- **The request:** `codex-review-mcp-tool.ts` builds one prompt for both
  reviewers (`buildReviewPrompt`); the Claude request is unchanged byte for
  byte. `CODEX_SPEC` now has `needsDiff` and `needsFiles`: modes `working`
  and `range` send the diff `produceReviewDiff` makes with the hardened git,
  between `CHANGE-<nonce>` markers (a fresh nonce per review), in the Claude
  reviewer's scope words; both tools now take the same real-range text.
- **Mode `paths`:** the Claude reviewer reads the named files itself; the
  Codex reviewer can read no file, so main reads them (`produceReviewFiles`
  in `review-diff.ts`) and sends each after a `FILE-<nonce> "<path>"` line
  inside the markers. Before a name is opened, it and every folder on its way
  from the project are checked (lstat): a link or a junction anywhere on the
  way, a folder, a device, a pipe or a file with more than one name is
  refused there, unopened. The file is then opened (on Linux and macOS
  without following a link at the name) and checked again: a plain file with
  one name, inside the project's real path, and the very file at that real
  path. Anything that fails a check is refused, never read. Binary content (a
  NUL in the first 8000 bytes) is named, not sent. The files of one request
  have the same 30-second budget as a git run of a diff, and stop at once on
  a cancel, so a read that never returns cannot hold the session's one
  review; while a file call of a stopped request has still not returned, a
  new paths request is refused rather than started.
- **Size:** the diff's bound (512 KB) covers the whole request: every name as
  given (the scope line), each `FILE` line and each file's text. Past it the
  request is refused, never cut, so no prompt carries part of a change and
  there is no truncation note to write.
- **The argv:** `review` turns off every feature the analysis run turns off
  (shell_tool, unified_exec, apps, plugins, browser_use, computer_use,
  image_generation, view_image, multi_agent, code_mode, code_mode_host) and
  web search, and keeps `--disable hooks` (D3), the ignore flags, the
  read-only sandbox, `-m gpt-5.5` and `-`. Each name is in both supported
  CLIs' feature lists. `project_doc_max_bytes` and `project_root_markers`
  stay at Codex's defaults: the analysis runs in a folder the app made, but a
  review runs in the project under review, whose AGENTS.md is context for it
  and comes from the same source as the change.
- **Refusal text:** there is no refusal-text rule for the Claude reviewer to
  mirror, so none was added. Both reviewers keep the shared empty-reply rule.
- **Owed:** a real review on Windows with Codex 0.153.4 and 0.155.1 that finds
  a deliberate bug from the diff alone, and one on macOS or Linux in each mode
  with no command attempted; the real-link proof
  (`review-files-real.test.ts`) and the real-CLI flag checks on CI or the VM;
  the ADR-009 security review of the review tool, the argv and the file
  reading.
