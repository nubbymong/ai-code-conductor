## 2026-10-11 -- which launch folders the picker's folder check reads (2.1.1-beta.3)

- **Launch folder check:** `gatePickerSiblingDirs` asks
  the disk whether the resume target's folder is there only when the gate's
  latest answer for that folder, within the reuse window, is clean, and
  never for a network path. For any other answer (refused, not checked,
  timed out, or none on record) it reads nothing and hands the folder over
  as before, as the gate left it. So it never reads a network path the gate
  chose not to read, nor a folder whose scan has not answered in time,
  outside the gate's thread ceiling.
- **What the gate answered:** `gateManagedLaunch` now keeps the verdict it
  returned for each folder (`lastGateAnswer`, `not-scanned` included, for
  the same reuse window as `peekGateVerdict`; older entries are dropped on
  the next write), and that is what decides above. `peekGateVerdict` is not
  used for it: a scan that settles after its launch's deadline records its
  own verdict there, while that launch was told `timed-out`. The record is
  process-wide, so `gatePickerSiblingDirs` reads it for every launch folder
  when it is called, before its first await, and its caller calls it
  straight after its own `gateManagedLaunchDirs` answers, with no await in
  between (or passes its own per-folder answers as `launchVerdict`).
- **Comparing a sibling with the known folders:** a sibling whose name
  differs only in case from a folder already known is compared by real path
  only for local paths, and only within the gate's deadline; a network path
  is compared by its spelling alone, and no answer in time means "not the
  same folder", so the sibling is gated on its own.
- **8.3 short names, evaluated and kept as they are:** a managed resume
  still starts at the real path's long names, so a worktree listed by an 8.3
  path (or through a junction Node's JS resolver does not follow) starts a
  new session instead of resuming. Starting at the JS-followed path would
  keep those names, but that path can still pass through such a junction,
  which the native real-path check follows and a launch would follow again
  later. A known-issues entry records it.
- **Owed on CI or the VM:** `managed-launch-picker-siblings-links` (host
  quarantine) now gates the launch folders first, so its resume target at a
  link still runs the folder check.
