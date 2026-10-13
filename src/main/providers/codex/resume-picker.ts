/**
 * Deploy `scripts/codex-resume-picker.js` plus its helper lib into
 * `<resourcesDir>/scripts/`. Mirrors `deployClaudeResumePickerScript`.
 *
 * electron-vite bundles all `src/main/**\/*.ts` into a single `out/main/index.js`,
 * so `__dirname` at runtime is always `out/main/` regardless of original source
 * location. The default `path.join(__dirname, '../../scripts/...')` hops two
 * directories up from `out/main/` to the build root (sibling of `out/`), then
 * into `scripts/` -- where electron-builder copies the picker scripts via
 * `package.json` `build.files`. In dev (vitest) `__dirname` resolves to the
 * source file's directory, so the same join lands at
 * `<repo>/src/main/scripts/` -- which is empty in the source tree (the
 * pickers actually live at `<repo>/scripts/`), so an unredirected dev call
 * silently no-ops via the `existsSync` guard. Tests inject `sourceRoot` to
 * point at a per-test temp dir instead.
 */
import * as fs from 'fs'
import * as path from 'path'
import { deployScriptFile, prepareScriptFolder } from '../../script-deploy'

/**
 * @param resourcesDir Destination resources directory.
 * @param sourceRoot   Optional override for the source-script lookup root. The
 *   default uses the `__dirname`-relative path described in the file header.
 *   Tests inject a per-test temp dir to avoid races on the shared
 *   `<repo>/src/main/scripts/` path under vitest's parallel file runner.
 */
export async function deployCodexResumePickerScript(resourcesDir: string, sourceRoot?: string): Promise<void> {
  const resourcesScriptsDir = path.join(resourcesDir, 'scripts')
  if (!fs.existsSync(resourcesScriptsDir)) {
    fs.mkdirSync(resourcesScriptsDir, { recursive: true, mode: 0o700 })
  }
  // The lib is written only into a real scripts/lib folder: prepareScriptFolder
  // keeps a real folder there, replaces anything else it may remove (a link
  // as a link, never what it names; an empty directory) with a real folder,
  // and throws otherwise. A launch takes the picker only when that folder is
  // a real folder by the same rule (isRealScriptFolder, in
  // getCodexResumePickerPath).
  const resourcesLibDir = path.join(resourcesScriptsDir, 'lib')
  prepareScriptFolder(resourcesLibDir)

  const pickerSrc = sourceRoot
    ? path.join(sourceRoot, 'scripts/codex-resume-picker.js')
    : path.join(__dirname, '../../scripts/codex-resume-picker.js')
  const libSrc = sourceRoot
    ? path.join(sourceRoot, 'scripts/lib/codex-resume-picker-lib.js')
    : path.join(__dirname, '../../scripts/lib/codex-resume-picker-lib.js')

  // F14: read and compared, written only when changed; never copyFileSync,
  // which leaves a temporary file behind for a source inside app.asar.
  deployScriptFile(pickerSrc, path.join(resourcesScriptsDir, 'codex-resume-picker.js'))
  deployScriptFile(libSrc, path.join(resourcesLibDir, 'codex-resume-picker-lib.js'))
}
