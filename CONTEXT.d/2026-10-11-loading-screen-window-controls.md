## 2026-10-11 -- App's own Loading screen gets the window controls too (aicc_planning #211 follow-up 2, 2.1.1-beta.3)

- **Problem:** App's own "Loading..." early return (shown while it checks the
  setup state and loads the config) replaces the whole app, title bar
  included, and had no minimize, maximize or close on Windows and Linux and
  nothing to drag the window by. The takeover-window-controls change left it
  out: it changed only the appCovered line of App.tsx.
- **Fix:** the early return now renders `AppLoadingScreen`
  (`components/AppLoadingScreen.tsx`): the same markup as before plus the
  `WindowDragStrip` the setup screens and the Multi Spawn page draw (no
  buttons on macOS), `relative` so the strip sits across the top of the
  screen, and `WINDOW_DRAG_STRIP_CLEARANCE` kept clear at the top. Close is
  the plain window close: nothing runs yet, and the zero-session close leaves
  the saved session file untouched while the restore is unsettled. The App
  change is the import line and the early return only, away from the partner
  strip hunk.
- **Supersedes** the last sentence of the takeover-window-controls fragment's
  Supersedes item ("App's own brief Loading... screen ... is not covered"):
  it is now covered. All three of App's early returns (this screen and the
  two SetupDialog returns) now draw the bar; the overlays inside App's main
  return were the earlier changes' scope and are not re-checked here.
- **Known gap, not fixed here:** the crash page. `ErrorBoundary`
  (`components/ErrorBoundary.tsx`) wraps App's whole main return, title bar
  included, and on a renderer crash draws a full-window "Something went
  wrong" page with no minimize, maximize or close on Windows and Linux and
  nothing to drag. It is the one known full-window page still without the
  bar; raised for a disposition (a follow-up change or a ticket).
- **Tests:** `app-loading-window-controls.test.tsx` renders the screen (the
  buttons on Windows and Linux wired to the window, none on macOS, the bar a
  drag region with a no-drag group and the text below it, the only regions
  declared) and reads App's early return.
- **Owed on the VM (jsdom has no app regions):** the Loading screen is on for
  a moment only; if it can be held (a slow resources folder), Minimize,
  Maximize and Close respond and dragging the empty bar moves the window.
