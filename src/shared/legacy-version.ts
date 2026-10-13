/**
 * Strict semver validation for managed ("legacy") Claude CLI versions.
 *
 * SECURITY CONTROL. A `version` string becomes both:
 *   - a filesystem path segment: <resources>/claude-versions/<version>/
 *   - a value shell-interpolated into
 *     `npm install @anthropic-ai/claude-code@<version>` (spawn with shell:true).
 *   No launch starts a binary from that folder: a version pinned in an older
 *   release is not used (2.1.1-beta.3; see LEGACY_PIN_NOT_USED below).
 *
 * Strict semver guarantees the value has no path separators, no `..`, no shell
 * metacharacters, and always starts with a digit (so it can never be parsed as
 * an npm `-flag`). This single check closes the path-traversal sink in
 * legacy-version-manager AND the npm-arg / shell-interpolation injection sink.
 *
 * Mirrors the official semver.org regex, with a defensive length cap. JS `$`
 * (no `m` flag) does not match before a trailing newline, so embedded/trailing
 * newlines are rejected too.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export function isValidLegacyVersion(version: unknown): version is string {
  return typeof version === 'string' && version.length > 0 && version.length <= 64 && SEMVER.test(version)
}

/**
 * What the log says when a launch's saved config carries a Claude Code
 * version pinned in an older release (2.1.1-beta.3). Such a pin is no longer
 * used to launch: an interactive session (fresh, through the resume list, an
 * exact resume, a Restart) and a cloud agent all start the installed Claude
 * Code, as a config with no pin does, and nothing is installed for the pin.
 * The pin stays in the saved config, untouched. Plain ASCII; names no path.
 */
export const LEGACY_PIN_NOT_USED = 'A Claude Code version pinned in an older release is no longer used; starting the installed Claude Code'
