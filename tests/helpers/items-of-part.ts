/**
 * The items part `part` of `parts` holds, by index: the first item goes to
 * part 1, the second to part 2, and so on, round again from part 1. Every
 * item is in exactly one part. A part that does not exist throws, so a
 * broken call fails the file instead of checking nothing.
 *
 * Used by spawn-claude-launcher-lookup-powershell-harness.ts to spread its
 * routes over four test files (which the Windows CI parts run side by side),
 * and tested host-safe in spawn-claude-launcher-lookup-parts.test.ts.
 */
export function itemsOfPart<T>(items: readonly T[], part: number, parts: number): T[] {
  if (!Number.isInteger(parts) || parts < 1 || !Number.isInteger(part) || part < 1 || part > parts) throw new Error(`no part ${part} of ${parts}`)
  return items.filter((_, i) => i % parts === part - 1)
}
