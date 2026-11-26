import { writeSessionInput } from '../components/terminal/tmuxWheelScroll'
import { quoteArgForShell } from '../../shared/shell-quote'
import { useSessionStore } from '../stores/sessionStore'
import { usePasteHintStore } from '../stores/pasteHintStore'
import { sendImagePathToCodex, NOT_AT_PROMPT, IMAGE_AT_PROMPT } from '../lib/codexComposer'
import { sessionCapabilities } from '../lib/session-capabilities'
import type { ImageLine } from '../lib/session-capabilities'
import { SSH_THROUGH_HELPER } from '../../shared/remote-machines'
/**
 * Image transfer helper: gets a host-saved image into a session. The prompts
 * below are a Claude session's; a plain terminal (and the partner shell) gets
 * only the image's path, quoted for its shell (composeShellImagePath, below);
 * a Codex session's goes through main's door too, with its own fallback
 * (sendImageToCodexSession, below). Which route a pasted image takes is
 * decided in hooks/useKeyboardShortcuts.ts. Since 2.1.3-beta.18 section 4 a
 * session on this computer is sent by one path whatever its agent
 * (sendImageThroughMain): main's door decides the paste by the session's own
 * provider, and the session's image line (session-capabilities.ts) what is
 * typed when main does not paste it.
 *
 * For a Claude session:
 *
 * Local sessions (2.1.3-beta.16 X1.2): main types the absolute path as a
 * bracketed paste, which Claude Code attaches as its own pasted image
 * ("[Image #1]"), then the sentence, then Enter (pty.submitImage; probe P11,
 * ADR-030: a path typed as text reaches the model only as words). A session
 * main does not type an image into (an SSH Persistent session) answers
 * `not-taken` and gets the line it always got: the sentence and the path
 * typed, then Enter.
 *
 * SSH sessions: write the bare filename and ask Claude to call
 * `mcp__conductor__fetch_host_screenshot`. The remote machine
 * has no access to the host filesystem, so the MCP fetch (running over
 * the auto-injected reverse tunnel) is the only way the image lands on
 * Claude's input. Vision MCP is started at app launch, so this path is
 * always available on SSH sessions even when no browser is configured.
 * A tab through the session helper on its machine gets the request, then
 * its Enter as its own write (sendFetchRequest, below).
 *
 * Both paths cap the image to 1920px / JPG q85 server-side
 * (screenshot-capture.ts) so neither saturates Claude's image-size
 * budget.
 */

/**
 * Extract the bare filename from a Windows or POSIX absolute path.
 */
function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.split('/').pop() || filePath
}

/**
 * Compose the prompt that asks Claude to fetch a host screenshot via MCP.
 * The prompt is a single line so it submits cleanly when followed by \r.
 *
 * Optional `userContext` is included so Claude knows what the user wants done
 * with the image (defaults to "Please view this image.").
 */
export function composeFetchHostScreenshotPrompt(
  filename: string,
  userContext?: string
): string {
  const ctx = userContext?.trim() || 'Please view this image.'
  // Single-line prompt — Claude needs the tool name and the filename arg clearly.
  return `${ctx} (use mcp__conductor__fetch_host_screenshot with filename="${filename}" to load the image from the Conductor host)`
}

/**
 * Compose a local-path prompt: the sentence, then the absolute path, typed as
 * text. Since X1.2 only the line for a session main does not paste an image
 * into (sendImageToSession).
 */
export function composeLocalPathPrompt(
  filePath: string,
  userContext?: string
): string {
  const ctx = userContext?.trim() || 'Please view this image.'
  return `${ctx} ${filePath}`
}

/** C6: what the user is told when main refused the image's path for Codex. */
export function imagePathRefusedNote(hostFilePath: string): string {
  return `The image's path could not be typed into Codex, so nothing was sent; the image was saved on this computer at ${hostFilePath}.`
}

/**
 * 2.1.3-beta.18 section 4 (aicc_planning#432): a host-saved image into a
 * session on this computer, for every agent: main's image door is asked to
 * paste it by the rule of the session's own provider (pty.submitImage), and
 * what main did not paste is typed by the session's own image line (`line`,
 * sessionCapabilities' imageLine): `enter`, the sentence and the path, then
 * Enter, in one write; `composer`, the same words by the rule that types into
 * Codex (sendImagePathToCodex), which tells `onNote` why when it types
 * nothing; none, nothing. Main's `left` (what it pasted may still be at the
 * prompt) types nothing more and tells `onNote`; a `not-sent` answer is told
 * to `onNote` only on the composer line, as before. An ask that fails gets
 * the session's line too. The sentence goes as given, or the default one.
 */
function sendImageThroughMain(
  sessionId: string,
  hostFilePath: string,
  sentence: string,
  line: ImageLine | null,
  onNote: (note: string) => void,
): void {
  const words = sentence.trim() || 'Please view this image.'
  const typed = (): void => {
    if (line === 'composer') sendImagePathToCodex(sessionId, hostFilePath, onNote, undefined, words)
    // A trailing \r submits it.
    else if (line === 'enter') writeSessionInput(sessionId, composeLocalPathPrompt(hostFilePath, words) + '\r')
  }
  void window.electronAPI.pty.submitImage({ sessionId, path: hostFilePath, sentence: words }).then(
    (result) => {
      if (result.outcome === 'not-taken') {
        // `left`: main's ImageSubmitResult (session-input), read as main sends it.
        if (result.left === true) onNote(IMAGE_AT_PROMPT)
        else typed()
      } else if (result.outcome === 'not-sent' && line === 'composer') onNote(result.reason === 'refused-text' ? imagePathRefusedNote(hostFilePath) : NOT_AT_PROMPT)
    },
    typed,
  )
}

/**
 * 2.1.3-beta.17 C6 (aicc_planning#415): a host-saved image into a Codex
 * session on this computer (Alt+V, Snap). Main is asked to paste the path as
 * Codex's own paste, then the sentence, then Enter (pty.submitImage; probe
 * P11: Codex attaches a path it gets as a bracketed paste, "[Image #1]", and
 * reads a typed path only as words). What main could not paste (`not-taken`:
 * Codex not ready in its wait, no placeholder; or an ask that failed) gets
 * today's line, the sentence and the path, by the rule that types into Codex
 * (sendImagePathToCodex), which types only into a ready, empty composer and
 * otherwise tells `onNote` why it typed nothing.
 * When main says it left its paste at the prompt (`not-taken` with `left`: it
 * could not take "[Image #1]" back for certain), nothing more is typed and
 * `onNote` hears that the image is at the prompt and was not sent; only main
 * knows the placeholder is its own, since a composer holding the user's own
 * pasted image reads the same. A session that is gone, or a path main
 * refuses, gets nothing typed, and `onNote` is told. The sentence goes as
 * given (PB3: U+2014 is kept on 0.153.4 and 0.155.1 typed this way; C6's
 * reading: after the placeholder on 0.157.1 it reached Codex's turn, 3 of 3).
 * Since 2.1.3-beta.18 section 4 this is sendImageThroughMain on the composer
 * line.
 */
export function sendImageToCodexSession(
  sessionId: string,
  hostFilePath: string,
  sentence: string,
  onNote: (note: string) => void,
): void {
  sendImageThroughMain(sessionId, hostFilePath, sentence, 'composer', onNote)
}

/** 2.1.3-beta.18 fix round (section 3.2's host line): how long the Enter
 *  waits after an image request typed into a tab through the session helper,
 *  as a prompt button's Enter waits after its text in a Claude Code session
 *  (main's session-input PROMPT_ENTER_DELAY_MS, #333). */
export const HELPER_ENTER_DELAY_MS = 300

/**
 * The host fetch request into an SSH tab, and its Enter.
 *
 * Today's SSH tab gets them in one write, as it always did. A tab main says
 * runs through the session helper on its machine (ssh.getState answers
 * SSH_THROUGH_HELPER) gets the request, then the Enter as its own write
 * HELPER_ENTER_DELAY_MS later. Claude Code makes a control character a key of
 * its own only in a read shorter than 64 characters (measured from its input
 * tokenizer, 2.1.332), and the helper hands each write to the program on the
 * host whole, so the request and its Enter in one write reached it as one read
 * and the Enter stayed in the text: typed, not sent (the host line, 2 of 2).
 * The Enter is not typed when the tab started again while it waited (main
 * pushes the tab's flow state at every start) or was closed. A preload with
 * no such bridge, or an ask that fails, gets the one write.
 */
function sendFetchRequest(sessionId: string, request: string): void {
  const whole = (): void => writeSessionInput(sessionId, request + '\r')
  const ssh = window.electronAPI?.ssh
  if (typeof ssh?.getState !== 'function') { whole(); return }
  void ssh.getState(sessionId).then((flow: { state?: string } | null | undefined) => {
    if (flow?.state !== SSH_THROUGH_HELPER) { whole(); return }
    writeSessionInput(sessionId, request)
    let startedAgain = false
    const off = typeof ssh.onFlowState === 'function' ? ssh.onFlowState(sessionId, () => { startedAgain = true }) : undefined
    setTimeout(() => {
      try { off?.() } catch { /* already gone */ }
      if (startedAgain || !useSessionStore.getState().sessions.some((s) => s.id === sessionId)) return
      writeSessionInput(sessionId, '\r')
    }, HELPER_ENTER_DELAY_MS)
  }, whole)
}

/** The session's image line (sessionCapabilities' imageLine), from its
 *  record in the session store, read as every reader of the store reads one. */
function imageLineOf(sessionId: string): ImageLine | null {
  return sessionCapabilities(useSessionStore.getState().sessions.find((s) => s.id === sessionId)).imageLine
}

/**
 * Send a host-saved image file to a Claude session (or, since 2.1.3-beta.17
 * C6, a Codex session on this computer; since 2.1.3-beta.18 section 4 every
 * session on this computer goes one way, sendImageThroughMain, with its
 * notes in the session's paste hint).
 *
 * @param sessionId - target Claude PTY session id
 * @param hostFilePath - absolute local path of the image file
 * @param userContext - optional context message prepended to the prompt
 * @param sessionType - 'local': main pastes the path (pty.submitImage), or,
 *                     for a session it does not take, the session's own
 *                     image line; 'ssh' uses MCP fetch. Defaults to MCP fetch
 *                     for back-compat with any caller that doesn't yet
 *                     thread the type through.
 */
export function sendImageToSession(
  sessionId: string,
  hostFilePath: string,
  userContext?: string,
  sessionType?: 'local' | 'ssh'
): void {
  if (sessionType === 'local') {
    // 2.1.3-beta.18 section 4: main's door for every session on this
    // computer; what it does not paste, the session's own image line.
    sendImageThroughMain(sessionId, hostFilePath, userContext ?? '', imageLineOf(sessionId), (note) => usePasteHintStore.getState().show(sessionId, note))
    return
  }
  // Its Enter submits the prompt to Claude (sendFetchRequest).
  sendFetchRequest(sessionId, composeFetchHostScreenshotPrompt(basename(hostFilePath), userContext))
}

/**
 * The text Alt+V puts into a PLAIN terminal (a shell with no assistant): the
 * image's path, quoted for the shell it runs (PowerShell on Windows, a POSIX
 * shell elsewhere: shared/shell-quote.ts), and nothing else. A shell reads no
 * images, so the sentence an assistant is told would be typed into it as a
 * command, and an Enter would run it; a shell user wants the path at the cursor
 * to use in a command of their own.
 */
export function composeShellImagePath(hostFilePath: string, isWin32: boolean): string {
  return quoteArgForShell(hostFilePath, isWin32)
}

/** Whether `text` holds a control character (C0, DEL or C1). */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true
  }
  return false
}

/** Type the quoted path of a host-saved image at a plain terminal's prompt:
 *  not submitted (no Enter). Returns whether it was typed.
 *  PR-level ADR-009 round 1 (A1): off Windows the path is typed only when
 *  main said the shell it spawns a plain terminal with is of the sh family
 *  (`posixShell` 'sh', from the saved image's answer), and only when the path
 *  holds no control character; otherwise nothing is typed and the caller says
 *  where the image was saved. Windows (PowerShell) is unchanged. */
export function typeImagePathIntoShell(sessionId: string, hostFilePath: string, isWin32: boolean, posixShell?: 'sh' | 'other'): boolean {
  if (!isWin32 && (posixShell !== 'sh' || hasControlChar(hostFilePath))) return false
  writeSessionInput(sessionId, composeShellImagePath(hostFilePath, isWin32))
  return true
}
