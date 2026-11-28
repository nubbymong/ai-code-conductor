// The Account usage page's layout classes (nubbymong/aicc_planning#445, the
// approved mockup v1), in one place so the page and its e2e layout spec
// (tests/e2e/account-usage-grid.spec.ts) draw with the same ones. jsdom lays
// nothing out, so the column count at each width is measured there, in the
// real app with its real stylesheet.

/** The page's minimum card width, px: cards fill as many columns of at least
 *  this as fit (three on a 1280 px page, two on a 1024 px one). */
export const ACCOUNT_USAGE_CARD_MIN_PX = 330

/** The page body around the summary and the bands. */
export const ACCOUNT_USAGE_BODY_CLASS = 'px-5 pt-3.5 pb-[18px]'

/** A band's grid. `min(330px, 100%)` keeps one card from overflowing a body
 *  narrower than a card. */
export const ACCOUNT_USAGE_GRID_CLASS = 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(330px,100%),1fr))]'

/** A card's frame; its border and fill are added for its state. `min-w-0`
 *  lets a long email wrap inside the card rather than widen its column. */
export const ACCOUNT_USAGE_CARD_CLASS = 'relative min-w-0 rounded-xl border px-3.5 pt-3 pb-2.5 flex flex-col gap-2.5 min-h-[178px]'

/** A card's name (or full email): never truncated, so a long one wraps. */
export const ACCOUNT_USAGE_NAME_CLASS = 'text-[0.9375rem] text-text font-medium break-all'

// 2.1.3-beta.20 section 5 (the approved mockup "Accounts across machines",
// frame 1): a Claude Code card's "On machines" block, one row per machine
// (this computer first), each with its state and, where the account is not
// signed in there, "Sign in on <machine>". Drawn from the card's Credits
// divider and the Machines page's small uppercase heading. The row never
// widens its card: the name column is fixed, the state wraps, and a long
// machine name in the button is cut with an ellipsis (its title says it all).

/** The block, under the meters. */
export const ACCOUNT_USAGE_MACHINES_CLASS = 'flex flex-col gap-1 pt-2 border-t border-surface2/80 min-w-0'

/** One machine's row. */
export const ACCOUNT_USAGE_MACHINE_ROW_CLASS = 'flex items-center gap-2 text-xs min-h-[23px] min-w-0'

/** The row's machine name, beside its dot. */
export const ACCOUNT_USAGE_MACHINE_NAME_CLASS = 'w-[104px] shrink-0 flex items-center gap-1.5 text-subtext0 min-w-0'

/** The row's state, and its second line. */
export const ACCOUNT_USAGE_MACHINE_STATE_CLASS = 'flex-1 min-w-0 leading-[1.3] text-subtext1 break-words'

/** The row's "Sign in on <machine>". */
export const ACCOUNT_USAGE_MACHINE_BUTTON_CLASS = 'text-xs px-2 py-px rounded border border-surface2 text-overlay1 whitespace-nowrap truncate max-w-[45%] shrink hover:text-text hover:border-blue/40 transition-colors focus-ring'
