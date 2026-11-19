## 2026-11-19 -- A session's "no reading" mark is cleared when readings arrive

Plan 2.1.3-beta.10, section C3 (aicc_planning #292).

- **The stale mark.** Codex telemetry sends `usageUnavailable: 'no-reading'` once, when no
  rollout is claimed within 30 s (providers/codex/telemetry.ts). The session's own hook can still
  claim the rollout after that, and readings then arrive, but the renderer copied the mark only
  when it was set and nothing cleared it before a restart (useRestartSession.ts). The session kept
  the mark beside good readings. No screen showed it: the footer counts a marked session only for
  a group with no buckets, and the strip's placeholder is off whenever readings are present.
- **The fix (renderer only).** In useStatuslineSubscription.ts an update that carries a reading
  clears the mark. A reading is what the strip's placeholder rule already reads: a non-empty
  bucket list or a current rate limit figure. A weekly figure alone, an empty bucket list or other
  fields leave the mark as it is; one update that carries both the mark and a reading leaves no
  mark. Telemetry, IPC, the shared type and the footer and strip rules are unchanged, so the
  shared type's "sent once" comment still holds.
- **Tests.** tests/unit/renderer/use-statusline-subscription.test.tsx: the mark then a late bucket
  list, the mark then a late current figure, and both in one update are cleared (all three red on
  the code before the fix, in a local run); the mark with no readings stays. The footer's
  "no reading" word (tests/unit/renderer/footer-identity-pills.test.tsx) stays green. The hook and
  its test name no provider, so the WP1 legacy-Codex gate does not move.
