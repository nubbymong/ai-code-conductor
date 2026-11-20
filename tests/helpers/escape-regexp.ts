/**
 * A fixed text (a call, a selector, an item ID) made safe to put in a RegExp
 * pattern: every character a pattern reads specially is escaped, so the
 * pattern matches the text as itself. These are all the special characters
 * outside a character class, and each is a syntax character, so the result is
 * also valid under the `u` flag. Escaping only some of them (only the dots, say)
 * is the shape code scanning flags as an incomplete sanitization.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
