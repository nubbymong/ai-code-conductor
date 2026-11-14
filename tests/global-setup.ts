// Vitest global setup and teardown (#559): runs once in the main process, before
// and after the whole run. Setup gives the run a tag (tests/helpers/vitest-run-tag.mjs)
// that the workers put in the name of their temp folders. The teardown is a backstop
// that removes the per-worker `ccc-vitest-<tag>-*` temp roots THIS run's killed
// worker left behind, and never another run's, plus a stray drive-root `\mock` from
// any hardcoded mock path, so a test run never leaves litter on the drive.
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { RUN_TAG_ENV, newRunTag, removeRunTempFolders } from './helpers/vitest-run-tag.mjs'

export default function () {
  // Before any worker starts, so the workers inherit it.
  const tag = newRunTag()
  process.env[RUN_TAG_ENV] = tag
  return () => {
    removeRunTempFolders(os.tmpdir(), tag)
    // A drive-relative `/mock` resolves onto whichever drive is current, so a
    // suite run from C: scattered to C:\mock and one from F: to F:\mock. Sweep
    // the roots that can be hit: the cwd drive, the temp drive, and C:.
    const drives = new Set(
      [process.cwd(), os.tmpdir(), 'C:\\'].map((p) => path.parse(path.resolve(p)).root),
    )
    for (const root of drives) {
      try {
        const mock = path.join(root, 'mock')
        if (fs.existsSync(mock)) fs.rmSync(mock, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}
