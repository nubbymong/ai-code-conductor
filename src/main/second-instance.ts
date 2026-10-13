/**
 * second-instance.ts - what a second launch of the app does while it runs.
 *
 * The packaged app holds the single-instance lock, so launching it again
 * (a shortcut, the Start menu, a file) reaches the running app's
 * `second-instance` event instead of starting a second copy. The running app
 * then brings its main window forward.
 *
 * The main window can already be gone at that moment, and the `mainWindow`
 * reference is kept (index.ts does not clear it). On Windows and Linux that
 * is while a sign-in window still finishes or the quit's teardown runs; on
 * macOS the app stays resident with no window, and the Dock reopen
 * ('activate') makes a new one. Asking a destroyed window whether it is
 * minimized throws ("Object has been destroyed") in the main process, so such
 * a launch now does nothing but log one line. It never makes a new window
 * itself.
 *
 * No default export (project convention).
 */

import { logInfo } from './debug-logger'

/** The part of the main window a second launch uses. */
export interface FocusableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  focus(): void
}

/** Bring the running app's main window forward for a second launch: restore
 *  it if minimized, then focus it. No window, or a destroyed one: one log
 *  line, and nothing is asked of the window. Never throws for a gone window. */
export function focusExistingWindow(win: FocusableWindow | null | undefined): void {
  if (!win || win.isDestroyed()) {
    logInfo('[main] the app was launched again while its window is closed or closing: nothing to bring forward')
    return
  }
  if (win.isMinimized()) win.restore()
  win.focus()
}
