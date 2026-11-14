## 2026-11-14 -- A finished test run removes only its own temp folders; the Copilot notes point at the release process

**Problem.** When a vitest run ended, `tests/global-setup.ts` removed every `ccc-vitest-*` folder in the machine temp folder, including the working folders of another run going on at the same time (two agents, or a watch run beside a full run). `.github/copilot-instructions.md` also still gave the old stable route (merge `beta` to `main`, then `npm run release -- --stable --no-bump`), which is not the release-branch model in `AGENTS.md`.

**Fix (test-side only, nothing shipped).**
- `tests/helpers/vitest-run-tag.mjs` is new. Global setup makes an eight-digit hex tag for the run and puts it in the environment before any worker starts, so the workers inherit it.
- The two folders the harness makes straight under the machine temp folder now carry it: the per-worker root (`tests/helpers/test-tmp.ts`) and the isolated home (`tests/helpers/home-guard-core.mjs`) are named `ccc-vitest-<tag>-...` and `ccc-vitest-<tag>-home-...`.
- The teardown removes only the folders that carry its own tag. With no well-formed tag it removes nothing, so it can never fall back to the old sweep.
- A folder left by a worker that was killed during an EARLIER run is no longer cleaned up by a later run (that was the same sweep). Those are named with the earlier run's tag; delete them by hand if they pile up.
- A process that does not start under global setup (the native and live configs have none) still gets the plain `ccc-vitest-` name, as before.
- `tests/unit/test-isolation/run-tag-teardown.test.ts` is new. It plants another run's folders, an untagged one and unrelated ones in a scratch folder under the worker's own temp root, and checks that only this run's go. It also checks that the tag reached the worker.
- `.github/copilot-instructions.md`: the stable-release line is replaced by a pointer to `AGENTS.md`, section "Release Process". The procedure itself is not copied there.

**Checked.** The new test is red on the old code (the tag never reaches the worker) and red with the old match put back into the removal step (another run's folder is taken). A folder named like another run's, planted in the real temp folder, is removed by the old teardown and survives the new one.
