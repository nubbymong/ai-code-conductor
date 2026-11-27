/**
 * The fixed scripts remote step 1 runs on a Linux host (2.1.3-beta.17, plan
 * section A2; docs/remote/helper-protocol.md sections 1, 4, 6 and 13).
 *
 * Each one runs as `/bin/sh -c '<script>' aicc <values...>`. ssh joins those
 * words into one string the host's login shell parses, so the script text
 * holds no single quote, backslash or line end (checked when this module
 * loads), and every value is checked against its own alphabet here, before
 * ssh starts. No value a host reported is put on a command line: every path
 * is built from `$HOME` in the script.
 *
 * Every script first checks, before it writes, runs or deletes anything:
 * the device id's shape; that `$HOME` is an absolute real folder (not a link,
 * not `/`) owned by the user, and that neither it nor any folder above its
 * real path can be written by its group or by others (each owned by the user
 * or root); then, but for the probe and the install (which may make them),
 * that `~/.aicc` and `~/.aicc/<did>` are real folders the user owns with mode
 * 0700, and that the `owner` marker holds this install's ids. Owner and mode
 * come from `ls -ldn` against `id -u`. A failed check prints
 * `AICC-RESULT <nonce> end refused <reason>` and changes nothing.
 *
 * A script reports in marked lines, `AICC-RESULT <nonce> <key> <value>`, and
 * ends with `AICC-RESULT <nonce> end ok` (or `end refused <reason>`). Script
 * text with no quote or backslash cannot write JSON, so these results are
 * words, not section 6's JSON; the helper's own commands (the self-test)
 * still print theirs. The launcher scripts (version, selftest, list, hold,
 * bridge, sweep and, from 2.1.3-beta.19, field and sessions) hash the helper's
 * file before every start and print section 13's
 * `AICC-HASH <nonce> <state> <hex>` line, and run the helper only on `ok`.
 *
 * Layout (section 1): `~/.aicc/<did>/owner` (the marker),
 * `~/.aicc/<did>/helper/<version>-<hash12>/aicc-helper` (0700, never on PATH),
 * `~/.aicc/<did>/store` (the holders' records; the helper makes it 0700). A
 * new file is written to `helper/.new-<nonce>/` first and moved into its
 * folder only once the app has compared its hash with the installer's
 * manifest (commit), or removed (discard). An earlier build's folder is not
 * removed by the commit that installs this build's (a kept session runs the
 * helper its launch named): a Check's `sweep` removes it once no holder has a
 * record in the store, at that same Check when none is held then, else at a
 * later one (2.1.3-beta.19). From 2.1.3-beta.18 (plan section
 * 3.2) `~/.aicc/<did>/sessions/<sid>/` (0700) holds one session's own files,
 * which its provider's launch gives (`files`): written before its launch,
 * removed at its end (`unsession`), and by the next Check once its holder is
 * gone (`sweep`). From 2.1.3-beta.19 (section 6.3) the list of kept sessions
 * the app takes at start-up and when the Machines page opens (`sessions`)
 * removes them too, so a folder a quit leaves goes at the next start.
 *
 * From 2.1.3-beta.20 (section 3, Sign in on this machine) each account
 * signed in on the machine has a folder of its own,
 * `~/.aicc/accounts/<profile id>/` (0700, beside the device folders: an
 * account's sign-in is the machine user's, not one install's), which is the
 * CLI's config folder for that account: its sign-in files are its own, and
 * the provider's shared folders and files are links into the CLI's own
 * folder in the home folder (`~/.claude`), never anywhere else. A marker
 * (`.aicc-account`, `aicc-account 1 <profile id> <install id>`) says which
 * install of the app made it; no script reads or removes a folder there
 * without this install's, and another computer's is left as it is
 * (2.1.3-beta.20 fix round, MAJOR-1). `account` makes or
 * refreshes one (its links, and its settings copy from standard input),
 * `accounts` reads every sign-in there and the machine's own through the
 * helper's field mode (only the fields on its list), and `signout` runs the
 * CLI's own sign-out in one, then removes that folder only. Besides
 * `~/.aicc`, the only writes are the shared folders `account` makes in
 * `~/.claude` when one is missing (as the CLI would make it), and what the
 * CLI's own sign-out changes.
 */
import { APP_PTY_ID_RE, HELPER_FOLDER_RE, NONCE_RE, SHA256_RE, SID_RE } from '../session-helper/protocol'

/** A device id (section 1): 32 random lower-case hex characters. */
export const DID_RE = /^[0-9a-f]{32}$/
/** This app install's id: 32 lower-case hex characters. */
export const INSTALL_ID_RE = /^[0-9a-f]{32}$/
/** A size in bytes: a plain decimal of at most 9 digits (under 1 GB). */
const SIZE_RE = /^[1-9][0-9]{0,8}$/
/** A holder's label: an app session id that starts with a letter or digit. */
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** The away clock a holder of a remote session gets (section 15's default). */
export const REMOTE_AWAY_SECS = 120

/** A holder's kind, as the hold script takes it (2.1.3-beta.19 section 1.2):
 *  `away`, a plain SSH tab's, with the away clock (REMOTE_AWAY_SECS); or
 *  `until-ended`, an SSH Persistent tab's, which no clock ends: it ends with
 *  its CLI, at term.end, or with the host (section 1.1's `--until-ended`). */
export type HolderKind = 'away' | 'until-ended'
export const HOLDER_KIND_RE = /^(away|until-ended)$/

// ── the parts ────────────────────────────────────────────────────────────────

/** The checks every script makes first (the module comment). `N`, `D` and `I`
 *  are set before it from the first three values. */
const CHECKS = [
  'set -f',
  'u=$(id -u)',
  'r() { echo "AICC-RESULT $N $*"; }',
  'no() { r end refused "$1"; exit 0; }',
  'pv() { set -- $(ls -ldn "$1" 2>/dev/null); [ "$3" = "$u" ] || return 1; case "$1" in drwx------|drwx------.) return 0;; esac; return 1; }',
  'case "$D" in *[!0-9a-f]*|"") no bad-device-id;; esac',
  '[ ${#D} -eq 32 ] || no bad-device-id',
  'case "$HOME" in /*) ;; *) no home-not-absolute;; esac',
  '[ "$HOME" != / ] || no home-is-root',
  '[ -d "$HOME" ] && [ ! -L "$HOME" ] || no home-not-a-folder',
  'h=$(cd "$HOME" && pwd -P) || no home-not-a-folder',
  'set -- $(ls -ldn "$h"); [ "$3" = "$u" ] || no home-not-yours',
  'd=$h; while :; do set -- $(ls -ldn "$d"); case "$1" in ?????w*|????????w*) no home-open-to-others;; esac; [ "$3" = "$u" ] || [ "$3" = 0 ] || no home-folder-owner; [ "$d" = / ] && break; d=$(dirname "$d"); done',
  'A=$HOME/.aicc/$D',
  'mk() { [ -f "$A/owner" ] && [ ! -L "$A/owner" ] && [ "$(cat "$A/owner" 2>/dev/null)" = "aicc-owner 1 $D $I" ]; }',
]

/** The device folder is there, private, and this install's. */
const EXISTING = [
  'pv "$HOME/.aicc" || no aicc-folder-not-private',
  'pv "$A" || no device-folder-not-private',
  'mk || no not-this-install',
]

/** `x` = the SHA-256 of "$P" in 64 lower-case hex, or empty when no tool
 *  (sha256sum, shasum, openssl, in that order) gave one. */
const HASH_OF_P = [
  'x=',
  'if command -v sha256sum >/dev/null 2>&1; then set -- $(sha256sum "$P" 2>/dev/null); x=$1; elif command -v shasum >/dev/null 2>&1; then set -- $(shasum -a 256 "$P" 2>/dev/null); x=$1; elif command -v openssl >/dev/null 2>&1; then for w in $(openssl dgst -sha256 "$P" 2>/dev/null); do x=$w; done; fi',
  'case "$x" in *[!0-9a-f]*) x=;; esac',
  '[ ${#x} -eq 64 ] || x=',
]

/** The launcher (section 13): the helper's file is hashed before every start,
 *  and run only when its hash is the one the app gave (`H`). `F` is its
 *  folder. Nothing it prints before the hash line is the helper's. */
const LAUNCH = [
  ...EXISTING,
  'case "$F" in */*|.*|"") no bad-helper-folder;; esac',
  'P=$A/helper/$F/aicc-helper',
  '[ -f "$P" ] && [ ! -L "$P" ] || { echo "AICC-HASH $N missing"; exit 97; }',
  ...HASH_OF_P,
  '[ -n "$x" ] || { echo "AICC-HASH $N no-tool"; exit 97; }',
  '[ "$x" = "$H" ] || { echo "AICC-HASH $N mismatch $x"; exit 97; }',
  'echo "AICC-HASH $N ok $x"',
]

/** Remove's one delete: the device folder, by the host's own home variable and
 *  the device id, each required to be set and not empty. A list of its own so
 *  the profile-home guard in tests/wp1/managed-launch.test.ts can name this one
 *  line: it reads the home of the host's account in a shell script and composes
 *  no environment. */
const DELETE_DEVICE_FOLDER = [
  'rm -rf -- "${HOME:?}/.aicc/${D:?}" || no cannot-remove',
]

/** The end's one delete (2.1.3-beta.18 section 3.2): one session's own folder,
 *  by the device folder and the session id, each required to be set and not
 *  empty, once it is found a real folder of the user's, mode 0700. */
const DELETE_SESSION_FOLDER = [
  'rm -rf -- "${A:?}/sessions/${X:?}" || no cannot-remove',
]

/** The sweep's guarded delete (2.1.3-beta.18 section 3.2; `sessions` and
 *  `sweep` both end with it, 2.1.3-beta.19 section 6.3): every session folder
 *  whose holder has no record goes, each a real folder of the user's, mode
 *  0700, by a name of the session id's own characters; one whose holder runs
 *  is kept. One copy, so the rule of which folder may go is set in one place. */
const SWEEP_GONE_FOLDERS = [
  'S=$A/sessions; c=0',
  '[ -d "$S" ] && [ ! -L "$S" ] || { r swept 0; r end ok; exit 0; }',
  'pv "$S" || no sessions-folder-not-private',
  'for X in $(ls -A "$S"); do case "$X" in *[!A-Za-z0-9_-]*|"") continue;; esac; [ -e "$A/store/$X.json" ] && continue; pv "$S/$X" || continue; rm -rf -- "${A:?}/sessions/${X:?}" && c=$((c+1)); done',
  'r swept $c',
  'r end ok',
]

/** At a Check only (`sweep`, 2.1.3-beta.19): the helper folders of earlier
 *  builds (`helper/<version>-<hash12>/`, which the commit that installed this
 *  build's left in place) go, but only while the store holds no holder's
 *  record, nor one being written. A kept session's CLI runs the helper by the
 *  path its launch wrote (its status line, hooks and MCP server), so while any
 *  holder has a record none goes, and a later Check takes them; list mode has
 *  just removed the records of holders that are gone. Never this build's
 *  folder (`F`), a staging `.new-*` folder, a link, or a name of other
 *  characters, and nothing outside `helper/`; a folder holding more than its
 *  helper file loses that file and stays. The scripts run with globbing off
 *  (`set -f`), so the store is read by `ls`, and a store that is not a real
 *  folder, or does not read, counts as holding a record. */
const SWEEP_EARLIER_HELPERS = [
  'h=0; k=0; l=',
  'if [ -e "$A/store" ] || [ -L "$A/store" ]; then { [ -d "$A/store" ] && [ ! -L "$A/store" ] && l=$(ls -A "$A/store"); } || k=1; fi',
  'for R in $l; do case "$R" in *.json|*.json.*) k=1;; esac; done',
  'if [ "$k" = 0 ]; then for V in $(ls -A "$A/helper"); do [ "$V" = "$F" ] && continue; case "$V" in .*|*[!0-9A-Za-z.-]*|"") continue;; esac; [ -d "$A/helper/$V" ] && [ ! -L "$A/helper/$V" ] || continue; rm -f -- "${A:?}/helper/${V:?}/aicc-helper"; rmdir -- "${A:?}/helper/${V:?}" 2>/dev/null && h=$((h+1)); done; fi',
  'r helpers $h',
]

/** A file a launch reads on the host, at most (2.1.3-beta.18 section 3.2). */
export const HOST_READ_MAX = 256 * 1024

/**
 * The host reads' checks (2.1.3-beta.18 section 3.2). `ow` answers 0 for a
 * path that is the user's own and not writable by others, and writable by
 * its group only when that group is the user's own per-user group (the
 * primary group, numbered as the user id), the rule
 * hooks/session-hooks-writer.ts notPrivateWhy applies to a project file on
 * this computer; 1 for another user's; 2 for one others may write. `ab`: the
 * first folder is the second or a folder above it.
 */
const OWN = [
  'g=$(id -g)',
  'ow() { set -- $(ls -ldn "$1" 2>/dev/null); [ "$3" = "$u" ] || return 1; case "$1" in ????????w*) return 2;; ?????w*) [ "$4" = "$g" ] && [ "$g" = "$u" ] || return 2;; esac; return 0; }',
  'ab() { [ "$1" = / ] && return 0; case "$2/" in "$1"/*) return 0;; esac; return 1; }',
]

/**
 * `cr` sets `K` to the root of the git checkout the session folder (`w`) is
 * in, whose local settings Claude Code also reads, or leaves it empty: the
 * rule the usual SSH setup applies on the host (providers/claude/ssh-shim.ts)
 * and ../git-local-settings-root.ts on this computer. git is asked in the
 * session folder with every GIT_ variable removed and discovery across
 * filesystems allowed. A `.git` folder or file strictly below git's top
 * level, nearest the session folder, is the root instead; a linked worktree
 * is followed to its main checkout only when its git folder sits in the
 * common folder's `worktrees` and its `gitdir` file points back at the
 * worktree's `.git`. No root when it is the session folder, the home folder
 * or a folder above it, or when it, its `.git` or its `.claude` is another
 * user's.
 */
const CHECKOUT_ROOT = [
  'gw() { (cd "$w" && git rev-parse "$1" </dev/null 2>/dev/null); }',
  'cr() { command -v git >/dev/null 2>&1 || return 0',
  'for v in $(env | cut -d= -f1 | grep -E "^GIT_[A-Za-z0-9_]+$"); do unset "$v"; done',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM=1; export GIT_DISCOVERY_ACROSS_FILESYSTEM',
  't=$(gw --show-toplevel) || return 0',
  't=$(cd "$t" 2>/dev/null && pwd -P) || return 0',
  '[ -n "$t" ] && ab "$t" "$w" || return 0',
  'gd=$(gw --git-dir); gc=$(gw --git-common-dir)',
  'case "$gd" in /*) ;; ?*) gd=$w/$gd;; esac; case "$gc" in /*) ;; ?*) gc=$w/$gc;; esac',
  '[ -n "$gd" ] && gd=$(cd "$gd" 2>/dev/null && pwd -P)',
  '[ -n "$gc" ] && gc=$(cd "$gc" 2>/dev/null && pwd -P)',
  'R=$t; d=$w',
  'while [ "$d" != "$t" ]; do if [ ! -L "$d/.git" ] && { [ -d "$d/.git" ] || [ -f "$d/.git" ]; }; then R=$d; break; fi; [ "$d" = / ] && break; d=$(dirname "$d"); done',
  'z=0',
  'if [ "$R" = "$t" ] && [ -n "$gd" ] && [ -n "$gc" ] && [ "$gd" != "$gc" ] && [ "$(dirname "$gd")" = "$gc/worktrees" ] && [ -f "$gd/gitdir" ] && [ ! -L "$gd/gitdir" ]; then q=$(wc -c < "$gd/gitdir"); q=$((q+0)); if [ $q -le 4096 ]; then q=$(cat "$gd/gitdir"); case "$q" in /*) ;; *) q=$gd/$q;; esac; qd=$(cd "$(dirname "$q")" 2>/dev/null && pwd -P); [ "$qd/$(basename "$q")" = "$t/.git" ] && z=1; fi; fi',
  'if [ $z = 1 ]; then case "$gc" in */.git) R=$(dirname "$gc");; *) [ -e "$gc/.git" ] || [ -L "$gc/.git" ] || return 0;; esac; fi',
  '[ "$R" != "$w" ] || return 0',
  'ab "$R" "$h" && return 0',
  'set -- $(ls -ldn "$R" 2>/dev/null); [ "$3" = "$u" ] || return 0',
  'set -- $(ls -ldn "$R/.git" 2>/dev/null); [ "$3" = "$u" ] || return 0',
  'if [ -e "$R/.claude" ] || [ -L "$R/.claude" ]; then set -- $(ls -ldn "$R/.claude" 2>/dev/null); [ "$3" = "$u" ] || return 0; fi',
  'K=$R; }',
]

/**
 * `one <i> <base> <path>`: the host read `i`, `path` under `base`. Prints
 * `f<i> ok <hex>` (its bytes as lower-case hex), or `f<i> skip <why>` for one
 * that is there and is not taken; nothing for one that is not there. Either
 * way the file must be a regular one of at most HOST_READ_MAX bytes (`type`,
 * `size`).
 *
 * The user's own file (`hm` = 1, a `home` read) is read as Claude Code reads
 * it, and as hooks/session-hooks-writer.ts resolveInheritedHooks and the
 * usual SSH setup (providers/claude/ssh-shim.ts) read it: links followed, so
 * a settings file or a `~/.claude` that is a dotfiles link (stow, chezmoi,
 * Home Manager) keeps its hooks in the session's settings. A project file
 * (`cwd`, `checkout`: a repository controls it) is taken only when every
 * folder on the way and the file are no link (`link`) and pass `ow` (`owner`,
 * `mode`).
 */
const ONE_READ = [
  'sk() { r "f$1" skip "$2"; }',
  'one() { j=$1; x=$2; if [ $hm = 1 ]; then x=$x/$3; [ -e "$x" ] || return 0; [ -f "$x" ] || { sk $j type; return 0; }; else IFS=/; set -- $3; IFS=$o',
  'while [ $# -gt 0 ]; do x=$x/$1; shift; if [ -L "$x" ]; then sk $j link; return 0; fi; [ -e "$x" ] || return 0; if [ $# -gt 0 ]; then [ -d "$x" ] || { sk $j type; return 0; }; else [ -f "$x" ] || { sk $j type; return 0; }; fi; ow "$x"; e=$?; if [ $e = 1 ]; then sk $j owner; return 0; fi; if [ $e != 0 ]; then sk $j mode; return 0; fi; done; fi',
  `n=$(wc -c < "$x"); n=$((n+0)); [ "$n" -le ${HOST_READ_MAX} ] || { sk $j size; return 0; }`,
  'r "f$j" ok "$(od -A n -v -t x1 "$x" | tr -d "[:space:]")"; }',
]

/** 2.1.3-beta.19 section 3 (aicc_planning#434): a field read's file, a path
 *  relative to the host user's home folder: plain names joined by `/`, none
 *  of them `.` or `..`. */
export const FIELD_FILE_RE = /^(?!\.\.?(?:\/|$))[A-Za-z0-9._-]{1,128}(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._-]{1,128}){0,15}$/
/** A field read's key: plain names joined by `.`. */
export const FIELD_KEY_RE = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,15}$/
/** The most a field read answers: the helper's field mode prints at most 1 KiB. */
export const FIELD_VALUE_MAX = 1024

/** A session's files as the `files` script takes them: `<name>:<size>` for
 *  each, joined by commas, in the order their bytes follow on standard input.
 *  A name never starts with a dot (the script's staging names do). At most
 *  eight files. */
export const FILES_LAYOUT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:(0|[1-9][0-9]{0,8})(,[A-Za-z0-9][A-Za-z0-9._-]{0,63}:(0|[1-9][0-9]{0,8})){0,7}$/

// ── 2.1.3-beta.20 section 3: accounts signed in on the machine ────────────

/** An account's folder name there: its profile id (Q4: never its email), the
 *  app's own shape (shared/profile-id.ts), at most 128 characters. */
export const ACCOUNT_PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,127}$/
/** One plain name in a folder: no `/`, not `.` or `..`, not starting with a
 *  dot unless the provider's own file is (`.claude.json`). */
export const PLAIN_NAME_RE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/
/** Plain names joined by commas, at most 16 (the folder's links). */
export const PLAIN_NAMES_RE = /^(?!\.\.?(?:,|$))[A-Za-z0-9._-]{1,128}(?:,(?!\.\.?(?:,|$))[A-Za-z0-9._-]{1,128}){0,15}$/
/** Field keys joined by commas, at most 8 (the helper's `--keys`). */
export const FIELD_KEYS_RE = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,15}(?:,[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,15}){0,7}$/
/** The variable that names the CLI's config folder. */
export const CONFIG_VAR_RE = /^[A-Z][A-Z0-9_]{0,63}$/
/** The CLI's program name, and its words joined by commas (at most 8). */
export const CLI_WORD_RE = /^[a-z][a-z0-9-]{0,63}$/
export const CLI_WORDS_RE = /^[a-z][a-z0-9-]{0,63}(?:,[a-z][a-z0-9-]{0,63}){0,7}$/
/** `signout`'s profile ids: `-` (none), or 1 to 64 account folder names
 *  joined by commas (Remove names each it signs out). */
export const ACCOUNT_IDS_RE = /^(-|[a-z0-9][a-z0-9-]{0,127}(?:,[a-z0-9][a-z0-9-]{0,127}){0,63})$/
/** `account`'s settings copy: `keep` (left as it is: a sign-in), `0` (none:
 *  removed) or its size in bytes (at most 7 digits; the copy comes from a
 *  host read of at most HOST_READ_MAX bytes). */
export const ACCOUNT_SETTINGS_RE = /^(keep|0|[1-9][0-9]{0,6})$/
/** The marker line an account folder holds: the profile id and the install
 *  that made it (2.1.3-beta.20 fix round, MAJOR-1: two computers of one user
 *  may sign in on the same host login; each touches only its own folders). */
export const accountMarker = (profileId: string, installId: string): string => `aicc-account 1 ${profileId} ${installId}`

/** `am <folder> <profile id>`: the folder is a real folder of the user's,
 *  mode 0700, holding this install's marker for that profile id (a regular
 *  file, not a link; `I` is this install's id). `ao <folder> <profile id>`:
 *  it holds the app's marker for that profile id, by any install: with `am`
 *  false, the folder is another computer's, left as it is. */
const ACCOUNT_MARK = [
  'am() { pv "$1" && [ -f "$1/.aicc-account" ] && [ ! -L "$1/.aicc-account" ] && [ "$(head -c 200 "$1/.aicc-account" 2>/dev/null)" = "aicc-account 1 $2 $I" ]; }',
  'ao() { pv "$1" && [ -f "$1/.aicc-account" ] && [ ! -L "$1/.aicc-account" ] && case "$(head -c 200 "$1/.aicc-account" 2>/dev/null)" in "aicc-account 1 $2 "*) return 0;; esac; return 1; }',
]

/** Sign out's one delete (section 3.1.8): one account's folder, by the
 *  accounts folder (`B`, set from the host's own home variable as
 *  `$HOME/.aicc/accounts`) and the profile id, each required to be set and
 *  not empty, once the id has its shape and the folder holds the app's
 *  marker for it. A list of its own, as DELETE_DEVICE_FOLDER is. */
const DELETE_ACCOUNT_FOLDER = [
  'rm -rf -- "${B:?}/${P:?}" || no cannot-remove',
]

const join = (parts: readonly string[]): string => parts.join('; ')

/** 2.1.3-beta.19 section 1.2: the probe's three reads of whether logind ends
 *  the user's processes at logout, as helper/probes/p3-p6-linux.cjs reads it
 *  (the manager's KillUserProcesses and KillExcludeUsers, the user's Linger);
 *  each prints '' when it does not read (no loginctl, or no logind). They
 *  only ask (show-session, show-user): no script sets a linger or ends a
 *  session, and no other script names loginctl. */
export const LOGIND_READS: readonly string[] = [
  'r logind-kill "$(loginctl show-session -p KillUserProcesses --value </dev/null 2>/dev/null)"',
  'r logind-exclude "$(loginctl show-session -p KillExcludeUsers --value </dev/null 2>/dev/null)"',
  'r linger "$(loginctl show-user "$(id -un)" -p Linger --value </dev/null 2>/dev/null)"',
]

// ── the scripts ──────────────────────────────────────────────────────────────

/** What a script takes, in order, after its nonce, device id and install id. */
interface ScriptSpec {
  /** The values after N, D and I, each with its pattern. */
  values: ReadonlyArray<{ name: string; re: RegExp }>
  text: string
}

const FOLDER = { name: 'helper folder', re: HELPER_FOLDER_RE }
const HASH = { name: 'expected hash', re: SHA256_RE }
const SESSION = { name: 'session id', re: SID_RE }

const SPECS = {
  /** What the host is (section 1, step 1's part of R3's probe): its OS and
   *  architecture, home, user, login shell, the exec's PATH and LANG, and
   *  where `claude` is: on the exec's PATH, and on the PATH of the user's
   *  login shell started interactive (`-il`), P6's fallback (ADR-030), when
   *  that shell is of the sh family. Writes nothing. */
  probe: {
    values: [],
    text: join([
      'N=$1; D=$2; I=$3',
      ...CHECKS,
      'r os "$(uname -s)"',
      'r arch "$(uname -m)"',
      'r home "$HOME"',
      'r user "$(id -un)"',
      'S=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7); [ -n "$S" ] || S=${SHELL:-/bin/sh}',
      'r shell "$S"',
      'r path "$PATH"',
      'r lang "${LANG:-}"',
      ...LOGIND_READS,
      'r claude "$(command -v claude 2>/dev/null)"',
      // `$` alone, so the PATH and the lookup expand in the login shell, not here.
      'v="$"',
      'case "${S##*/}" in bash|zsh|sh|dash|ksh|mksh|ash|yash) "$S" -ilc "echo AICC-RESULT $N il-path ${v}PATH; echo AICC-RESULT $N il-claude ${v}(command -v claude 2>/dev/null)" </dev/null 2>/dev/null;; esac',
      'r end ok',
    ]),
  },
  /** Section 13's install, its first half: the folders made if missing (and
   *  the marker with them), the file read from standard input into
   *  `helper/.new-<N>/` (exactly `S` bytes), set 0700 and hashed. It reports
   *  the hash (`none` when no tool gave one) and leaves the file there for the
   *  app's commit or discard. */
  install: {
    values: [{ name: 'size', re: SIZE_RE }],
    text: join([
      'N=$1; D=$2; I=$3; S=$4',
      ...CHECKS,
      'umask 077',
      'case "$S" in *[!0-9]*|"") no bad-size;; esac',
      '[ -e "$HOME/.aicc" ] || mkdir "$HOME/.aicc" || no cannot-make-aicc-folder',
      'pv "$HOME/.aicc" || no aicc-folder-not-private',
      'if [ -e "$A" ]; then pv "$A" || no device-folder-not-private; mk || no not-this-install; else mkdir "$A" || no cannot-make-device-folder; echo "aicc-owner 1 $D $I" > "$A/owner" || no cannot-write-owner; fi',
      '[ -e "$A/helper" ] || mkdir "$A/helper" || no cannot-make-helper-folder',
      'pv "$A/helper" || no helper-folder-not-private',
      'T=$A/helper/.new-$N',
      'mkdir "$T" || no busy',
      'P=$T/aicc-helper',
      'head -c "$S" > "$P" 2>/dev/null',
      'n=$(wc -c < "$P"); n=$((n+0))',
      '[ "$n" -eq "$S" ] || { rm -f -- "$P"; rmdir -- "$T"; no short-upload; }',
      'chmod 700 "$P" || { rm -f -- "$P"; rmdir -- "$T"; no cannot-set-mode; }',
      ...HASH_OF_P,
      'r hash "${x:-none}"',
      'r end ok',
    ]),
  },
  /** Section 13's install, its second half: the file the app found equal to
   *  its manifest goes into its folder (`F`); one already there by that name
   *  is replaced. `K` is the install exec's nonce. */
  commit: {
    values: [FOLDER, { name: 'staged nonce', re: NONCE_RE }],
    text: join([
      'N=$1; D=$2; I=$3; F=$4; K=$5',
      ...CHECKS,
      ...EXISTING,
      'case "$F" in */*|.*|"") no bad-helper-folder;; esac',
      'case "$K" in *[!0-9a-f]*|"") no bad-nonce;; esac',
      'T=$A/helper/.new-$K; Q=$A/helper/$F',
      '[ -d "$T" ] && [ ! -L "$T" ] && [ -f "$T/aicc-helper" ] && [ ! -L "$T/aicc-helper" ] || no nothing-staged',
      'if [ -e "$Q" ]; then [ -d "$Q" ] && [ ! -L "$Q" ] || no helper-folder-not-a-folder; rm -f -- "$Q/aicc-helper"; rmdir -- "$Q" || no cannot-replace; fi',
      'mv -- "$T" "$Q" || no cannot-place',
      'r end ok',
    ]),
  },
  /** The upload the app did not take (its hash was not the manifest's) is removed. */
  discard: {
    values: [{ name: 'staged nonce', re: NONCE_RE }],
    text: join([
      'N=$1; D=$2; I=$3; K=$4',
      ...CHECKS,
      ...EXISTING,
      'case "$K" in *[!0-9a-f]*|"") no bad-nonce;; esac',
      'T=$A/helper/.new-$K',
      'rm -f -- "$T/aicc-helper"; rmdir -- "$T" 2>/dev/null',
      '[ -e "$T" ] && no still-there',
      'r end ok',
    ]),
  },
  /** Remove (plan finding 8): deletes only `~/.aicc/<did>`, after reading the
   *  marker with this install's ids, then `~/.aicc` when that is left empty.
   *  A device id that breaks its pattern, or is empty, stops at the first
   *  check; another install's folder stops at the marker. The app asks the
   *  holders first (`list`) and refuses while one runs. Last, the holders' run
   *  folder `/tmp/aicc-<uid>` (helper/src/transport/unix.rs `run_dir`; Add's
   *  self-test makes it) goes when it is the user's, 0700 and empty: rmdir
   *  only, never a recursive delete, since another session of the same
   *  account may hold a socket there. */
  remove: {
    values: [],
    text: join([
      'N=$1; D=$2; I=$3',
      ...CHECKS,
      '[ -e "$A" ] || [ -L "$A" ] || { r gone yes; r end ok; exit 0; }',
      ...EXISTING,
      ...DELETE_DEVICE_FOLDER,
      // 2.1.3-beta.20: the accounts folder too, when Remove's sign-outs left it empty (rmdir only).
      'rmdir -- "$HOME/.aicc/accounts" 2>/dev/null',
      'rmdir -- "$HOME/.aicc" 2>/dev/null',
      'pv "/tmp/aicc-$u" && rmdir -- "/tmp/aicc-$u" 2>/dev/null',
      '[ -e "$A" ] && no still-there',
      'r end ok',
    ]),
  },
  /** `aicc-helper version`, through the launcher. */
  version: {
    values: [FOLDER, HASH],
    text: join(['N=$1; D=$2; I=$3; F=$4; H=$5', ...CHECKS, ...LAUNCH, 'exec "$P" version']),
  },
  /** `aicc-helper selftest --nonce <N>`, through the launcher: its result line
   *  carries this exec's nonce. */
  selftest: {
    values: [FOLDER, HASH],
    text: join(['N=$1; D=$2; I=$3; F=$4; H=$5', ...CHECKS, ...LAUNCH, 'exec "$P" selftest --nonce "$N"']),
  },
  /** `aicc-helper list --store ~/.aicc/<did>/store`, through the launcher. */
  list: {
    values: [FOLDER, HASH],
    text: join(['N=$1; D=$2; I=$3; F=$4; H=$5', ...CHECKS, ...LAUNCH, 'exec "$P" list --store "$A/store"']),
  },
  /** `aicc-helper hold --detach` for one session (section 15), through the
   *  launcher: it prints the holder's record, or exits 3 when a holder for
   *  that session runs already. `K`, the holder's kind (2.1.3-beta.19 section
   *  1.2, HolderKind): `away` gives today's away clock, `until-ended` none. */
  hold: {
    values: [FOLDER, HASH, SESSION, { name: 'label', re: LABEL_RE }, { name: 'holder kind', re: HOLDER_KIND_RE }],
    text: join([
      'N=$1; D=$2; I=$3; F=$4; H=$5; X=$6; L=$7; K=$8',
      ...CHECKS,
      'case "$K" in away|until-ended) ;; *) no bad-kind;; esac',
      ...LAUNCH,
      'if [ "$K" = until-ended ]; then exec "$P" hold --store "$A/store" --session "$X" --label "$L" --until-ended --detach; fi',
      `exec "$P" hold --store "$A/store" --session "$X" --label "$L" --away ${REMOTE_AWAY_SECS} --detach`,
    ]),
  },
  /** `aicc-helper bridge` for one session (A1's mode), through the launcher:
   *  after the hash line, standard input and output are the holder's
   *  connection, byte for byte. */
  bridge: {
    values: [FOLDER, HASH, SESSION],
    text: join(['N=$1; D=$2; I=$3; F=$4; H=$5; X=$6', ...CHECKS, ...LAUNCH, 'exec "$P" bridge --store "$A/store" --session "$X"']),
  },
  /** 2.1.3-beta.18 section 3.2: the host files a session's launch reads
   *  first (its provider's hostReads), printed as data and written nowhere.
   *  Standard input: the session folder's absolute path on one line, then one
   *  line per read, `<from> <path>` (home, cwd or checkout, and plain names
   *  joined by `/`). The session folder counts only when it is not the home
   *  folder or a folder above it (that is the user's own source), and the
   *  checkout root only then. Each read is ONE_READ's: a `home` one as Claude
   *  Code reads the user's own file, the others as project files. */
  reads: {
    values: [],
    text: join([
      'N=$1; D=$2; I=$3',
      ...CHECKS,
      ...EXISTING,
      ...OWN,
      ...CHECKOUT_ROOT,
      ...ONE_READ,
      'o=$IFS; K=; kd=0; w=; hm=0',
      'IFS= read -r c || c=',
      'case "$c" in /*) w=$(cd "$c" 2>/dev/null && pwd -P) || w=;; esac',
      '[ -n "$w" ] && ab "$w" "$h" && w=',
      'i=0',
      'while read -r k p; do b=; hm=0; case "$k" in home) b=$h; hm=1;; cwd) b=$w;; checkout) if [ $kd = 0 ]; then kd=1; [ -n "$w" ] && cr; fi; b=$K;; esac; [ -n "$b" ] && [ -n "$p" ] && one $i "$b" "$p"; i=$((i+1)); done',
      'r end ok',
    ]),
  },
  /** 2.1.3-beta.19 section 3 (aicc_planning#434): `aicc-helper field` for
   *  one string field of one file under the home folder (`Y`, the field
   *  read's file; `Z`, its dotted key), through the launcher: after the hash
   *  line the helper prints that string or nothing, and exits 0. File and
   *  key come from the tab's provider package, never from a value a host
   *  reported. `Y` goes as it is, relative to the home folder: the field
   *  mode joins it to `$HOME` (helper/src/field.rs path_under), the same
   *  `$HOME` the checks above found a real folder of the user's. Never
   *  `$h/$Y`: `$h` is the home folder's real path, which differs from
   *  `$HOME` where a folder above it is a link (/home a link to /data/home),
   *  and the field mode takes an absolute path only inside `$HOME` as
   *  written, so the read would print nothing there. Writes nothing. */
  field: {
    values: [FOLDER, HASH, { name: 'field file', re: FIELD_FILE_RE }, { name: 'field key', re: FIELD_KEY_RE }],
    text: join(['N=$1; D=$2; I=$3; F=$4; H=$5; Y=$6; Z=$7', ...CHECKS, ...LAUNCH, 'exec "$P" field --file "$Y" --key "$Z" </dev/null']),
  },
  /** 2.1.3-beta.18 section 3.2: one session's own files, from standard input,
   *  into `sessions/<X>/` (made 0700 when missing), before its launch. `L` is
   *  the layout (FILES_LAYOUT_RE): the bytes follow in its order. All of them
   *  are read into a staging file first and checked for their size; each file
   *  is then cut from it into a staging name and moved over its own name. */
  files: {
    values: [SESSION, { name: 'file layout', re: FILES_LAYOUT_RE }],
    text: join([
      'N=$1; D=$2; I=$3; X=$4; L=$5',
      ...CHECKS,
      ...EXISTING,
      'umask 077',
      'case "$X" in *[!A-Za-z0-9_-]*|"") no bad-session;; esac',
      'S=$A/sessions; Q=$S/$X',
      '[ -e "$S" ] || [ -L "$S" ] || mkdir "$S" || no cannot-make-sessions-folder',
      'pv "$S" || no sessions-folder-not-private',
      '[ -e "$Q" ] || [ -L "$Q" ] || mkdir "$Q" || no cannot-make-session-folder',
      'pv "$Q" || no session-folder-not-private',
      'o=$IFS; IFS=,; set -- $L; IFS=$o',
      'z=0; for e in "$@"; do z=$((z+${e##*:})); done',
      'T=$Q/.in-$N',
      'head -c "$z" > "$T" 2>/dev/null',
      'n=$(wc -c < "$T"); n=$((n+0))',
      '[ "$n" -eq "$z" ] || { rm -f -- "$T"; no short-upload; }',
      'p=0; for e in "$@"; do m=${e%%:*}; s=${e##*:}; F=$Q/.$m.$N; if [ -d "$Q/$m" ] && [ ! -L "$Q/$m" ]; then rm -f -- "$T"; no file-is-a-folder; fi; tail -c +$((p+1)) "$T" | head -c "$s" > "$F"; k=$(wc -c < "$F"); k=$((k+0)); if [ "$k" -ne "$s" ]; then rm -f -- "$F" "$T"; no short-file; fi; mv -f -- "$F" "$Q/$m" || { rm -f -- "$F" "$T"; no cannot-place; }; p=$((p+s)); done',
      'rm -f -- "$T"',
      'r end ok',
    ]),
  },
  /** 2.1.3-beta.18 section 3.2: a session's own folder goes, at its end. A
   *  session whose holder still has a record keeps it (`held`): the next
   *  Check's sweep takes it once that holder is gone. */
  unsession: {
    values: [SESSION],
    text: join([
      'N=$1; D=$2; I=$3; X=$4',
      ...CHECKS,
      ...EXISTING,
      'case "$X" in *[!A-Za-z0-9_-]*|"") no bad-session;; esac',
      'Q=$A/sessions/$X',
      '[ -e "$Q" ] || [ -L "$Q" ] || { r gone yes; r end ok; exit 0; }',
      '[ -e "$A/store/$X.json" ] && no held',
      'pv "$Q" || no session-folder-not-private',
      ...DELETE_SESSION_FOLDER,
      '[ -e "$Q" ] && no still-there',
      'r end ok',
    ]),
  },
  /** 2.1.3-beta.19 section 1.2 with 6.3: the sessions the helper keeps (list
   *  mode's one line, printed as it is: the app reads it), then, as `sweep`
   *  does, every session folder whose holder has no record goes, and one whose
   *  holder runs is kept. The list the app takes at start-up and when the
   *  Machines page opens: a folder a quit left goes at the next start. Through
   *  the launcher. */
  sessions: {
    values: [FOLDER, HASH],
    text: join([
      'N=$1; D=$2; I=$3; F=$4; H=$5',
      ...CHECKS,
      ...LAUNCH,
      '"$P" list --store "$A/store" </dev/null || exit $?',
      ...SWEEP_GONE_FOLDERS,
    ]),
  },
  /** 2.1.3-beta.18 section 3.2, at Check: list mode first (it removes the
   *  records of holders that are gone), then, from 2.1.3-beta.19, the earlier
   *  builds' helper folders when no holder has a record
   *  (SWEEP_EARLIER_HELPERS), then every session folder whose holder has no
   *  record goes. Through the launcher. Only a Check runs it: the start-up
   *  list (`sessions`) never removes a helper folder. */
  sweep: {
    values: [FOLDER, HASH],
    text: join([
      'N=$1; D=$2; I=$3; F=$4; H=$5',
      ...CHECKS,
      ...LAUNCH,
      '"$P" list --store "$A/store" </dev/null >/dev/null 2>&1',
      ...SWEEP_EARLIER_HELPERS,
      ...SWEEP_GONE_FOLDERS,
    ]),
  },
  /** 2.1.3-beta.20 section 3.1.6: every sign-in on the machine in one exec,
   *  through the launcher: the machine's own (`Y`, its identity file, and
   *  `V`, its credentials file, both under the home folder), then each
   *  account folder in `~/.aicc/accounts/` that holds the app's marker (`J`
   *  and `C`, the file names in it). Each file is read by the helper's field
   *  mode with its keys (`Z`, the identity's; `K`, the credentials'), never
   *  by the script: after a line `AICC-FIELD <N> <own or profile id> <id or
   *  cr>`, the helper's one JSON object, or nothing when the file is not
   *  read. File names and keys are the provider package's; a profile id is
   *  a folder name of the app's shape, read from the folder. A folder whose
   *  marker names another install (the app on another computer signed in on
   *  this host login) is not read: `AICC-FIELD <N> <profile id> elsewhere`.
   *  Writes nothing. */
  accounts: {
    values: [FOLDER, HASH, { name: 'own identity file', re: FIELD_FILE_RE }, { name: 'own credentials file', re: FIELD_FILE_RE }, { name: 'identity file name', re: PLAIN_NAME_RE }, { name: 'credentials file name', re: PLAIN_NAME_RE }, { name: 'identity keys', re: FIELD_KEYS_RE }, { name: 'credentials keys', re: FIELD_KEYS_RE }],
    text: join([
      'N=$1; D=$2; I=$3; F=$4; H=$5; Y=$6; V=$7; J=$8; C=$9; Z=${10}; K=${11}',
      ...CHECKS,
      ...LAUNCH,
      ...ACCOUNT_MARK,
      'case "$J" in */*|.|..|"") no bad-file-name;; esac',
      'case "$C" in */*|.|..|"") no bad-file-name;; esac',
      'fr() { echo "AICC-FIELD $N $1 $2"; "$P" field --file "$3" --keys "$4" </dev/null 2>/dev/null; }',
      'fr own id "$Y" "$Z"',
      'fr own cr "$V" "$K"',
      'B=$HOME/.aicc/accounts',
      'if [ -e "$B" ] || [ -L "$B" ]; then pv "$B" || no accounts-folder-not-private; for X in $(ls -A "$B"); do case "$X" in [!a-z0-9]*|*[!a-z0-9-]*|"") continue;; esac; [ ${#X} -le 128 ] || continue; am "$B/$X" "$X" || { ao "$B/$X" "$X" && echo "AICC-FIELD $N $X elsewhere"; continue; }; fr "$X" id ".aicc/accounts/$X/$J" "$Z"; fr "$X" cr ".aicc/accounts/$X/$C" "$K"; done; fi',
      'r end ok',
    ]),
  },
  /** 2.1.3-beta.20 section 3.1.3: one account's folder, `~/.aicc/accounts/<P>/`
   *  (0700, with the app's marker), made at its sign-in (`make`) or brought up
   *  to date at a launch on it (`refresh`, which makes nothing: a folder that
   *  is not there answers `gone`). Its links: each folder of `L` and each file
   *  of `E` is a link to the same name in `~/<R>` (the CLI's own folder,
   *  `~/.claude`), and only there; a missing folder of `L` is made there, as
   *  the CLI makes it. A link that points elsewhere is replaced; an empty real
   *  folder in a link's place goes, and anything else in its place is left
   *  and reported (`own <name>`). Its settings copy `T`: `keep` leaves it,
   *  `0` removes it, a size reads exactly that many bytes from standard input
   *  into a staging file moved over it (a link there is replaced, never
   *  written through). Its sign-in files are the CLI's own, never written. */
  account: {
    values: [{ name: 'profile id', re: ACCOUNT_PROFILE_RE }, { name: 'mode', re: /^(make|refresh)$/ }, { name: 'home config folder', re: PLAIN_NAME_RE }, { name: 'linked folders', re: PLAIN_NAMES_RE }, { name: 'linked files', re: PLAIN_NAMES_RE }, { name: 'settings file name', re: PLAIN_NAME_RE }, { name: 'settings copy', re: ACCOUNT_SETTINGS_RE }],
    text: join([
      'N=$1; D=$2; I=$3; P=$4; M=$5; R=$6; L=$7; E=$8; T=$9; S=${10}',
      ...CHECKS,
      ...EXISTING,
      ...ACCOUNT_MARK,
      'umask 077',
      'case "$P" in [!a-z0-9]*|*[!a-z0-9-]*|"") no bad-profile;; esac',
      'case "$M" in make|refresh) ;; *) no bad-mode;; esac',
      'case "$S" in keep) ;; *[!0-9]*|"") no bad-size;; esac',
      'case "$R" in */*|.|..|"") no bad-home-folder;; esac',
      'case "$T" in */*|.*|"") no bad-settings-name;; esac',
      'B=$HOME/.aicc/accounts; Q=$B/$P; G=$HOME/$R',
      'if [ ! -e "$B" ] && [ ! -L "$B" ]; then [ "$M" = make ] || { r gone yes; r end ok; exit 0; }; mkdir "$B" || no cannot-make-accounts-folder; fi',
      'pv "$B" || no accounts-folder-not-private',
      'if [ -e "$Q" ] || [ -L "$Q" ]; then am "$Q" "$P" || { ao "$Q" "$P" && no account-folder-elsewhere; no account-folder-not-the-apps; }; else [ "$M" = make ] || { r gone yes; r end ok; exit 0; }; mkdir "$Q" || no cannot-make-account-folder; echo "aicc-account 1 $P $I" > "$Q/.aicc-account" || no cannot-write-marker; fi',
      'if [ ! -e "$G" ] && [ ! -L "$G" ]; then mkdir "$G" || no cannot-make-shared-folder; fi',
      '[ -d "$G" ] || no shared-folder-not-a-folder',
      'set -- $(ls -ldnL "$G" 2>/dev/null); [ "$3" = "$u" ] || no shared-folder-not-yours',
      'lk() { t=$G/$1; e=$Q/$1; if [ -L "$e" ]; then [ "$(readlink "$e")" = "$t" ] && return 0; rm -f -- "$e" || no cannot-relink; elif [ -d "$e" ]; then rmdir -- "$e" 2>/dev/null || { r own "$1"; return 0; }; elif [ -e "$e" ]; then r own "$1"; return 0; fi; ln -s "$t" "$e" || no cannot-link; }',
      'o=$IFS; IFS=,; set -- $L; IFS=$o',
      'for n in "$@"; do case "$n" in */*|.|..|"") no bad-link-name;; esac; [ -e "$G/$n" ] || [ -L "$G/$n" ] || mkdir "$G/$n" || no cannot-make-shared-folder; lk "$n"; done',
      'IFS=,; set -- $E; IFS=$o',
      'for n in "$@"; do case "$n" in */*|.|..|"") no bad-link-name;; esac; lk "$n"; done',
      'Z=$Q/$T',
      'if [ -d "$Z" ] && [ ! -L "$Z" ]; then no settings-is-a-folder; fi',
      'if [ "$S" = keep ]; then :; elif [ "$S" -gt 0 ]; then W=$Q/.$T.$N; head -c "$S" > "$W" 2>/dev/null; k=$(wc -c < "$W"); k=$((k+0)); [ "$k" -eq "$S" ] || { rm -f -- "$W"; no short-upload; }; mv -f -- "$W" "$Z" || { rm -f -- "$W"; no cannot-place; }; else rm -f -- "$Z"; fi',
      'r end ok',
    ]),
  },
  /** 2.1.3-beta.20 section 3.1.8: Sign out. `folder`: the CLI's own sign-out
   *  (`X` with the words `W`) runs with its config-folder variable (`E`) set
   *  to the account's folder `~/.aicc/accounts/<P>/`, then that folder goes,
   *  and only it (DELETE_ACCOUNT_FOLDER), once it is found a real folder of
   *  the user's, 0700, holding the app's marker for `P`; it goes whatever the
   *  sign-out answered, so the sign-in is not left on the machine (`out <P>
   *  <exit status>` says whether the service was told; `removed <P>` that the
   *  folder went). A folder that is not there answers `gone`; one made by
   *  the app on another computer (its marker names another install) is
   *  refused, `account-folder-elsewhere`. `list` (Remove): the same for each
   *  profile id `P` names (commas between), each only when its folder holds
   *  this install's marker, needing no read first; the first that cannot be
   *  removed stops it; then each folder left there is named: this install's
   *  that the list did not name (`left <id>`) and another computer's
   *  (`elsewhere <id>`), all left as they are. With the device folder already
   *  gone, `list` signs nothing out and answers `device gone`, and Remove goes
   *  on as before (2.1.3-beta.20 fix round, MAJOR-2). `own` (Q5, after the
   *  app asked): the CLI's own sign-out of the machine's own sign-in, the
   *  variable unset, and nothing removed (`logout <exit status>`). The CLI
   *  runs through the user's login shell when that is of the sh family (its
   *  PATH, as a session's launch has it), within 60 s where `timeout` is
   *  there; its output is not read. */
  signout: {
    values: [{ name: 'kind', re: /^(folder|own|list)$/ }, { name: 'profile ids', re: ACCOUNT_IDS_RE }, { name: 'config variable', re: CONFIG_VAR_RE }, { name: 'program', re: CLI_WORD_RE }, { name: 'words', re: CLI_WORDS_RE }],
    text: join([
      'N=$1; D=$2; I=$3; O=$4; P=$5; E=$6; X=$7; W=$8',
      ...CHECKS,
      'if [ "$O" = list ] && [ ! -e "$A" ] && [ ! -L "$A" ]; then r device gone; r end ok; exit 0; fi',
      ...EXISTING,
      ...ACCOUNT_MARK,
      'case "$O" in folder|own|list) ;; *) no bad-kind;; esac',
      'case "$P" in *[!a-z0-9,-]*|"") no bad-profile;; esac',
      'case "$E" in [!A-Z]*|*[!A-Z0-9_]*|"") no bad-variable;; esac',
      'case "$X" in [!a-z]*|*[!a-z0-9-]*|"") no bad-program;; esac',
      'case "$W" in *[!a-z0-9,-]*|"") no bad-words;; esac',
      'S=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7); [ -n "$S" ] || S=${SHELL:-/bin/sh}',
      'T=; command -v timeout >/dev/null 2>&1 && T="timeout 60"',
      // `$` alone, so `$0` and `$@` expand in the login shell: the program and its words, plain words all.
      'v="$"',
      'lo() { case "${S##*/}" in bash|zsh|sh|dash|ksh|mksh|ash|yash) $T "$S" -ilc "exec ${v}0 ${v}@" "$X" "$@" </dev/null >/dev/null 2>&1;; *) if command -v "$X" >/dev/null 2>&1; then $T "$X" "$@" </dev/null >/dev/null 2>&1; else return 127; fi;; esac; }',
      'o=$IFS; IFS=,; set -- $W; IFS=$o',
      'B=$HOME/.aicc/accounts',
      'if [ "$O" = own ]; then unset "$E"; lo "$@"; r logout $?; r end ok; exit 0; fi',
      'if [ ! -e "$B" ] && [ ! -L "$B" ]; then [ "$O" = folder ] && r gone yes; r end ok; exit 0; fi',
      'pv "$B" || no accounts-folder-not-private',
      'if [ "$O" = folder ]; then case "$P" in [!a-z0-9]*|*[!a-z0-9-]*) no bad-profile;; esac; [ -e "$B/$P" ] || [ -L "$B/$P" ] || { r gone yes; r end ok; exit 0; }; am "$B/$P" "$P" || { ao "$B/$P" "$P" && no account-folder-elsewhere; no account-folder-not-the-apps; }; fi',
      'L=$(printf "%s" "$P" | tr "," " ")',
      'for P in $L; do case "$P" in [!a-z0-9]*|*[!a-z0-9-]*|"") continue;; esac; Q=$B/$P; am "$Q" "$P" || continue; export "$E=$Q"; lo "$@"; r out "$P" $?',
      ...DELETE_ACCOUNT_FOLDER,
      '[ -e "$Q" ] && no still-there',
      'r removed "$P"; done',
      'if [ "$O" = list ]; then for P in $(ls -A "$B"); do case "$P" in [!a-z0-9]*|*[!a-z0-9-]*|"") continue;; esac; if am "$B/$P" "$P"; then r left "$P"; elif ao "$B/$P" "$P"; then r elsewhere "$P"; fi; done; fi',
      'r end ok',
    ]),
  },
} satisfies Record<string, ScriptSpec>

export type ScriptName = keyof typeof SPECS

/** Every fixed script's name, from the one table (the tests' lists read it,
 *  so a script added there cannot be left out of them). */
export const SCRIPT_NAMES = Object.keys(SPECS) as ScriptName[]

/** A script's text holds no single quote, backslash or line end (section 4). */
export function scriptTextProblem(text: string): string | null {
  if (/['\\\r\n]/.test(text)) return 'it holds a single quote, a backslash or a line end'
  return null
}

for (const [name, spec] of Object.entries(SPECS)) {
  const why = scriptTextProblem(spec.text)
  if (why) throw new Error(`remote-helper script ${name}: ${why}`)
}

/** The script's text (for tests). */
export function scriptText(name: ScriptName): string {
  return SPECS[name].text
}

/**
 * The command ssh runs for `name`: `/bin/sh -c '<script>' aicc <values>`.
 * `values` are the nonce, the device id and the install id, then the
 * script's own. Throws, naming the value, when one breaks its pattern.
 */
export function scriptCommand(name: ScriptName, values: readonly string[]): string {
  const spec: ScriptSpec = SPECS[name]
  const all = [{ name: 'nonce', re: NONCE_RE }, { name: 'device id', re: DID_RE }, { name: 'install id', re: INSTALL_ID_RE }, ...spec.values]
  if (values.length !== all.length) throw new Error(`remote-helper script ${name} takes ${all.length} values, not ${values.length}`)
  values.forEach((v, i) => {
    if (typeof v !== 'string' || !all[i].re.test(v)) throw new Error(`remote-helper script ${name}: the ${all[i].name} is not one the session helper takes`)
  })
  return `/bin/sh -c '${spec.text}' aicc ${values.join(' ')}`
}

/** A holder's label from an app session id: the id itself when it can be one,
 *  else a fixed word. */
export function holderLabel(appPtyId: string): string {
  return LABEL_RE.test(appPtyId) && APP_PTY_ID_RE.test(appPtyId) ? appPtyId : 'tab'
}
