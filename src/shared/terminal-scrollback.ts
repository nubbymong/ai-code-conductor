/**
 * How many lines of scrollback a tab's terminal keeps (xterm.js's
 * `scrollback`, TerminalView.tsx). Keep it at 10000 at most: more costs
 * about 1 GB of memory per terminal (AGENTS.md).
 *
 * The session helper reads it too (session-helper/helper-pty.ts): a terminal
 * shown again from the middle of its output shows no more of the replay than
 * this many lines, less a screen, so the line saying earlier output is not
 * shown stays within what the tab keeps. One constant, so the two cannot
 * drift apart.
 */
export const TERMINAL_SCROLLBACK_LINES = 10_000
