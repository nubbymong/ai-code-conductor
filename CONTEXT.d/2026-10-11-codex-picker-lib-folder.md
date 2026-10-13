## 2026-10-11 -- the Codex picker's helper lib folder is a real folder (2.1.1-beta.3)

- **Codex resume picker launch:** the picker loads its helper lib from the
  resources folder's `scripts/lib`. A launch takes the picker only when that
  folder, where it is there, is a real folder, as well as the picker and the
  lib being plain files with one name. A real folder (`isRealScriptFolder` in
  `script-deploy.ts`) is a directory that is not a link when read without
  following one, and whose resolved path (`fs.realpathSync.native`) is its
  own name in its parent's resolved path (without case on Windows and macOS);
  a path that cannot be resolved is not one. Anything else at `scripts/lib`
  is logged ("the scripts/lib folder in the resources folder is not a real
  folder") and Codex starts directly, as when the picker is not deployed. No
  folder there at all is the not-deployed-yet case, as before.
- **Codex resume picker deploy:** before it writes the lib, the deploy makes
  `scripts/lib` a real folder by the same rule (`prepareScriptFolder`). A
  real folder is kept with what it holds. Otherwise what is there is removed
  by the rule a script's destination is cleared by (a link as a link, never
  what it names, with a directory removal on Windows when unlink is refused;
  a directory only when empty; never recursive), a real folder is made
  without making any folder above it, and that folder is checked again. A
  file there is left, and the deploy fails, as it does when the folder made
  is not a real one; a failure is logged by the folder's name and the error
  code.
- **Claude Code resume picker:** `scripts/resume-picker.js` loads nothing
  from a sub-folder (Node built-ins only), so it has no folder to check.
- **Docs only:** the canvas marker wiring's not-delivered callback now states
  its one exception: a Claude Code marker whose type request was already sent
  when its session's markers were cleared is told at the clear and may still
  be typed.
- **Owed on CI or the VM:** `resume-picker-lib-links` (host quarantine): a
  real junction or directory link at `scripts/lib`, refused at a launch and
  replaced by the deploy, a link whose folder is gone, and on Windows a
  junction that names its folder by volume (made with `mklink /J`).
