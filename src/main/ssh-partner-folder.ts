// #86: the partner shell of an SSH session opens in the config's remote
// folder, as the session itself does.
//
// The partner is a plain connection (shell-only, no post-connect command, no
// persistence), so the SSH flow's own setup line, which ends in the `cd` the
// session gets, never runs for it. Instead, once the partner reaches its first
// shell prompt, pty-manager types this one line into it.
//
// What keeps it safe to type:
//   - only for a partner (the `<session id>-partner` PTY id, shell-only); a
//     terminal-only SSH session opens at home, as it always has;
//   - the folder is the saved config's for a config-bound partner (main binds
//     the partner's block to the saved config before it spawns,
//     spawn-credential-binding.ts), and on every spawn path it is limited to
//     what the remote `cd` of the session's own setup line accepts (the ssh
//     schema's charset, then the same check as ssh-shim's
//     assertSafeRemotePath, PARTNER_SAFE_REMOTE_PATH_RE below: letters,
//     digits, "_", ".", "/", "-", "~"), so it is never more than a path; `--`
//     keeps a path that starts with "-" an operand;
//   - not for a Windows host (the line is POSIX sh), nor for home itself.
// pty-manager types it only when the partner reaches its shell by a prompt
// match: a read that ends in a shell prompt (partnerPromptTail,
// PARTNER_PROMPT_RE) with no sign-in word in that prompt or in the partner's
// recent output (partnerRecentText; isPartnerShellPrompt), and from a
// password the flow typed itself on, more than a bare sigil
// (PARTNER_BARE_PROMPT_RE). Reaching the shell through the idle fallback
// types nothing. See its first-prompt step. And only before the user types
// anything into the partner: their first key (isPartnerUserInput) gives the
// line up for that connection, so it never lands on a line they are typing
// and the partner stays where they are.
import { isPartnerPtyId } from '../shared/multi-spawn-rule'
import { stripAnsiForSentinel } from './ansi-strip'

/** What a remote folder may be made of for the partner's folder line: the
 *  set the session's own setup line accepts for its `cd` (ssh-shim.ts
 *  assertSafeRemotePath): letters, digits, "_", ".", "/", "-", "~". Written
 *  out here rather than imported: this module is not part of a provider
 *  package, and a shared module reaching into the Claude package breaks the
 *  package boundaries (tests/wp1/dependency-boundaries.test.ts R2 and R4).
 *  pty-ssh-partner-folder.test.ts pins the two checks to agree. */
const PARTNER_SAFE_REMOTE_PATH_RE = /^[~A-Za-z0-9_./-]+$/

/** A shell prompt, for the partner's folder line only: the session's own
 *  pattern (`$`, `#`, `>`, `~` at the end) plus zsh's `%` as macOS's default
 *  prompt draws it ("nick@mac ~ % "): alone, or after a space or tab. A `%`
 *  right after other text is a percentage ("45%", a banner's "logged 100%"),
 *  not a prompt. Kept apart from the session's pattern, which drives every
 *  other stage of the SSH flow and is unchanged. A prompt whose last character
 *  is none of `$ # > ~ %` (a theme that ends in a glyph such as an arrow, or
 *  draws a clock on the right of the line) is not recognised, and that partner
 *  opens at home. Accepted: so is a zsh prompt that draws its `%` right after
 *  other text, as zsh's own fallback prompt does ("box% ") and some
 *  distributions' do ("[dev@box]~% "). Also accepted: output that ends in
 *  `$ # > ~`, or in a `%` after a space ("45 %"), still reads as a prompt. */
export const PARTNER_PROMPT_RE = /(?:[$#>~]|(?:^|\s)%)\s*$/

/** A prompt reading that is nothing but the sigils `$ # > %` ("> ", "$ ",
 *  "# "): no user, host or folder in it (a `~` is a folder, so "~ $ " is more
 *  than this). From the password prompt the flow answers itself, whose words
 *  are not read for the sign-in check (pty-manager starts the partner's
 *  recent output again there), until the partner reaches its shell, such a
 *  prompt is no prompt match: it may be a second sign-in step that named its
 *  words only before the password prompt. So a host whose shell prompt, as
 *  the partner reads it, is only such a sigil opens its partner at home after
 *  a saved password: the prompt never brings the line, the partner reaches its
 *  shell by the session's own prompt pattern or the idle fallback with nothing
 *  typed, and a key the user types before then gives the line up. */
export const PARTNER_BARE_PROMPT_RE = /^[$#>%\s]+$/

/** A sign-in, verification or key-passphrase prompt, whatever character it
 *  ends in: a password (or passwd, passphrase, passcode), a one-time,
 *  verification or authenticator code, an OTP, TOTP, token, PIN, 2FA or MFA
 *  prompt. Tested on the prompt reading and on the partner's recent output
 *  (partnerRecentText): the prompt's line, read across reads, and the line
 *  above it. So it also refuses a prompt a read boundary split ("Enter pass"
 *  then "word> ") and one whose words sit on the line above a bare prompt
 *  ("Enter your one-time password", then "> "). Words two lines or more
 *  above the prompt, or more than 300 characters back, are not read, and
 *  neither is anything up to and including a password prompt the flow
 *  answers itself with a saved password; from then until the partner
 *  reaches its shell, a bare prompt is refused instead
 *  (PARTNER_BARE_PROMPT_RE), and a prompt with more than a sigil in it that
 *  names none of these words is a prompt match (the word-list gap below).
 *  The shape check above lets through any of these prompts that ends in
 *  `$ # > ~` or `%` (a `%` alone or after a space): "Enter OTP> ", "Enter
 *  password > ". The session's own password pattern needs `:` or `?` last,
 *  so it can never refuse one the shape check let through. Word-bounded
 *  where a short word could sit inside a longer one (`tokens`, `pine64`).
 *  Accepted: a shell prompt that itself names one of these words (a host
 *  called `pin`), or whose line above names one (a notice that a password
 *  expires soon, or a password prompt answered by hand on a host that prints
 *  nothing before its prompt), is refused too, and that partner opens at
 *  home, as one whose prompt is not recognised does. Also accepted, the
 *  other way: this is a word list, so a prompt that ends in `$ # > ~` or `%`
 *  (a `%` alone or after a space) and names none of these words is taken for
 *  a shell prompt and gets the folder line, for example a host menu ("Select
 *  target host [1-3]> "), a REPL, or a code prompt in other words ("Enter
 *  the 6-digit code> ", "Response> "). Typing only at a prompt match does
 *  not close that: those prompts are prompt matches. */
export const PARTNER_SIGN_IN_RE = /pass(?:word|wd|phrase|code)|verif(?:y|ication)|authenticat|one[- ]?time|\b(?:otp|totp|token|pin|2fa|mfa)\b|\b(?:enter|security|access|auth|sms|email|backup|recovery)\s+(?:your\s+|the\s+)?code\b/i

/** Whether the partner's prompt reading (partnerPromptTail) is a shell prompt
 *  its folder line may be typed into: a shell prompt's shape
 *  (PARTNER_PROMPT_RE), and no sign-in words (PARTNER_SIGN_IN_RE) in the
 *  reading or in the partner's recent output (partnerRecentText; the reading
 *  alone when none is given). False for '' (no reading yet). */
export function isPartnerShellPrompt(tail: string, recent: string = tail): boolean {
  return PARTNER_PROMPT_RE.test(tail) && !PARTNER_SIGN_IN_RE.test(tail) && !PARTNER_SIGN_IN_RE.test(recent)
}

/** How much of the partner's raw output is kept for its sign-in check, escape
 *  sequences included: far more than two lines of any real prompt need. */
const PARTNER_RECENT_RAW_MAX = 4096
/** How much of the partner's recent text its sign-in check reads, the newest
 *  kept: about two lines. */
const PARTNER_RECENT_TEXT_MAX = 300

/** The partner's raw output so far with this read added, the newest
 *  PARTNER_RECENT_RAW_MAX characters kept. Kept raw, not stripped, so an
 *  escape sequence a read boundary cut is stripped whole once it ends. */
export function partnerRecentOutput(prev: string, data: string): string {
  const all = prev + data
  return all.length > PARTNER_RECENT_RAW_MAX ? all.slice(all.length - PARTNER_RECENT_RAW_MAX) : all
}

/** What the partner's sign-in check reads of its recent raw output
 *  (partnerRecentOutput): escapes stripped, the last two lines (the prompt's
 *  own line and the one above it), each run of spaces or tabs counted once
 *  (zsh fills the line before its prompt with a screen width of spaces), then
 *  the newest PARTNER_RECENT_TEXT_MAX characters. A prompt a read boundary
 *  split is whole here. */
export function partnerRecentText(raw: string): string {
  const lines = stripAnsiForSentinel(raw).split('\n')
  const text = lines.slice(-2).join('\n').replace(/[ \t]+/g, ' ')
  return text.length > PARTNER_RECENT_TEXT_MAX ? text.slice(text.length - PARTNER_RECENT_TEXT_MAX) : text
}

/** A prompt is a short line: a tail this long or longer is not one. */
const PARTNER_TAIL_MAX = 200

/** The partner's own reading of the prompt a PTY chunk ends in, for the folder
 *  line's guard only. The chunk's last line, escapes stripped; of that, only
 *  the text after its last carriage return that still holds something. A
 *  shell that repaints the line before its prompt, as zsh does by default
 *  (its end-of-line mark, then a screen width of spaces, then `\r \r`, then
 *  the prompt) and fish does too, so reads as the prompt it ends in, however
 *  wide the window. The session's own reading (lastPromptLineForClaude) takes
 *  the whole line and drops one of 200 characters or more, which on a wide
 *  window is exactly that repainted line. '' for a chunk that ends in no text
 *  (a bare line break, a pure repaint) or in a tail of 200 characters or more;
 *  such a read is no prompt match. */
export function partnerPromptTail(data: string): string {
  const line = stripAnsiForSentinel(data.slice(data.lastIndexOf('\n') + 1))
  const parts = line.split('\r')
  for (let i = parts.length - 1; i >= 0; i--) {
    const tail = parts[i].trim()
    if (tail !== '') return tail.length < PARTNER_TAIL_MAX ? tail : ''
  }
  return ''
}

/** What the terminal sends into the session on its own, answering the remote,
 *  through the same input path as the user's keys: a device-attributes reply,
 *  a status or cursor-position report, a mode, window-size or keyboard-flags
 *  report, a colour or other OSC reply, a DCS reply (the terminal's version, a
 *  setting), and the focus-in and focus-out reports. */
const PARTNER_TERMINAL_REPLY_RE = /\x1b\[(?:[?>][\d;]*c|\d+n|\??\d+;\d+(?:;\d+)?R|\??\d+;\d+\$y|\d+(?:;\d+)*t|\?\d*u|[IO])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g

/** Whether a write into the partner is the user's input, which gives its
 *  folder line up: anything but the terminal's own replies to the remote
 *  (PARTNER_TERMINAL_REPLY_RE), alone or several together. Keys, Enter,
 *  control keys, arrows (Up recalls a history line), a paste and a mouse
 *  report all count, and so does a reply with anything else in the same
 *  write. Accepted: the terminal sends F3 with a modifier (Shift+F3 and so
 *  on) as the same bytes as a cursor-position report, so that key does not
 *  count. */
export function isPartnerUserInput(data: string): boolean {
  return data.replace(PARTNER_TERMINAL_REPLY_RE, '') !== ''
}

/** The line to type into an SSH session's partner shell at its first prompt,
 *  Enter included, or null when nothing is typed. */
export function partnerFolderLine(
  sessionId: string,
  opts: { shellOnly?: boolean } | undefined,
  ssh: { remotePath?: string; remoteOs?: string },
): string | null {
  if (opts?.shellOnly !== true || !isPartnerPtyId(sessionId)) return null
  if (ssh.remoteOs === 'windows') return null
  const path = typeof ssh.remotePath === 'string' ? ssh.remotePath : ''
  if (path === '' || path === '~' || path === '~/') return null
  if (!PARTNER_SAFE_REMOTE_PATH_RE.test(path)) return null
  return `cd -- ${path}\r`
}
