// The status strip's layout classes (SessionStatusStrip.tsx), on their own so
// the 1280x768 layout check (tests/e2e/session-strip-1280.spec.ts) builds its
// probe from the very classes the strip draws with, without loading the
// component and its stores. jsdom lays nothing out, so that check, in the real
// app with the real stylesheet, is the one that measures them.

/** The strip itself: the account, the middle row, a helper tab's note and
 *  the controls, side by side. */
export const STRIP_CLASS = 'min-h-7 shrink-0 flex items-center gap-3 px-3 text-xs border-t border-b'

/**
 * The strip's middle row and the helper tab's note beside it (2.1.3-beta.19
 * release smoke: at 1280x768 the note kept its whole width and the row, cut
 * where the note began, showed the weekly meter as a lone "W"). In a flex
 * row, a `flex-1` item's basis is 0, so it only ever gets what the others
 * leave, and a note that does not shrink leaves it short. The row's basis is
 * its content (`flex-auto`), so when the strip is too narrow the space comes
 * off the items by how much each may shrink: the note may shrink a thousand
 * times as much as the row, with an ellipsis (`truncate`) and its reason
 * still in its title. So the note gives way first.
 *
 * PR 763 fix round 9 (the release smoke re-read, its item 8): at 1280x768 the
 * note then shrank to nothing (it could not be seen or hovered) and the row
 * was still 15 px short, so the weekly meter lost its "%". Now the note stops
 * at three characters (`min-w-[3ch]`: an ellipsis and its title to hover),
 * the row's items sit 8 px apart (`gap-2`, was 12), and the context meter's
 * track gives way next (STRIP_CONTEXT_TRACK_CLASS), so the row is cut only
 * once that track is at its own minimum.
 */
export const STRIP_MIDDLE_ROW_CLASS = 'flex items-center gap-2 flex-auto min-w-0 overflow-hidden'
export const REMOTE_USAGE_NOTE_CLASS = 'min-w-[3ch] truncate shrink-[1000]'

/**
 * The context meter in the middle row (PR 763 fix round 9): its wrapper draws
 * no box of its own (`contents`), so its track and its percentage are items
 * of the row. The track is the one item there that may shrink, from 64 px to
 * 24 px (`min-w-6`), before the row is cut; the percentage beside it, and
 * every other item, keeps its width.
 */
export const STRIP_CONTEXT_CLASS = 'contents'
export const STRIP_CONTEXT_TRACK_CLASS = 'w-16 min-w-6 h-1.5 rounded-full overflow-hidden'
export const STRIP_CONTEXT_PCT_CLASS = 'tabular-nums shrink-0'

/** The rate-limit meters in the middle row, as one item that keeps its width. */
export const STRIP_METERS_CLASS = 'flex items-center gap-3 shrink-0'
