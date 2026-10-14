## 2026-10-11 -- Windows installer and uninstaller branded from the splash (O4, #180)

The owner asked for the installer itself to be uplifted, with the splash's
motion on every step where it makes sense. The wizard was electron-builder's
stock look: no Welcome page, NSIS's own side panel, no header image and blank
titles on the Data and Resources folder pages. In-app updates start the
installer with no arguments, so this wizard ran on every update too.

Decided for the owner (to be reviewed on the Agent Canvas): a dark restyle
(whole page on Welcome, Finish and the two folder pages, a dark header band on
every other page) plus light motion that needs no new plugin, plus a short
fade splash on fresh installs only. Windows only for 2.1.1; no DMG background.

- Page 1 is a new Welcome page naming the version; the folder pages stay
  pages 2 and 3 (moving them behind the install-mode page would write HKCU in
  the elevated account only). The elevated inner instance skips Welcome and
  starts at the Data folder page, as before. That page is no longer page 1
  there, so NSIS compiles a live Back button onto it, and Back walked the
  wizard off its front edge: Setup ended with nothing installed and without
  .onUserAbort, so a suspended uninstall record stayed suspended. The page
  now hides and disables Back in the inner instance (found in review).
- MUI_BGCOLOR 0B0E15 / MUI_TEXTCOLOR F4F7FA in both compile passes: dark
  header band on every inner page, dark Welcome and Finish pages in both
  wizards. The folder pages are dark through SetCtlColors. The template's own
  pages (install mode, location, Installing) keep the system body.
  MUI_FORCECLASSICCONTROLS (stock MUI) keeps the Finish "Run" label readable.
- Motion: an nsDialogs timer swaps 7 frames and settles on the static art,
  on the installer's Welcome side panel and on an emblem on each folder
  page. Never on the Installing page, and not on the uninstaller's Welcome
  page, which is static (motion there would need un.-prefixed copies of the
  timer functions). No EmbedHTML, no third-party plugin.
- Splash: AdvSplash (pinned NSIS bundle) fades the lockup in for 1.6 s from
  .onGUIInit, so never under /S, never in the inner instance, and only when no
  data folder is recorded and no app exe sits where the previous install's
  record points. That last pair is how an in-app update is recognised.
- The art is generated from the splash's brand SVG by
  scripts/gen-installer-art.mjs (pure Node) and committed as 24-bit BMPs.
- Open for the owner's Canvas review: the Welcome page also shows on every
  in-app update (the updater runs this wizard with no arguments), so each
  update gains one Next click. That follows the review's recommendation; the
  alternative is to skip Welcome when an install already exists.

makensis cannot run on the owner's machine, so the real -WX compile of both
passes, a fresh install, a silent /S install, upgrades from 2.1.0 stable and
from 2.1.1-beta.2 (in-app and by double-click), an uninstall and the page
captures at 100% and 150% are owed on the VM. The guard test models the
two passes statically and was proved against 18 mutations, with one control
(a legitimate System::Call) that stays green, plus 5 more for the folder
pages' emblem (its colours, centring, bitmap style and strip). The installer.nsh
delta adds timer, splash and System-backed image code to an installer that
can elevate, so the ADR-009 security review covers it. Not in scope:
the Store MSIX still ships electron-builder's sample logos (no build/appx/).
