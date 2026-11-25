## 2026-11-25 -- helper: macOS read missed the bridge's half-close

The intermittent `Helper (macos-latest)` failure of
`bridge.rs::the_bytes_pass_both_ways_exactly_as_they_came` (exit 1 after the
bridge's 5 s half-close wait) was traced on macOS CI with timestamps on both
sides. The bridge ended its half (`shutdown(SHUT_WR)`, rc 0) just as the
stand-in holder took its last bytes and read again; that read slept on for
5 s while poll on the same socket reported POLLIN|POLLHUP and a peek read the
end. No runner stall (heartbeat gaps under 85 ms). macOS loses the wakeup of
that read; Linux does not (0 of 20000 in-process races, 0 of 6000 bridge
rounds, all on the unchanged read).

Fix: `transport::unix::Stream::read` on macOS waits in poll
(`wait_readable`), re-asking the socket at least every second, then reads.
Measured: old read 10 of 2000 bridge rounds failed; poll wait 0 of 3000, the
end seen within 265 microseconds each time. The real holder reads its
connection through the same `Stream::read`, so a holder on a Mac reached
through the bridge no longer misses the app letting go. New test
`the_holder_sees_the_end_of_standard_input_however_it_races_the_last_bytes`
(1000 rounds) is red on macOS without the fix. Linux code paths unchanged.
