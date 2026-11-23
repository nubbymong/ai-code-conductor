/**
 * A restored terminal's replay written at its holder's size (2.1.3-beta.15,
 * plan section C8 (planned for beta.14), aicc_planning#392).
 *
 * A Windows console's output is right only at the size it was made for. A
 * restored tab that does not reach its holder's size within the size wait's
 * cap (its window changed size between the two runs) is told, on its own
 * channel (ptyReplayAtHolderSizeChannel), the holder's size and the length of
 * its next output chunk, which is that replay. The tab's terminal takes that
 * size for the chunk, writes it, and is fitted to the tab once it is parsed;
 * the tab then gives main its size, and the holder hears it only then
 * (main/session-helper/helper-pty.ts). Any other chunk is written as it comes.
 */

/** The most columns or rows a size here may have: the helper protocol's own
 *  bound on a terminal's size (LAUNCH_LIMITS.termCells). */
export const REPLAY_SIZE_MAX = 1000

export interface ReplayAtHolderSize {
  /** The holder's size, which the tab's terminal takes for the chunk. */
  cols: number
  rows: number
  /** The chunk's length, as a string's length: the tab's next chunk is the
   *  replay only when it is this long. */
  length: number
}

/** A notice as the tab reads it: whole numbers, the size within
 *  REPLAY_SIZE_MAX, the length at least 1; anything else is none. */
export function readReplayAtHolderSize(value: unknown): ReplayAtHolderSize | null {
  if (typeof value !== 'object' || value === null) return null
  const { cols, rows, length } = value as Record<string, unknown>
  const isCells = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= REPLAY_SIZE_MAX
  if (!isCells(cols) || !isCells(rows)) return null
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 1) return null
  return { cols, rows, length }
}
