/**
 * What an Agent Canvas marker line may be: the one chat line that tells the
 * agent a verdict or a review was filed. Main's canvas:agentMarker schema
 * (src/main/ipc/canvas-handlers.ts) bounds it and replaces every control
 * character with a space; the renderer checks a line again before it types one
 * into a Claude Code session (src/renderer/lib/claudePrompt.ts). Both read the
 * bound and the control range from here, so they cannot drift apart.
 */

/** The longest marker line the canvas channel takes. */
export const CANVAS_MARKER_MAX_LINE = 400

/** One control character: C0, DEL or C1. */
// eslint-disable-next-line no-control-regex -- matching the control range IS the point
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/

/** A run of control characters, for String.replace (global). */
export const MARKER_CONTROL_CHARS_RE = new RegExp(`${CONTROL_CHAR_RE.source}+`, 'g')

/** The renderer's answer's reason for a request to type a marker into a
 *  Claude Code session that is not well formed (a line this module does not
 *  let through, a bad id or mode). No later read changes it, so main drops
 *  that marker rather than ask again. */
export const CLAUDE_MARKER_REFUSED = 'refused'

/** A marker line as the canvas channel lets one through: text, not blank,
 *  within the bound, with no control character. */
export function canvasMarkerLineOk(line: unknown): line is string {
  return typeof line === 'string'
    && line.length > 0
    && line.length <= CANVAS_MARKER_MAX_LINE
    && line.trim() !== ''
    && !CONTROL_CHAR_RE.test(line)
}
