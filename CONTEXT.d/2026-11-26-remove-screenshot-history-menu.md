## 2026-11-26 -- The screenshot history menu nobody could open is removed

Plan 2.1.3-beta.19, section 5 (aicc_planning#435). Base: origin/beta at cc36c7f3.

- **Why.** `ScreenshotContextMenu` (a list of recent screenshots with "Insert Selected") was
  rendered nowhere, so no user could reach it. It was the only caller of
  `sendStoryboardToSession` and of the `screenshot:listRecent` chain. The Storyboard feature
  itself was removed in 1.4 (`d7c190ea`); beta.18 then edited the menu and its test as if it
  were live.
- **Decision.** Remove, not wire back (the plan's, 26 Nov). No changelog line: no user could
  reach the menu.
- **What went.** The component, its test, `sendStoryboardToSession`, `screenshotPath.ts` (its
  one use was the menu's "5m ago" label), and the whole `screenshot:listRecent` chain: the
  channel constant, the handler, `listRecentScreenshots` (main), the preload bridge and its
  type. One more `git grep` found no other caller before each was deleted.
- **Words changed.** The `fetch_host_screenshot` tool description (what a model reads), the
  Conductor MCP page's Host transfer card (what a user reads) and four comments now name Snap
  and image paste only. `tests/unit/remote-helper/session.test.ts` keeps the app's own image
  request and drops the storyboard line.
- **Held by a test.** `tests/unit/renderer/screenshot-menu-removed.test.ts` reads `src` as text:
  no "storyboard" in code, strings or JSX text (comments and `changelog.ts` history aside), no
  trace of the list-recent chain, the menu and its helper gone.
- **Not done, named.** Three more renderer components have no importer: `DebugPanel.tsx`,
  `github/sections/AgentIntentSection.tsx` and `logs/ChatTranscript.tsx`; a fourth,
  `SessionDialog/ProviderSegmentedControl.tsx`, is rendered only by its test. They are not this
  ticket's chain and are left for the orchestrator to place.
