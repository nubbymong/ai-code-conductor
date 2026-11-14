// Vitest global setup and teardown (#559): runs once in the main process, before
// and after the whole run. Setup gives the run a tag (tests/helpers/vitest-run-tag.mjs)
// that the workers put in the name of their temp folders, and records this process as
// the run's owner. The teardown is a backstop that removes the per-worker
// `ccc-vitest-<tag>-*` temp roots THIS run's killed worker left behind, and never
// another run's; its own owner record; any `ccc-vitest-*` folder that has not been
// touched for 24 hours AND whose run's owner is gone (a killed run's litter, so it
// cannot pile up, while a long watch run's folders stay); and a stray drive-root
// `\mock` from any hardcoded mock path, so a test run never leaves litter on the drive.
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import {
  RUN_TAG_ENV,
  isOwnerAlive,
  newRunTag,
  removeRunOwner,
  removeRunTempFolders,
  removeStaleTempFolders,
  writeRunOwner,
  type RunOwner,
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
 * @param isAlive whether another run's owner is still there; a test fakes it
 */
export function sweepAfterRun(
  tag: string,
  tmp: string = os.tmpdir(),
  roots: string[] = mockRoots(),
  isAlive: (owner: RunOwner) => boolean = isOwnerAlive,
): void {
  removeRunTempFolders(tmp, tag)
  removeRunOwner(tmp, tag)
  removeStaleTempFolders(tmp, undefined, undefined, isAlive)
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
  // This process is the run's owner: another run's teardown keeps this run's folders
  // for as long as it is alive, however old they are (a watch run can last for days).
  writeRunOwner(os.tmpdir(), tag)
  return () => sweepAfterRun(tag)
}
