## 2026-11-22 -- The helper's capture mode on Windows (dormant), and probe P21

Plan 2.1.3-beta.14, section C6 (S8 step 1, aicc_planning#391). Snap's own engine starts in the
helper (ADR-030 D3, D4, protocol change 2), measured before anything is built on it.

- **The mode** (`helper/src/capture.rs`). `aicc-helper capture --out <folder>`: aware of each
  display's scale (per-monitor DPI awareness, version 2), it checks it can see the screen (its
  window station is shown on a display, and the desktop on the screen is its own), lists the
  displays (primary first), grabs each whole display with BitBlt and writes it as a new
  `display-<n>.bmp` (32 bits a pixel, rows from the bottom), then prints one JSON line of each
  display's bounds, DPI and scale. Exit 0 written, 1 failed (it then removes what it wrote), 2 a
  command line it does not take, 3 no desktop to capture, 4 not supported (macOS and Linux). Three
  more windows-sys features (Graphics_Gdi, UI_HiDpi, System_StationsAndDesktops), no package.
  Nothing in the app runs it.
- **Probe P21** (`helper/probes/p21-capture.cjs`, `p21-windows.ps1`). The decision lines are in
  the script's header, written before the run: CAPTURES per scale when 3 of 3 console-session runs
  exit 0 within 2 s and write every display Windows lists at its size and DPI, not all black;
  FAILS CLEANLY when 3 of 3 SSH-session runs exit 3 within 10 s with a message and no file. The
  console runs start through a scheduled task in the signed-in console session (not elevated); a
  second scale is set with the display configuration call the Settings page makes. The verdict
  lines have a unit test (`tests/unit/scripts/probe-p21.test.ts`), red under three mutants (the
  black-picture check, the time bound and the SSH exit check each dropped) and under a fourth (the
  line for a console session that was not measured dropped).
- **Measured** (2026-11-22, the Windows test machine, the `helper-windows` artifact of Helper run
  45032133403). From the SSH session: FAILS CLEANLY, 3 of 3 runs exit 3 in 13 to 61 ms, no file.
  Session 0 still reports one 1024 by 768 display to EnumDisplayMonitors, so the window station
  check is what stops a run there. From the console session: CANNOT MEASURE. Nobody is signed in
  on that console: its auto sign-in is set (AutoAdminLogon 1) with no DefaultPassword value under
  the Winlogon key (an LSA secret was not read; why it did not sign in is not known), Winlogon's
  last sign-in is from 2026-10-30, and the probe's task did not start (0x00041303). The plan read
  "auto sign-in is on"; it is set, but it has signed nobody in since that date. P21 runs again from a signed-in
  console session before S8 builds on the mode. Two probe fixes from the run: the task's user is
  the token's own name (an SSH session's USERDOMAIN did not resolve), and `console` stops when
  its task has not started 15 s after it was started.
- **Docs.** Protocol section 15 gains "Capturing the displays" (change 2; its command line is not
  frozen while nothing runs it); ADR-030 gains the P21 row and result and reads twenty-one probes; the helper
  README lists the mode (and `console-hosts`, which it had left out); threat model 3.13 gains the
  mode's bullet, its adversarial pass owed before stable.
- **Review fixes.** The mode's Windows calls had made user32, gdi32 and shcore load-time imports,
  so every helper process (each holder, every `hook` run) loaded them before main; beta.13's
  helper imports none of them. `helper/.cargo/config.toml` now delay-loads the three, and
  `scripts/check-pe-imports.mjs` fails a build whose import table names one (delay-loaded passes).
  The all-or-none removal moved out of the Windows-only code into `write_all_or_none`, with unit
  tests on all three systems (a second grab that fails, a file already there), each red with the
  removal deleted. The Windows run test writes which branch it took (written, or no desktop) to
  the job log.
