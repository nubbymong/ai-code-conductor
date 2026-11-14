// Vitest global setup and teardown (#559): runs once in the main process, before
// and after the whole run. Setup gives the run a tag (tests/helpers/vitest-run-tag.mjs)
// that the workers put in the name of their temp folders. The teardown is a backstop
// that removes the per-worker `ccc-vitest-<tag>-*` temp roots THIS run's killed
// worker left behind, and never another run's; any `ccc-vitest-*` folder that has not
// been touched for 24 hours (a killed run's litter, so it cannot pile up); and a stray
// drive-root `\mock` from any hardcoded mock path, so a test run never leaves litter
// on the drive.
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import {
  RUN_TAG_ENV,
  newRunTag,
  removeRunTempFolders,
  removeStaleTempFolders,
} from './helpers/vitest-run-tag.mjs'

/**
 * The folders a stray `/mock` can land in. A drive-relative `/mock` resolves onto
 * whichever drive is current, so a suite run from C: scattered to C:\mock and one from
 * F: to F:\mock. Sweep the roots that can be hit: the cwd drive, the temp drive, and C:.
 */
function mockRoots(): string[] {
  return [
    ...new Set([process.cwd(), os.tmpdir(), 'C:\\'].map((p) => path.parse(path.resolve(p)).root)),
  ]
}

/**
 * What the teardown does once a run is over. A named export, not `setup` or `teardown`
 * (vitest reads those names), so a test can run it on a scratch folder.
 * @param tag this run's tag
 * @param tmp the folder that holds the `ccc-vitest-*` folders
 * @param roots the folders that may hold a stray `mock`
 */
export function sweepAfterRun(
  tag: string,
  tmp: string = os.tmpdir(),
  roots: string[] = mockRoots(),
): void {
  removeRunTempFolders(tmp, tag)
  removeStaleTempFolders(tmp)
  for (const root of roots) {
    try {
      const mock = path.join(root, 'mock')
      if (fs.existsSync(mock)) fs.rmSync(mock, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

export default function () {
  // Before any worker starts, so the workers inherit it.
  const tag = newRunTag()
  process.env[RUN_TAG_ENV] = tag
  return () => sweepAfterRun(tag)
}
