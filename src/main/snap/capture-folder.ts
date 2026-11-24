/**
 * The folder one Snap press's pictures are written to (plan 2.1.3-beta.16 A1,
 * aicc_planning#401): `<parent>/press-<random>`, where the parent is a folder
 * of the app's own under its user data folder (never Windows Temp). It is
 * removed on every path of the press, and the parent with it when it is left
 * empty. A press also removes any press folder an earlier run left (an app
 * ended mid-press): only one press runs at a time (captureInProgress).
 *
 * Every removal is of a folder named press-* directly inside the parent, read
 * back from the parent itself: never a path given from outside.
 */
import fs from 'fs'
import path from 'path'

/** The parent's name under the user data folder. */
export const CAPTURE_PARENT = 'snap-capture'
const PREFIX = 'press-'

/** True when `folder` is a press folder directly inside `parent`. */
export function isPressFolder(parent: string, folder: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(folder))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !/[\\/]/.test(rel) && rel.startsWith(PREFIX)
}

/** Make a new, empty press folder in `parent` (made if missing), after
 *  removing any press folder an earlier run left there. */
export function makePressFolder(parent: string): string {
  fs.mkdirSync(parent, { recursive: true })
  for (const name of fs.readdirSync(parent)) {
    const left = path.join(parent, name)
    if (isPressFolder(parent, left)) fs.rmSync(left, { recursive: true, force: true })
  }
  return fs.mkdtempSync(path.join(parent, PREFIX))
}

/** Remove a press folder and, when that leaves the parent empty, the parent.
 *  Anything that is not a press folder in `parent` is left alone. Never throws. */
export function removePressFolder(parent: string, folder: string): void {
  try {
    if (!isPressFolder(parent, folder)) return
    fs.rmSync(folder, { recursive: true, force: true })
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent)
  } catch { /* best effort: the next press removes what is left */ }
}
