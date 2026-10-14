import { useEffect, useState } from 'react'

/**
 * The window's own minimize, maximize and close buttons. The main window has
 * no frame on Windows and Linux (frame:false), so these are the only ones it
 * has there. macOS keeps its native traffic lights (titleBarStyle
 * 'hiddenInset'), so nothing is rendered on a Mac.
 *
 * Shown by the title bar, by the onboarding shell (OnboardingShell), and by
 * WindowDragStrip on the other pages that cover the whole window: those
 * pages cover the title bar too, and without their own copy a page had no
 * minimize, maximize or close button (aicc_planning #211).
 *
 * The wrapper is a no-drag region, so the buttons take clicks inside a bar
 * that drags the window. While a page covers the window, the hidden title
 * bar's copy declares no region at all (styles.css, the inert rule).
 *
 * `onClose` stands in for the plain window close on a page whose own way out
 * does more first: the setup screens pass their Exit, which stops a running
 * install command and the Claude Code setup terminal before it closes the
 * window, so Close and Exit there do the same thing.
 */
export function WindowControls({ className, onClose }: { className?: string; onClose?: () => void }) {
  if (window.electronPlatform === 'darwin') return null
  return <WindowControlButtons className={className} onClose={onClose} />
}

/** How far a page that draws WindowDragStrip keeps its content from the top
 *  of the window: the strip's 40px plus the page's own 16px gutter. Nothing
 *  on the page may sit under the strip, where a click would start a window
 *  drag instead of reaching it. */
export const WINDOW_DRAG_STRIP_CLEARANCE = 56

/**
 * The bar that stands in for the title bar on a page that covers the whole
 * window outside the onboarding shell: the first setup screens (SetupDialog),
 * the Multi Spawn page (MultiSpawnStartupPage) and App's own loading screen
 * (AppLoadingScreen). Without it those pages had no minimize, maximize or
 * close on Windows and Linux, and nothing to drag the window by
 * (aicc_planning #211, follow-up).
 *
 * 40px tall like the title bar, across the top of the page's own fixed
 * overlay, a drag region on every platform (as the onboarding shell's bar
 * is), with WindowControls at its right end (nothing on macOS, whose own
 * buttons sit at the top left). The page keeps WINDOW_DRAG_STRIP_CLEARANCE
 * clear at its top so none of its controls fall inside the strip.
 * `onClose` goes to WindowControls (above).
 */
export function WindowDragStrip({ onClose }: { onClose?: () => void } = {}) {
  return (
    <div className="titlebar-drag absolute top-0 inset-x-0 h-10 flex items-center justify-end px-3" data-testid="window-drag-strip">
      <WindowControls onClose={onClose} />
    </div>
  )
}

const BUTTON = 'p-2 rounded transition-colors text-overlay1 hover:text-text focus-ring'

function WindowControlButtons({ className, onClose }: { className?: string; onClose?: () => void }) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    window.electronAPI.window.isMaximized().then(setMaximized)
    const unsub = window.electronAPI.window.onMaximizedChanged(setMaximized)
    return unsub
  }, [])

  const maxLabel = maximized ? 'Restore window' : 'Maximize window'
  return (
    <div className={`titlebar-no-drag flex items-center gap-1.5${className ? ` ${className}` : ''}`} data-testid="window-controls">
      <button
        type="button"
        onClick={() => window.electronAPI.window.minimize()}
        className={`${BUTTON} hover:bg-surface0`}
        aria-label="Minimize window"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.2"/></svg>
      </button>
      <button
        type="button"
        onClick={() => window.electronAPI.window.maximize()}
        className={`${BUTTON} hover:bg-surface0`}
        aria-label={maxLabel}
      >
        {maximized ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="3.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none"/><path d="M3.5 3.5V2.5C3.5 2.22 3.72 2 4 2H9.5C9.78 2 10 2.22 10 2.5V8C10 8.28 9.78 8.5 9.5 8.5H9" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
        )}
      </button>
      <button
        type="button"
        onClick={onClose ?? (() => window.electronAPI.window.close())}
        className={`${BUTTON} hover:bg-red`}
        aria-label="Close window"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
      </button>
    </div>
  )
}
