/**
 * Which Snap takes the picture (ADR-030 S8 steps 2 and 3; plan 2.1.3-beta.16
 * A1, aicc_planning#401). On Windows the user chooses in Settings, Custom
 * Commands, Snap: 'new' (the default) is the session helper's capture mode
 * with the app's own overlay; 'previous' is the electron-screenshots package.
 * macOS and Linux always use the previous one: the capture mode exits 4 there.
 *
 * The choice is saved only when the user makes it (magic-buttons.json,
 * `snapEngineWindows`); no saved choice means the default, so a later default
 * reaches everyone who never chose, and a saved choice is kept. Main reads it
 * at each press; the renderer shows it.
 */
export type SnapEngine = 'new' | 'previous'

/** The engine a Windows press uses when nothing is saved: the new one (S8
 *  step 3). The previous one is a setting away, and takes any press the new
 *  one cannot do (screenshot-capture.ts captureRectangle). */
export const SNAP_ENGINE_DEFAULT_WINDOWS: SnapEngine = 'new'

/** The saved choice, when it is one; anything else reads as none. */
export function savedSnapEngine(saved: unknown): SnapEngine | null {
  return saved === 'new' || saved === 'previous' ? saved : null
}

/** The engine a press on `platform` uses, given what is saved. */
export function snapEngineFor(platform: string, saved: unknown): SnapEngine {
  if (platform !== 'win32') return 'previous'
  return savedSnapEngine(saved) ?? SNAP_ENGINE_DEFAULT_WINDOWS
}
