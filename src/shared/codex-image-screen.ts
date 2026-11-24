/**
 * Codex's image placeholder, read from its screen (2.1.3-beta.17 section C6,
 * aicc_planning#415): what main's image rule for a Codex session
 * (src/main/providers/codex/session-screen.ts, pasteImageIntoCodexComposer)
 * reads beside the composer readers of ./codex-screen.ts. Pure: the rows of a
 * terminal's live screen in, what they show out. It only calls those readers;
 * it never changes what they read.
 *
 * Evidence: probe P11 (ADR-030, the P11 result; Codex 0.157.1 on the Windows
 * test machine): a bracketed paste of a saved image's path makes Codex attach
 * the picture and show "[Image #1]" in its composer, and the sentence typed
 * after it follows it on the same row ("[Image #1]  <sentence>"); the turn
 * then carries the picture and the placeholder, not the path.
 */
import { readCodexScreen, codexComposerText, codexScreenLessCountAlone, type ScreenLine } from './codex-screen'

/** Codex's placeholder for an attached image. */
const IMAGE_PLACEHOLDER_RE = /^\[Image #(\d{1,3})\]$/

/** Codex's prompt glyphs (its composer's, and the one it draws at ultra), as
 *  ./codex-screen.ts reads the composer row. */
const COMPOSER_ROW_RE = new RegExp(`^[${String.fromCharCode(0x203a)}${String.fromCharCode(0xbb)}](?: |$)`)
const GLYPH_PREFIX_RE = new RegExp(`^[${String.fromCharCode(0x203a)}${String.fromCharCode(0xbb)}] ?`)

/** The index of the composer row: the last row with Codex's prompt glyph. */
function composerRowIndex(lines: readonly ScreenLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (COMPOSER_ROW_RE.test(lines[i].text)) return i
  return -1
}

/** The image placeholder ("[Image #N]") when Codex's composer is ready and
 *  holds that placeholder and nothing else, as readCodexScreen reads a ready
 *  composer (no prompt up, no turn running by its row or by `title`, the
 *  footer under it); null otherwise. */
export function codexImagePlaceholderShown(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null, title?: string | null): string | null {
  const read = readCodexScreen(lines, models, { title })
  return read.screen === 'ready' && IMAGE_PLACEHOLDER_RE.test(read.text) ? read.text : null
}

/** Whether `draft` (codexComposerDraft's reading: every space dropped) is an
 *  image placeholder alone. */
export function codexDraftIsImagePlaceholder(draft: string | null | undefined): boolean {
  return typeof draft === 'string' && /^\[Image#\d{1,3}\]$/.test(draft)
}

/**
 * The screen as the image rule reads it while it types the sentence after
 * the image's placeholder: Codex's composer with `placeholder` taken as its
 * start, so the submit primitive's own readers read the composer that holds
 * only the placeholder as ready and empty, and confirm the sentence typed
 * after it as the whole text.
 *
 * - A prompt up: the screen as it is (the primitive reads it as a prompt and
 *   stops), and so with no composer drawn.
 * - The composer row starting with `placeholder`: that row without it (its
 *   text, and its typed and inverse readings, cut at the same cells). Since
 *   2.1.3-beta.17 C9 (aicc_planning#420) Codex's warning count alone under
 *   the footer is left out as well, where ./codex-screen.ts's readers take it
 *   under the composer Codex shows (codexScreenLessCountAlone): with the
 *   placeholder cut that composer reads empty, and the count alone under an
 *   empty composer is not recorded, so the readers would refuse it. The
 *   count at the right of a hint row is read as the readers read it.
 * - `typed` (the sentence has been written) and the composer empty: the
 *   screen as it is (the take-back's clear reads ready and empty).
 * - Anything else (the placeholder gone or moved, the composer holding
 *   something before it): no reading (null), so the primitive types nothing
 *   more and presses no Enter.
 */
export function codexScreenPastPlaceholder(lines: ScreenLine[] | null | undefined, placeholder: string, typed: boolean, models?: readonly string[] | null): ScreenLine[] | null {
  if (!lines) return null
  if (readCodexScreen(lines, models).screen === 'blocked') return lines
  const i = composerRowIndex(lines)
  if (i < 0) return lines
  const row = lines[i]
  const prefix = GLYPH_PREFIX_RE.exec(row.text)?.[0] ?? ''
  if (row.text.slice(prefix.length).startsWith(placeholder)) {
    const cut = (s: string): string => (s.length > prefix.length ? s.slice(0, prefix.length) + s.slice(prefix.length + placeholder.length) : s)
    const out = codexScreenLessCountAlone(lines).slice()
    out[i] = { ...row, text: cut(row.text), typed: cut(row.typed), ...(typeof row.inverse === 'string' ? { inverse: cut(row.inverse) } : {}) }
    return out
  }
  if (typed && codexComposerText(lines) === '') return lines
  return null
}
