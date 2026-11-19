## 2026-11-19 -- The Helper job also runs on a dispatch that names it

Plan 2.1.3-beta.12, section C1 (aicc_planning#351). CI only; nothing in the app changes.

- **Why.** The Helper job (ci.yml) ran only on a push and on a pull request into beta, main or
  release/**. A helper/ section that waits on another one could not have its Rust built and tested
  until it opened a pull request, and it could not open one before its predecessor merged: beta.11's
  A3 sat idle for more than a day that way. Process simplification 9 of the plan builds such a
  section on a pushed branch instead, as probe P19 already was.
- **What.** One dispatch input, `helper` (a boolean, default false), first in the list, and one more
  way into the Helper job's condition: `github.event_name == 'workflow_dispatch' &&
  github.event.inputs.helper == 'true'`. `github.event.inputs` gives every input as a string, so the
  condition compares with the string; a bare `github.event.inputs.helper` would take the string
  'false' as a yes, and `inputs.helper == 'true'` compares a boolean with a string and is never
  true. On a dispatch, scripts/ci/helper-scope.mjs already answers "build", so the three runners
  build and test the helper at the dispatched ref. Nothing else changes: not the pull request or
  push cases, not the permissions (contents: read), not another job's condition, not
  helper-scope.mjs, and the job is still not a required check. A dispatch also runs the conformance
  legs, as every dispatch does.
- **How to use it.** `gh workflow run ci.yml --ref <branch> -f helper=true` on the pushed branch
  (helper/README.md, "Building and testing"). The pull request opens once, after the predecessor
  has merged and the branch has been moved onto beta.
- **Tests.** tests/unit/scripts/helper-ci-job.test.ts evaluates the condition on a dispatch as
  GitHub gives it: the strings in `github.event.inputs` and the typed values in `inputs`, every
  declared input at its default unless the case sets it. True with `helper` set; false when it is
  left out, set to 'false', or when only another input is set. The pull request and push cases are
  unchanged. Run on this PC under four planted conditions, each restored, and red under each: every
  dispatch runs the job; the input is ignored (the old condition); `inputs.helper == 'true'`; a bare
  `github.event.inputs.helper`.
- **Left as it is.** The comment above `workflow_dispatch` (ci.yml) still says every job other than
  the conformance one skips a dispatch; #737 rewrites that sentence, so this change keeps clear of
  it and the input carries its own comment. Once both are on beta, that sentence can name the
  Helper job too.
