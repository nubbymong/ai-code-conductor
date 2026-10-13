import { WindowDragStrip, WINDOW_DRAG_STRIP_CLEARANCE } from './WindowControls'

/**
 * App's own "Loading..." screen, shown while it checks the setup state and
 * loads the config. It replaces the whole app, title bar included, and the
 * main window has no frame on Windows and Linux, so it draws the bar the
 * setup screens and the Multi Spawn page draw (WindowDragStrip): minimize,
 * maximize and close there, nothing on macOS (its own buttons stay at the
 * top left), and a bar to drag the window by on every platform. Before, this
 * screen had none of them. Nothing runs yet, so Close is the plain window
 * close. The screen keeps the strip's height clear at its top.
 */
export function AppLoadingScreen() {
  return (
    <div
      className="relative flex flex-col h-screen bg-base text-text items-center justify-center"
      style={{ paddingTop: WINDOW_DRAG_STRIP_CLEARANCE }}
      data-testid="app-loading"
    >
      <WindowDragStrip />
      <div className="text-overlay1">Loading...</div>
    </div>
  )
}
