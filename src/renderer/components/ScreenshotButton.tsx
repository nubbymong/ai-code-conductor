import React, { useState, useRef, useEffect } from 'react'
import { useMagicButtonStore } from '../stores/magicButtonStore'
import WindowPickerModal from './WindowPickerModal'
import { ReservedLabel } from './command-bar/chips'
import { sendImageToSession } from '../utils/imageTransfer'
import { reportSnapPaste } from '../utils/imagePaste'
import { usePasteHintStore } from '../stores/pasteHintStore'
import { SNAP_NO_DESKTOP_TEXT, isSnapNotCaptured } from '../../shared/snap-engine'
import { isSnapPasteAnswer, isSnapPathRouteAnswer, SNAP_RECTANGLE_SENTENCE, SNAP_WINDOW_SENTENCE, type SnapItem } from '../../shared/clipboard-paste'

/** How long the line a press that captured nothing stays up. */
const SNAP_NOTE_MS = 6000

interface Props {
  sessionId: string
  // How the picture reaches the session (ADR-032; plan 2.1.3-beta.21 phase
  // 2, 2.1.5): main's capture keeps the picture and answers a token for it,
  // never its path; the token goes back on the paste channel, and the paste
  // module writes the picture to the clipboard and presses the CLI's own
  // paste key, then the sentence and Enter. A tab on the old SSH path gets
  // today's request naming the saved file for the Conductor MCP server's
  // fetch_host_screenshot tool. Only the path route behind the test switch
  // answers a file, for 2.1.3-beta.20's flow (sendImageToSession).
  sessionType: 'local' | 'ssh'
}

/** A capture's answer applied: its token handed to the paste (not awaited:
 *  the capture has ended and the button is usable again while the paste
 *  runs; its hint, or the old SSH path's request, follows), or on the path
 *  route only 2.1.3-beta.20's flow. */
function applySnapAnswer(sessionId: string, answer: unknown, item: SnapItem, sessionType: 'local' | 'ssh'): boolean {
  const sentence = item === 'window' ? SNAP_WINDOW_SENTENCE : SNAP_RECTANGLE_SENTENCE
  if (isSnapPasteAnswer(answer)) {
    void reportSnapPaste(sessionId, answer.snapToken, item, sentence)
    return true
  }
  if (isSnapPathRouteAnswer(answer)) {
    sendImageToSession(sessionId, answer.pathRoute.file, sentence, sessionType, answer.pathRoute.line)
    return true
  }
  return false
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
      const answer = await window.electronAPI.screenshot.captureRectangle(sessionId)
      if (applySnapAnswer(sessionId, answer, 'rectangle', sessionType)) {
        // the token went to the paste; its hint follows
      } else if (isSnapNotCaptured(answer)) {
        // 2.1.3-beta.19 fix round: nothing opened, so say why, above the bar.
        usePasteHintStore.getState().show(sessionId, SNAP_NO_DESKTOP_TEXT, SNAP_NOTE_MS)
      }
    } finally {
      setCapturing(false)
    }
  }

  const handleWindowCapture = async (sourceId: string) => {
    setShowWindowPicker(false)
    setCapturing(true)
    try {
      const answer = await window.electronAPI.screenshot.captureWindow(sourceId, sessionId)
      applySnapAnswer(sessionId, answer, 'window', sessionType)
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
