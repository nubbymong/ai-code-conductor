// The gap an Enter typed as its own write keeps from the text before it, on
// its own so a provider package's run screen (providers/claude/run-screen.ts,
// providers/codex/index.ts) can declare the same gap for its held terminals
// without loading the session input module.

/** #333: how long a prompt button's Enter follows the last slice of its text
 *  (index.ts says where the value comes from). Since the 2.1.3-beta.18 fix
 *  round also how long the Watchdog's retry's Enter follows its line in a tab
 *  through the session helper (since PR 763 fix round 9 in every Claude Code
 *  tab), and how long a lone Enter queued while a held
 *  terminal was detached follows the frame before it at the attach: since
 *  2.1.3-beta.19 section 6.2 only a terminal's whose provider declares it
 *  (Claude Code's and Codex's run screens' heldEnterWaitMs;
 *  session-helper/helper-pty.ts asks the run's provider). */
export const PROMPT_ENTER_DELAY_MS = 300
