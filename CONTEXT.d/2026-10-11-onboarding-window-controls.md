## 2026-10-11 -- onboarding pages get the window controls and a drag bar (aicc_planning #211, 2.1.1-beta.3)

- **Problem:** the pages drawn in the onboarding shell (the onboarding pages
  after the first setup screens, the release notes, and the one-time pages
  shown in it after an upgrade) cover the whole window, title bar included.
  The main window has no frame on Windows and Linux, so those pages covered
  the window's own minimize, maximize and close and had none of their own.
  The first setup screens (choose the app's folders, install and set up
  Claude Code) are a separate dialog with Exit only; this change does not
  touch them.
- **Fix:** the title bar's three window buttons moved into
  `components/WindowControls.tsx` (nothing on macOS, which keeps its native
  traffic lights). `OnboardingShell` renders it at the right end of its top
  bar, and that bar now carries the app's `titlebar-drag` class (the buttons
  sit in a `titlebar-no-drag` group), so every page in the shell can be moved,
  minimized, maximized and closed. The buttons gained accessible names
  (Minimize window, Maximize or Restore window, Close window), which the title
  bar gets too. `onboarding.css` is not touched.
- **Regions behind the page:** the covering pages come before the app in the
  DOM, and the app behind them (title bar, sidebar, sessions, bottom bar) is
  still laid out under them. If Electron folds drag regions in DOM order, the
  hidden title bar's drag strip (the top 40px) would land on the middle of the
  page's window buttons and the hidden panels would cut the lower half out of
  the page's drag bar. So while the app is inert (App's `appCovered`),
  `styles.css` gives its `titlebar-drag` and `titlebar-no-drag` elements no
  region at all (`[inert] ...`, value `initial`), and the page's bar and
  buttons stand alone in any fold order. The window-controls test applies the
  stylesheet's own region rules to the rendered page and the real title bar,
  and pins that every renderer region goes through those two classes.
- **Focus:** the buttons are the first tab stops inside the shell's focus
  trap (they come first in the bar, before the page), so Tab from a page's
  last control now goes round to Minimize rather than to the page's first
  control. The focus-trap tests say so.
- **Close during onboarding:** checked, no wait on a hidden dialog. With no
  session open the close goes straight through (`closeWithNoSessions`); with
  one open, the close dialog is on the top layer (`WINDOW_CLOSE_Z`, z 200),
  above `.ob-root` (z 100), as window-close-dialogs.test.tsx pins.
- **Owed on the VM (jsdom has no app regions):** on Windows, on an onboarding
  page, the release notes page, the one-time question shown after an upgrade
  and the introduction takeover: a single click at the exact centre (about
  36px from the top of the window) and in the lower half of each of Minimize,
  Maximize and Close must act; a double-click at the centre of Minimize must
  minimize, never maximize or restore the window; dragging the empty middle of
  the bar, both near the top (about y 10) and in its lower half (about y 45 to
  65), must move the window. After the page is gone, the main title bar must
  still drag and its buttons still click.
