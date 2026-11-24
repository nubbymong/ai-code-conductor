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
 * bridge) hash the helper's file before every start and print section 13's
 * `AICC-HASH <nonce> <state> <hex>` line, and run the helper only on `ok`.
 *
 * Layout (section 1): `~/.aicc/<did>/owner` (the marker),
 * `~/.aicc/<did>/helper/<version>-<hash12>/aicc-helper` (0700, never on PATH),
 * `~/.aicc/<did>/store` (the holders' records; the helper makes it 0700). A
 * new file is written to `helper/.new-<nonce>/` first and moved into its
 * folder only once the app has compared its hash with the installer's
 * manifest (commit), or removed (discard).
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

const join = (parts: readonly string[]): string => parts.join('; ')

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
      'rm -rf -- "${HOME:?}/.aicc/${D:?}" || no cannot-remove',
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
   *  that session runs already. */
  hold: {
    values: [FOLDER, HASH, SESSION, { name: 'label', re: LABEL_RE }],
    text: join(['N=$1; D=$2; I=$3; F=$4; H=$5; X=$6; L=$7', ...CHECKS, ...LAUNCH, `exec "$P" hold --store "$A/store" --session "$X" --label "$L" --away ${REMOTE_AWAY_SECS} --detach`]),
  },
  /** `aicc-helper bridge` for one session (A1's mode), through the launcher:
   *  after the hash line, standard input and output are the holder's
   *  connection, byte for byte. */
  bridge: {
    values: [FOLDER, HASH, SESSION],
    text: join(['N=$1; D=$2; I=$3; F=$4; H=$5; X=$6', ...CHECKS, ...LAUNCH, 'exec "$P" bridge --store "$A/store" --session "$X"']),
  },
} satisfies Record<string, ScriptSpec>

export type ScriptName = keyof typeof SPECS

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
