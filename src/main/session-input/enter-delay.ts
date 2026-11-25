// The gap an Enter typed as its own write keeps from the text before it, on
// its own so the session helper's terminal (session-helper/helper-pty.ts) can
// keep the same gap without loading the session input module.

/** #333: how long a prompt button's Enter follows the last slice of its text
 *  (index.ts says where the value comes from). Since the 2.1.3-beta.18 fix
 *  round also how long the Watchdog's retry's Enter follows its line in a tab
 *  through the session helper, and how long a lone Enter queued while a held
 *  terminal was detached follows the frame before it at the attach. */
export const PROMPT_ENTER_DELAY_MS = 300
