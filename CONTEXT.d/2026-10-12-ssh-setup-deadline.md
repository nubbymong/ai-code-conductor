## 2026-10-12 -- the SSH setup deadline counts from the host's last output

- **What failed:** the live SSH matrix on the 2.1.1-beta.3 candidate failed T6
  (macOS host, zsh login shell) twice in the same way. The host setup is one
  line typed into the login shell, and in this release it grew from about
  20 KB to about 34 KB (the remote attention hook, on by default, is about
  11 KB of it). zsh's line editor echoes a typed line back before it runs it,
  and its cost grows faster than the line: measured on the Mac at 120 columns,
  19.5 KB took 6.2 s, 22.9 KB 8.5 s and 34.2 KB 18.0 s. `setup ok` came 19.2
  to 19.3 s after the setup started, past the fixed 10 s deadline, so the session
  stopped at "host setup timeout" before Claude started. Bash hosts take
  about 1.1 s. This never shipped: the line grew in this release. (The setup ok
  times run from the start of the setup, which is when the deadline is armed and
  the "writing host setupCmd" line is logged: 200 ms before the host line is
  typed, 300 ms before the container one.)
- **The fix (pty-manager.ts, armSetupDeadline):** the setup-ok deadline, for
  the host setup and the container setup alike, now runs 10 s from the LAST
  output that came back instead of from the start of the setup, capped at
  60 s after the setup started. The echo is continuous (the longest pause
  between chunks on the Mac was 67 ms), so a host still taking the line is
  never failed, a host that goes quiet fails 10 s after its last byte, a host
  that sends nothing back fails at 10 s exactly as before, and one that never
  stops sending fails at the cap. The wait reads the monotonic clock. What
  the setup does on the host is unchanged.
- **A host that sends nothing:** a timer can fire a fraction of a
  millisecond before performance.now() shows its full delay (timers run on a
  whole-millisecond loop clock), so a check that only compared times could
  log such a host as one still sending and re-arm for that sliver. The
  deadline remembers whether any output came back at all: with none it fails at its first check, and the log says so ("within
  10000ms of the setup starting (nothing came back)"). The wait line and the
  cap reason say "after the setup started" instead of "after the
  write", which is when the deadline is actually armed.
- **Rejected, with the Mac's numbers:** sending `stty -echo` first on its own
  line (the line editor still echoed and processed the whole line: 17.7 s),
  and shrinking the line by not inlining the attention hook (still 8.5 s,
  under 2 s from the limit, and it changes the setup).
- **Possible follow-up, not built:** zsh announces bracketed paste, and the
  same 34 KB line sent as a bracketed paste was taken in 0.7 s. Typing the
  setup that way, only when the shell has turned bracketed paste on, would
  remove the delay itself, but it changes how every host receives the setup
  and needs its own live matrix, so it is left for a later release.
- **Verified:** unit tests in the host and container SSH flow suites (red
  against the fixed deadline, four mutants red; the silent-host cases pin
  every failure reason in the log) and the live matrix at the fix
  (the macOS T6 now passes, setup ok at 19.8 s; the Linux, Raspberry Pi,
  RHEL, podman container, Windows remote and both multi-session runs pass
  too, 23 of 23). After the silent-host change the six statusline runs
  were run again: 21 of 21 pass, the Mac setup ok came at 19.2 s, and the
  Mac was the only session that logged the wait line.
