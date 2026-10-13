# Rollback: the installed app keeps Claude usable (WP1.31)

This file is the evidence WP1.31 ("Rollback to the pre-WP1 beta preserves existing Claude account usability") cites in
`tests/wp1/traceability.json`. Its automated half is `tests/wp1/rollback-reupgrade.test.ts`, which runs in CI at the
head below (`ci-matrix.md`). This file records the same thing on installed builds.

Every check here is taken at d1525759a7a42d941beeff601af3415fddd8afdd, the squash merge of PR #644 on beta and the commit
`release/v2.1.1` points at (tree `12310fe71f3706f624e3905f8b92f06f099cdc3f`), on its qualification build `v2.1.1-beta`
(release run 38409628911), installed from its signed installer, never through the in-app updater (the updater ranks
this build below 2.1.1-beta.3, so it never offers it to a beta-channel install).

**Status: not recorded yet.** WP1.31 stays `planned` until the Windows chain below is recorded. The rollback rehearsal
of a release on GitHub is a different check; it is a known limitation in `release-qualification.md` section 3.

> **PENDING: the install chain on the Windows test VM.** In its standard test account, with Claude profiles seeded by
> file (stand-in credentials) and hashed: 2.1.1-beta.2, then the qualification build, then 2.1.1-beta.1, then 2.1.0,
> then the qualification build again, each installed over the last by its own signed installer. At each step: the app
> launches, every Claude profile starts and reads signed in, the seeded files hash the same, and there is exactly one
> uninstall entry. Being run by the packaged-build lane; not recorded yet.

> **PENDING: the rollback legs on macOS and Linux (support, not WP1.31's record).** On the macOS test user and on the
> Linux test host: 2.1.0, then the qualification build over it, then 2.1.0 again, with the setup still there and the
> app's data folder hashed after each step (`packaged-smoke.md`). Not run yet.
