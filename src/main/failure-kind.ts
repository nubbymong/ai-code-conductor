// What a log line says about a file that did not read or was not saved: the
// kind of failure, never the error's own text. One copy for the stores that
// keep to that rule (github/github-config-store.ts, platform-config-store.ts).

/**
 * The kind of a failure, for a log line: `not valid JSON` for a parse error,
 * otherwise the error's name and, when it has one, its errno code
 * (`Error EBUSY`).
 *
 * Never the error's own text. A JSON error's text quotes the characters
 * around the place the parse stopped, which can be part of what the file
 * holds, and a file error's text carries the full path, which is under the
 * home folder and so names the account. The kind is also what tells one
 * failure from the next for a once-per-kind log.
 */
export function failureKind(err: unknown): string {
  if (err instanceof SyntaxError) return 'not valid JSON'
  const e = err as { name?: unknown; code?: unknown } | null
  // An error's name and errno code are short words (Error, EBUSY); anything
  // else in their place is left out.
  const word = (v: unknown): string | null =>
    typeof v === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : null
  const name = word(e?.name) ?? 'Error'
  const code = word(e?.code)
  return code ? `${name} ${code}` : name
}
