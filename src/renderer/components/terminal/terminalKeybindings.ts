import { isPasteChord, isCopyChord, shouldHandleTerminalPaste, isOrdinaryEditable } from '../../utils/terminalInput'

/**
 * Terminal clipboard keybindings (copy + paste), extracted from TerminalView so the
 * REGISTRATION is testable — not just the predicates (#154).
 *
 * Why extraction was the point: the #145 bug was a handler registered on `document`
 * in the BUBBLE phase. xterm's own keydown listener sits on the helper textarea and
 * therefore runs in the TARGET phase — before any document bubble listener — so it
 * had already turned Ctrl+V into the raw control byte \x16 and written it to the PTY.
 * `preventDefault()` there is far too late.
 *
 * That handler typechecked, passed every unit test, and was dead code on the only
 * path that mattered. The predicates were never wrong; the wiring was. Testing the
 * predicates could not have caught it, and a test that mirrors the registration
 * would pass whether or not the real code was right. So the wiring lives here,
 * behind an injectable seam, and the tests drive THIS function.
 *
 * Everything the DOM/Electron world provides is injected, so a test supplies its own
 * document, clipboard and terminal.
 */

/** The slice of xterm's Terminal this needs. Keeps tests free of a real terminal. */
export interface KeybindingTerminal {
  getSelection: () => string
  paste: (text: string) => void
  clearSelection?: () => void
}

/** The clipboard image paste's part of the keybindings (ADR-032). */
export interface ImagePasteBinding {
  /** Whether `e` is the image paste shortcut (Alt+V by default, read fresh). */
  isImageChord: (e: KeyboardEvent) => boolean
  /** Read fresh on every keystroke: whether this session's CLI takes the
   *  image paste now (its kind, the partner view not on screen). */
  takes: () => boolean
  /** Whether this terminal itself has the keyboard focus (a press from
   *  outside it types the sentence and Enter after the picture). */
  terminalFocused: () => boolean
  /** Report the press to main; resolves whether it found nothing to paste
   *  (the text chord with no picture on the clipboard). */
  press: (chord: 'image' | 'text', focused: boolean) => Promise<boolean>
}

export interface TerminalKeybindingOptions {
  term: KeybindingTerminal
  /** Read fresh on every keystroke: every session's TerminalView stays mounted and
   *  shares this `document` listener, so a captured boolean would go stale. */
  isActive: () => boolean
  /** Focus-independent clipboard read (main-process backed in the app). */
  readText: () => Promise<string>
  writeText: (text: string) => Promise<void>
  /** Called when a paste chord was handled but there was nothing to paste, so the
   *  failure is visible rather than silent — the property that let #145 hide. */
  onNothingToPaste?: () => void
  /** ADR-032 (plan 2.1.3-beta.21 phase 2, 2.1.4): the clipboard image paste,
   *  for a session whose CLI takes it (an agent session on
   *  this computer, or a helper tab; utils/imagePaste.ts). Absent: nothing
   *  changes, as in a plain terminal, a partner pane or a tab on the old SSH
   *  path, where Alt+V stays xterm's. */
  imagePaste?: ImagePasteBinding
  /** Seams, defaulted to the real DOM. */
  doc?: Document
  hasModalOpen?: () => boolean
  getActiveElement?: () => Element | null
}

/**
 * Install the copy/paste keybindings. Returns a disposer.
 *
 * The `true` capture flag on both add and remove is load-bearing, twice over:
 * capture is what beats xterm's textarea listener, and an unmatched flag on
 * `removeEventListener` silently fails to remove anything — leaking a listener that
 * keeps pasting into a disposed terminal.
 */
export function installTerminalKeybindings(opts: TerminalKeybindingOptions): () => void {
  const doc = opts.doc ?? document
  const hasModalOpen = opts.hasModalOpen ?? (() => !!doc.querySelector('[role="dialog"][aria-modal="true"]'))
  const getActiveElement = opts.getActiveElement ?? (() => doc.activeElement)

  const onKeyDown = (ev: Event) => {
    const e = ev as KeyboardEvent
    // ADR-032: Alt+V with this terminal focused, in a session whose CLI takes
    // the image paste, is reported to main as one press (never typed as ESC v
    // by xterm, and no path): claimed before xterm's own listener sees it.
    const image = opts.imagePaste
    if (image && image.isImageChord(e)) {
      if (!opts.isActive() || hasModalOpen() || !image.terminalFocused() || !image.takes()) return
      e.stopPropagation()
      e.preventDefault()
      if (e.repeat) return
      void image.press('image', true)
      return
    }
    const paste = isPasteChord(e)
    const copy = !paste && isCopyChord(e)
    if (!paste && !copy) return

    // Same gate for both chords. Copy previously had NO guard at all: it ran once
    // per mounted terminal and fired even with focus in a text input.
    if (!shouldHandleTerminalPaste({
      isActive: opts.isActive(),
      hasModalOpen: hasModalOpen(),
      targetIsOrdinaryEditable: isOrdinaryEditable(getActiveElement() as HTMLElement | null),
    })) return

    // Claim the event before any async work. stopPropagation is what prevents xterm
    // from seeing the chord and emitting a raw control byte; preventDefault stops
    // Chromium's native clipboard command from double-acting.
    e.stopPropagation()
    e.preventDefault()

    if (copy) {
      const sel = opts.term.getSelection()
      if (!sel) return
      void opts.writeText(sel).then(
        () => { opts.term.clearSelection?.() },
        () => { /* clipboard write denied — selection stays put */ },
      )
      return
    }

    void (async () => {
      let text = ''
      try {
        text = await opts.readText()
      } catch {
        text = ''
      }
      if (!text) {
        // ADR-032 (plan Q2): no text, and a CLI that takes the image paste:
        // main pastes a picture if the clipboard holds one; text is never
        // touched (ADR-008).
        if (image && image.takes()) {
          let nothing = true
          try { nothing = await image.press('text', image.terminalFocused()) } catch { nothing = true }
          if (nothing) opts.onNothingToPaste?.()
          return
        }
        opts.onNothingToPaste?.()
        return
      }
      opts.term.paste(text)
    })()
  }

  doc.addEventListener('keydown', onKeyDown, true)
  return () => doc.removeEventListener('keydown', onKeyDown, true)
}
