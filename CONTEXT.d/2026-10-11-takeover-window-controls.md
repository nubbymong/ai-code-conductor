## 2026-10-11 -- the first setup screens and the Multi Spawn page get the window controls too (aicc_planning #211 follow-up, 2.1.1-beta.3)

- **Problem:** two more pages cover the whole window outside the onboarding
  shell, so the onboarding-window-controls change did not reach them. The
  first setup screens (SetupDialog: loading, choose the app's folders, not
  installed, installing, Claude Code setup) are drawn while App draws no
  title bar, and had Exit only on Windows and Linux. The Multi Spawn page
  (MultiSpawnStartupPage, shown once after an upgrade) is an opaque overlay
  over the title bar, and its boot gate was not in App's `appCovered`, so
  the hidden title bar's drag strip and buttons stayed live under it.
- **Fix:** `WindowDragStrip` in `components/WindowControls.tsx`: a 40px bar
  across the top of the page's own fixed overlay, `titlebar-drag` on every
  platform (as the onboarding shell's bar is), with `WindowControls` at its
  right end (nothing on macOS). Both pages draw it, every setup screen
  included, and keep `WINDOW_DRAG_STRIP_CLEARANCE` (56px) clear at the top so
  none of their own controls sit inside the drag region. App's `appCovered`
  now names `multiSpawnIntro`, so the app behind the page is inert and its
  regions are neutralised by the existing `[inert]` rule in styles.css.
  SetupDialog needs no gate: App returns early there and nothing is behind it.
  On the setup screens the bar's Close runs Exit (`WindowDragStrip onClose`):
  it stops a running install command and the Claude Code setup terminal,
  which lives in main outside pty-manager (`setup-handlers.ts`), before it
  closes the window, so the two ways out agree.
- **Supersedes** the scope sentence of 2026-10-11-onboarding-window-controls
  ("the first setup screens ... Exit only; this change does not touch
  them"): after this change they have the bar and the window buttons, and
  Exit stays. App's own brief "Loading..." screen before setup is decided is
  not covered (it has no controls at all and is gone once config loads).
- **Tests:** `setup-window-controls.test.tsx` (every setup screen) and
  `multi-spawn-window-controls.test.tsx` (the page, its regions over an inert
  app, the App wiring). The region emulation moved, unchanged, from
  `onboarding-shell-window-controls.test.tsx` to `tests/unit/renderer/drag-regions.ts`.
- **Owed on the VM (jsdom has no app regions):** the same live checks as the
  onboarding pages, on a setup screen (folders and installing) and on the
  Multi Spawn page: each of Minimize, Maximize and Close acts on a click at its
  centre and in its lower half; a double-click on Minimize minimizes; dragging
  the empty bar moves the window; the page's own buttons just below the bar
  take clicks; Close on the Claude Code setup screen quits with no setup
  terminal process left behind.
