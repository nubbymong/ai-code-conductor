// The status strip's layout classes (SessionStatusStrip.tsx), on their own so
// the 1280x768 layout check (tests/e2e/session-strip-1280.spec.ts) builds its
// probe from the very classes the strip draws with, without loading the
// component and its stores. jsdom lays nothing out, so that check, in the real
// app with the real stylesheet, is the one that measures them.

/** The strip itself: the account, the telemetry, a helper tab's note and
 *  the controls, side by side. */
export const STRIP_CLASS = 'min-h-7 shrink-0 flex items-center gap-3 px-3 text-xs border-t border-b'

/**
 * The strip's telemetry and the helper tab's note beside it (2.1.3-beta.19
 * release smoke: at 1280x768 the note kept its whole width and the row, cut
 * where the note began, showed the weekly meter as a lone "W"). In a flex
 * row, a `flex-1` item's basis is 0, so it only ever gets what the others
 * leave, and a note that does not shrink leaves it short. The telemetry's
 * basis is its content (`flex-auto`), so when the strip is too narrow the
 * space comes off the items by how much each may shrink: the note may shrink
 * a thousand times as much, with an ellipsis (`truncate`) and its reason
 * still in its title. So the note gives way first, and stops at three
 * characters (`min-w-[3ch]`, PR 763 fix round 9: an ellipsis and its title to
 * hover).
 *
 * PR 763 fix round 10: the meters are no longer the end of the row that is
 * cut. Fix round 9 sized the row to a fresh tab's waiting meters; once they
 * have readings, each adds its reset time ("resets Nov 30 10:00 am", on by
 * default), and the cut, at the row's right end, took the Weekly meter again.
 * The telemetry is now the text row (STRIP_MIDDLE_ROW_CLASS), then the meters
 * (STRIP_METERS_CLASS), then the review count and the Copilot meter where a
 * tab has them, in that order as before, in a tail of their own
 * (STRIP_TAIL_CLASS, PR 763 fix round 11). Inside it that tail gives way
 * first, down to nothing. The meters shrink ten times as much as
 * the row but only down to their labels, bars and percentages: their reset
 * texts give way (RATE_LIMIT_RESET_WRAP_CLASS). Then the row gives way, its
 * context track first and then its text, cut at its right end. Only once the
 * row is at nothing does the telemetry's own clip reach the meters, at its
 * right end: without it, a strip too narrow for the account, the meters, the
 * note and the controls (the sidebar at its widest, or an account with
 * per-model bars) would push the controls out of the window.
 *
 * PR 763 fix round 12: that clip is `overflow-x-clip`, not `overflow-hidden`.
 * The tail has no clip of its own now, so its hidden content reaches the
 * telemetry; `overflow-hidden` made the telemetry a scroll container, and
 * keyboard focus on a hidden Copilot chip scrolled it 166 px (a headless
 * probe of the 1280 px e2e spec's frame at a 1024 px strip), out of view of
 * the row's first figures, and it stayed so after the focus left. A clip is
 * no scroll container, so focus cannot scroll it; and it cuts nothing above
 * or below, so the chip's focus ring is whole when there is room.
 */
export const STRIP_TELEMETRY_CLASS = 'flex items-center gap-2 flex-auto min-w-0 overflow-x-clip'
export const REMOTE_USAGE_NOTE_CLASS = 'min-w-[3ch] truncate shrink-[1000]'

/**
 * The text row at the start of the telemetry: the model (where the strip
 * shows it), the tokens, the context meter, the cost, the lines and the duration, 8 px apart
 * (`gap-2`, PR 763 fix round 9, was 12). Its basis is its content and it
 * does not grow (`flex-initial`), so the meters follow its last item; it may
 * shrink to nothing and is cut at its right end. With every item turned off
 * it draws nothing (`empty:hidden`), so no gap is left before the meters.
 */
export const STRIP_MIDDLE_ROW_CLASS = 'flex items-center gap-2 flex-initial min-w-0 overflow-hidden empty:hidden'

/**
 * The context meter in the text row (PR 763 fix round 9): its wrapper draws
 * no box of its own (`contents`), so its track and its percentage are items
 * of the row. The track is the one item there that may shrink, from 64 px to
 * 24 px (`min-w-6`), before the row is cut; the percentage beside it, and
 * every other item, keeps its width.
 */
export const STRIP_CONTEXT_CLASS = 'contents'
export const STRIP_CONTEXT_TRACK_CLASS = 'w-16 min-w-6 h-1.5 rounded-full overflow-hidden'
export const STRIP_CONTEXT_PCT_CLASS = 'tabular-nums shrink-0'

/**
 * The rate-limit meters, after the text row (PR 763 fix round 10). They
 * shrink ten times as much as the row (`shrink-[10]`), but with no `min-w-0`
 * and no clip of their own a flex item never goes below its content's
 * minimum, which is each meter's label, bar and percentage: the reset texts
 * are the only part with a minimum of nothing. No text in them wraps
 * (`whitespace-nowrap`): a label, "not reported" or the extra usage would
 * otherwise break onto a second line once the meters shrink.
 */
export const STRIP_METERS_CLASS = 'flex items-center gap-3 shrink-[10] whitespace-nowrap'

/**
 * The telemetry's tail (PR 763 fix round 11): the review count and the
 * Copilot meter, after the meters. Before fix round 10 they were the text
 * row's last items, so the row's cut took them first; fix round 10 moved
 * them out of the row, and as shrink-0 items of the telemetry the whole text
 * row then gave way before either lost a pixel (in the 1280 px e2e spec's
 * frame, a 1024 px strip with the release smoke's controls, a local tab with
 * readings and the Copilot meter kept 164.5 px of its 416.6 px row, the
 * 153.3 px chip whole). In this tail they give way first inside the
 * telemetry again: it may shrink a thousand times as much as the row
 * (`shrink-[1000]`), to nothing (`min-w-0`), its content cut by the
 * telemetry's own clip, which a shrunk tail always ends at (no clip of its
 * own, so the chip's focus ring is not cut when there is room), before the
 * meters' reset texts and the text row. With neither shown it draws nothing
 * (`empty:hidden`), so no gap is left after the meters.
 */
export const STRIP_TAIL_CLASS = 'flex items-center gap-2 min-w-0 shrink-[1000] empty:hidden'

/**
 * A meter's reset text (RateLimitBar, PR 763 fix round 10), the one part of
 * a meter that gives way, with an ellipsis; the reset time stays in the
 * bar's title. `min-w-0` on a flex item lets it shrink, but its parent's
 * minimum still counts its whole text, so the meters could never have let it
 * go. In a one-column grid whose column is `minmax(0, max-content)`, the
 * column is the text's width when there is room and nothing at the grid's
 * own minimum, so the text adds nothing to the meters' minimum.
 */
export const RATE_LIMIT_RESET_WRAP_CLASS = 'grid grid-cols-[minmax(0,max-content)] min-w-0'
export const RATE_LIMIT_RESET_CLASS = 'min-w-0 truncate tabular-nums'
