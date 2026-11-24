import React, { useState, useRef, useEffect } from 'react'
import { useMagicButtonStore } from '../stores/magicButtonStore'
import WindowPickerModal from './WindowPickerModal'
import { ReservedLabel } from './command-bar/chips'
import { sendImageToSession } from '../utils/imageTransfer'

interface Props {
  sessionId: string
  // How the picture reaches the session (imageTransfer.ts sendImageToSession):
  // on this computer main pastes its path into Claude Code or Codex as the
  // CLI's own paste (a Codex session main cannot paste into gets the line by
  // the Codex typing rule); over SSH the session is asked to fetch it with the
  // Conductor MCP server's fetch_host_screenshot tool.
  sessionType: 'local' | 'ssh'
}

/** Resolves once the page has made two frames: the first animation frame runs
 *  before the frame that draws what was just changed, the second once that
 *  frame is made. A page that is hidden, or hides meanwhile, makes no frames
 *  and shows nothing, so it resolves then. Snap asks for its capture only
 *  after this, so the menu it just closed is off the screen before the picture
 *  is taken (aicc_planning#406). */
function afterTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      document.removeEventListener('visibilitychange', onHidden)
      resolve()
    }
    const onHidden = () => { if (document.visibilityState === 'hidden') finish() }
    if (document.visibilityState === 'hidden') return finish()
    document.addEventListener('visibilitychange', onHidden)
    requestAnimationFrame(() => requestAnimationFrame(finish))
  })
}

export default function ScreenshotButton({ sessionId, sessionType }: Props) {
  const color = useMagicButtonStore((s) => s.settings.screenshotColor)
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<{ left: number; bottom: number } | null>(null)
  const [showWindowPicker, setShowWindowPicker] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showDropdown])

  const toggleDropdown = () => {
    if (!showDropdown && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setDropdownPos({ left: rect.left, bottom: window.innerHeight - rect.top + 4 })
    }
    setShowDropdown(!showDropdown)
  }

  const handleRectangle = async () => {
    setShowDropdown(false)
    setCapturing(true)
    try {
      // The new Snap pictures the screen as soon as it is asked: the menu's
      // close is drawn first, or the menu can be in the picture.
      await afterTwoFrames()
      const path = await window.electronAPI.screenshot.captureRectangle()
      if (path) {
        sendImageToSession(sessionId, path, 'I just snapped a region of my screen — please view it.', sessionType)
      }
    } finally {
      setCapturing(false)
    }
  }

  const handleWindowCapture = async (sourceId: string) => {
    setShowWindowPicker(false)
    setCapturing(true)
    try {
      const path = await window.electronAPI.screenshot.captureWindow(sourceId)
      if (path) {
        sendImageToSession(sessionId, path, 'I just captured a window from my screen — please view it.', sessionType)
      }
    } finally {
      setCapturing(false)
    }
  }

  // Right-click is the command bar's: Snap is a Core tool and gets the shared
  // Core menu (Screenshot settings… → Settings → Custom Commands, Hide this
  // tool). Its colour / auto-delete live on that Settings page now (ADR-018 M4).
  return (
    <>
      <div className="relative">
        <button
          ref={buttonRef}
          onClick={toggleDropdown}
          disabled={capturing}
          className="flex items-center gap-1.5 px-2 h-7 text-xs rounded bg-surface0/60 border border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          title="Take a screenshot and send it to the agent"
          data-testid="snap-button"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="5" height="5" rx="0.5" />
            <rect x="9" y="2" width="5" height="5" rx="0.5" />
            <rect x="2" y="9" width="5" height="5" rx="0.5" />
            <rect x="9" y="9" width="5" height="5" rx="0.5" />
          </svg>
          <ReservedLabel current={capturing ? '...' : 'Snap'} />
        </button>

        {showDropdown && dropdownPos && (
          <div
            ref={dropdownRef}
            className="fixed rounded shadow-lg py-1 min-w-[160px] z-50"
            style={{ left: dropdownPos.left, bottom: dropdownPos.bottom, background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
          >
            <button
              onClick={handleRectangle}
              className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-overlay)] flex items-center gap-2"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-[var(--text-muted)] shrink-0">
                <rect x="2" y="2" width="12" height="12" rx="1" strokeDasharray="3 2" />
              </svg>
              Rectangle
            </button>
            <button
              onClick={() => { setShowDropdown(false); setShowWindowPicker(true) }}
              className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-overlay)] flex items-center gap-2"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-[var(--text-muted)] shrink-0">
                <rect x="1" y="3" width="14" height="10" rx="1.5" />
                <line x1="1" y1="6" x2="15" y2="6" />
              </svg>
              Window
            </button>
          </div>
        )}
      </div>

      {showWindowPicker && (
        <WindowPickerModal
          onCapture={handleWindowCapture}
          onCancel={() => setShowWindowPicker(false)}
        />
      )}
    </>
  )
}
