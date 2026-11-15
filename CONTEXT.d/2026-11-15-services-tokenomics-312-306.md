## 2026-11-15 -- Services and Tokenomics fixes for 2.1.3-beta.5: the logging PID, no "no price" for a model with no tokens, dead progress rows, unchanged subagent folders

One branch, four items carried from the beta 4 planning records (aicc_planning #312 and #306 items 2 and 4). The owner approved the 2.1.3-beta.5 plan on the Agent Canvas on 2026-11-15.

### The Session logging card shows its worker's PID (planning #312)

**Problem.** `forkTranscriptsWorker` (`src/main/logging/fork-transcripts-worker.ts`) read `proc.pid` once, in the line after `utilityProcess.fork`. A utility process has no PID until it has spawned, which is after `fork` returns, so the value was always undefined and the card showed "-" for the life of the worker. The Tokenomics supervisor already read its worker's PID when the row was built.

**Change.** The handle's `pid` is now a function, read each time the row is built (`LogSupervisor.getDiagnosticsSnapshot`), and an optional `onSpawn` callback (the process's `spawn` event) pushes the row the moment the PID exists. The row shows no PID while the worker is down (crashed, degraded) and for a failed fork, for a value that is not a process id, and when asking throws. A spawn reported by a worker that has since been replaced pushes nothing.

### A model with no tokens is not "no price" (planning #312)

**Problem.** `tkUnpricedNotice` named every model in `summary.unpriced`, and the breakdown legend listed every model split row with no cost. `<synthetic>` (the CLI's own transcript entries, which carry no usage) has no price and no tokens, so Tokenomics said "<synthetic> has no price yet (0 tokens)" and the legend had a "System, no price" row.

**Change.** Both ignore a model with no tokens in the figures (`src/renderer/components/tokenomics/tk-labels.ts`, `ModelCacheDonut.tsx`). Any unpriced model with zero tokens is hidden, not only `<synthetic>`. A real unpriced model with tokens is named as before.

### The projects folder is opened by its real path; rows of gone transcripts are dropped (planning #306 item 2)

**Problem.** The worker kept the Claude projects folder under the path it was given. When that folder is itself a link (the profile's home), the same transcripts were indexed under the link's path and again under the real one. `tk_files` was never pruned, so rows for deleted transcripts and for the second path accumulated and were counted in the Services health figure.

**Change.** (`src/main/tokenomics/tokenomics-worker.ts`, `tk-db.ts`)

- At each `open` the folder is resolved with `realpathSync.native`; the path as given is kept when it cannot be resolved.
- After a COMPLETE full walk the worker lists the progress rows (`listFilePaths`) and deletes those of transcripts that are not there (`deleteFileRows`), 500 rows at a time with the event loop given back between batches. The first batch runs in the turn that said the pass was complete, so a pass with nothing to drop is over at once.
- A complete walk is one where the root exists and was listed, no folder in the tree failed to list, and at least one transcript was found. A walk that failed or fell short, a missing root, a root that lists empty (a drive that is not mounted looks the same) and a pass that threw drop nothing.
- A Claude row is dropped when its path is not among the transcripts the walk found and it was not written since the pass began (a transcript the watcher read while the pass ran has a row the walk did not list). A rollout row is dropped only when its file is not found at all (the rollout lists vary with the account folders named).
- Only progress rows are deleted. No stored usage event, rollup or session is touched, and a file that comes back is read from its first byte and its turns stored once (they are keyed by turn), so a wrong drop could only cost a read again.

**Cost to know about.** For a user whose projects folder is a link, the first walk after the upgrade reads every transcript again from its first byte under the real path (the rows were keyed by the link's path) and then drops the old rows. Totals do not move: events are keyed by turn.

### Sweeps skip unchanged subagent folders (planning #306 item 4)

**Change.** A folder named `subagents`, and the folders below it, is not listed again by a full walk when its state (modified time, id, size) is the same as at the walk that last read it and it had been left alone for 2 s before that. Its transcripts are not asked about and count as found, so their rows are kept. The folders below it are asked about again at each walk, so a change deeper down is found. A transcript added to the folder changes it, so it is read.

The first walk after the worker starts, a Rescan and a re-index read every folder. Depth stays 12.

Nothing is remembered from a pass that left work behind: a transcript longer than one budget (the next pass follows at once), one that could not be opened or read, or a pass that threw, and a read of reported transcripts that stopped at the budget. A file that stays unreadable anywhere in the tree keeps this off, which costs speed only. The next walk then lists every folder again, and folders are remembered only after a pass that read everything, so a transcript is never stranded part-read.

**Scope, stated plainly.** A transcript that only grows in place does not change its folder. Those depend on the watcher and on the 5 s timer's size checks of the 200 transcripts written last, no longer on the 5 minute full walk's per-file check. A Rescan reads everything.

### Tests

- `tests/unit/logging/log-supervisor.test.ts`: the PID is asked when the row is built, pushed on spawn, null before spawn, for a failed fork, a bad value, a throw and after exit.
- `tests/unit/renderer/tokenomics-mp12.test.tsx`: no notice and no legend row for a model with no tokens; a model with tokens still named.
- `tests/unit/tokenomics/tokenomics-worker-prune.test.ts`: realpath at open, the drop (with batches, rollout rows, rows under another path), no drop after a folder that would not list, a root that would not list, a missing root, an empty root, a pass that threw or a failed row listing, a row written since the pass began kept; unchanged subagent folders not listed, an added transcript read, a deeper change found, a transcript over one budget read to its end, one the watcher reported that a budget did not finish, and one that failed to open read at the next walk (folder unchanged), a fresh folder not trusted, Rescan, re-index and a restart reading everything.
- `tests/unit/native/tk-db-prune.native.test.ts`: the two database methods, and events untouched. Native tests do not run on the dev host; CI runs it.

### Not in this change

The Services panel's "files tracked" figure is unchanged in meaning; it falls as rows are dropped. Codex rollout rows are dropped only on a file not found. The ssh.exe lookup and the rest of #306 are other work.
