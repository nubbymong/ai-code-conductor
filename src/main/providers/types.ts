import type { BrowserWindow } from 'electron'
import type { IPty, IPtyForkOptions } from 'node-pty'
import type { CodexOptions, LegacyVersion, PromptButtonResult, ProviderId, SshConfig, SshRuntime, StatuslineData, SubmitTextResult } from '../../shared/types'
import type { AccountUsage } from '../../shared/usage-types'
import type { RealmOwnership } from '../../shared/providers'
import type { AccountLease } from './core'

export interface SpawnOptions {
  sessionId: string
  /** Provider discriminator. Defaults to 'claude' if unspecified. */
  provider?: ProviderId
  cwd?: string
  cols?: number
  rows?: number
  ssh?: SshConfig
  shellOnly?: boolean
  elevated?: boolean
  /** A tab the app opens to run one line it built (the install or update tab,
   *  terminalOptions.noCommandSecrets). On Windows its shell, and what that line
   *  starts by a bare name (npm.cmd's node), finds programs only in the folders
   *  PATH names in full (withFullyQualifiedProgramLookup). Any other terminal
   *  tab keeps the user's own lookup. */
  fullyQualifiedLookup?: boolean
  /** Terminal-only secret argument, resolved from the OS keychain in main. Placed
   *  in the spawn ENV (never interpolated into the command text) so it cannot land
   *  in the shell's on-disk history. See buildSpawnCommand + the shell-only write. */
  terminalSecret?: string
  /** Secret arguments of command BUTTONS visible to this config, keyed by
   *  command id, resolved from the keychain in main (collectCommandSecrets).
   *  Each becomes CCC_CMD_SECRET_<id> in a SHELL spawn's env; the button types
   *  the reference. Never accepted from the renderer. */
  commandSecrets?: Record<string, string>
  configLabel?: string
  useResumePicker?: boolean
  legacyVersion?: LegacyVersion
  agentsConfig?: Array<{ name: string; description: string; prompt: string; model?: string; tools?: string[] }>
  // Widened to string — the IPC schema's charset guard is the real contract.
  effortLevel?: string
  disableAutoMemory?: boolean
  model?: string
  /** v1.5.32: when true (or undefined = default), sets CLAUDE_CODE_DISABLE_MOUSE=1
   *  in the spawn env so xterm owns the mouse (classic selection, right-click
   *  copy/paste). When false, CC's mouse mode is preserved. Applies to shell-only
   *  sessions too: the var is inert for the shell itself but governs any `claude`
   *  the user starts by hand (the re-auth flow does exactly that), so exempting
   *  them left that claude in mouse mode where right-click pasted — and at a
   *  shell prompt executed — the clipboard. */
  classicTerminalCopyPaste?: boolean
  /** v2.0: CC >= 2.1.195 renders question options as CLICKABLE targets, which
   *  misfire inside xterm.js. False (or undefined = CCC default) stamps
   *  CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1 so answers stay keyboard-driven (wheel
   *  scroll unaffected). True preserves CC's clickable prompts. */
  clickableQuestions?: boolean
  /** v2.0.0-beta.3: a stray Ctrl+B (or /bg) detaches the session into a Claude
   *  Code background agent and strands the conversation (a beta tester hit this
   *  twice in two days). Absent or true stamps CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
   *  so no keystroke can background a session; false restores CC's background feature. */
  disableBackgroundTasks?: boolean
  /** Host (CCC) effective light/dark scheme, stamped into COLORFGBG so Claude
   *  Code's startup theme auto-detection matches the terminal. Resolved by the
   *  caller from AppSettings.theme + the OS preference. Absent = no COLORFGBG. */
  hostColorScheme?: 'light' | 'dark'
  /** Ask Conductor: the user's question, launched as Claude's opening prompt so
   *  nobody has to paste it. Like {@link terminalSecret} this goes in the spawn
   *  ENV and the command text carries only a REFERENCE to the variable, so the
   *  question is never parsed by the shell — free text is exactly the input that
   *  would otherwise need quoting to be safe — and never reaches PSReadLine's
   *  on-disk history. Absent = no opening prompt (an ordinary session). */
  askPrompt?: string
  // Codex-specific (only present when provider === 'codex')
  codexOptions?: CodexOptions
  /** Codex (WP2, plan A10): the session's prepared launch in its account's
   *  realm -- the executable setup proved, the realm's environment (ambient
   *  credentials removed, CODEX_HOME set) and its transcript folder. A Codex
   *  spawn runs only from this. Set by main; never from the renderer. */
  realmLaunch?: { executable: string; env: Record<string, string>; sessionsDir: string }
  /** Codex (P3.5): the conversation to resume exactly -- the persisted
   *  target of a restored tab, or the tab's kept conversation on a Restart.
   *  The builder resumes it only when its rollout is in `realmLaunch`'s own
   *  sessions folder, and checks the id again before it reaches argv. Set by
   *  main only. */
  resume?: { uuid: string; cwd: string }
  /** Codex (P3.10): the session's hook file (its gateway port and token),
   *  when the Hooks gateway is on and listening. The builder gives the launch
   *  the app's hooks only with it, and only when their command can be given
   *  safely (`hooksInstalled`). Set by main only. */
  codexHooks?: { hookFile: string }
  /** Codex (P3.10 round 1, V2): the conversations other open tabs of this
   *  app are on (ids), for the resume picker to say one is open in another
   *  tab. Set by main only. */
  codexOpenElsewhere?: string[]
  /** Codex (WP2 PR 4, P4.3): this launch is an Ask Conductor session in the
   *  app's help folder; the byte bound of the AGENTS.md written there
   *  (help-workspace.ts askConductorProjectDocMaxBytes). The builder passes
   *  `-c project_doc_max_bytes=<n>` and `-c project_root_markers=[]`, so
   *  Codex reads that file whole and no parent folder's joins it. Set by main
   *  only. */
  askProjectDocMaxBytes?: number
}

/** What a provider's builder hands the PTY. `commandLine` (Windows only): the
 *  whole command line after `cmd`, which node-pty passes VERBATIM -- a cmd.exe
 *  `/s /c` line cannot survive its per-argument quoting; when present it is
 *  what runs, and `args` is empty. Codex (P3.5): `cwd`, the directory the CLI
 *  must start in when it is not the configured one (an exact resume in the
 *  conversation's own directory); `resumeId`, the conversation it resumes;
 *  `pickFile`, where the resume picker records the conversation it opens. */
export interface ProviderSpawnCommand {
  cmd: string
  args: string[]
  env: Record<string, string>
  commandLine?: string
  cwd?: string
  resumeId?: string
  /** No rollout of the resumed conversation records the directory the
   *  session kept: it starts in the configured one (the caller says so). */
  resumeCwdMismatch?: boolean
  /** The rollout of the resumed conversation the builder chose. */
  resumePath?: string
  pickFile?: string
  /** The folder made for the pick file, as it was when made (fix round 3). */
  pickFolder?: PickFolderIdentity
  /** Codex (P3.10): the launch carries the app's hooks (see
   *  SpawnOptions.codexHooks). */
  hooksInstalled?: boolean
  /** Codex (WP2 PR 4, P4.1): the launch line as the app's log may hold it,
   *  built by the builder, which knows which values are long or private and
   *  names them by length. Absent: main logs no argument. */
  logLine?: string
  /** Codex (WP2 PR 4, P4.3): the launch carries `askPrompt` as its prompt on
   *  argv, after `--` (the direct route's fresh launch, PB4). Otherwise main
   *  holds the question and types it through the run's screen (its pane, or a
   *  held run's holder's screen) at the first ready, empty composer. */
  askPromptOnArgv?: boolean
}

/** A folder as it was when made: what it is (its device and file id, exact)
 *  and where it really is (every link on the way resolved). The resume
 *  picker's pick folder is used only while it is still this folder. */
export interface PickFolderIdentity {
  id: string
  real: string
}

/** 2.1.3-beta.17 (aicc_planning#419): a launch's pick file with its folder
 *  as made, and the resume picker's last decision its watcher read (the
 *  conversation it opened, or when it chose a new one): what an app update
 *  that keeps the session running records, for the next run's watcher. */
export interface ResumePick {
  file: string
  folder: PickFolderIdentity
  decided?: { id: string } | { fresh: number }
}

/** The session helper's relay mode for one held session's `conductor` tool
 *  server (2.1.3-beta.11, plan section B2): `<helperPath> mcp --store <store>
 *  --session <sid>`, which the CLI starts as its tool server and which
 *  reaches the Conductor tools through the session's holder. */
export interface HeldToolRelay {
  /** The per-user helper copy's absolute path. */
  helperPath: string
  /** The helper's store folder. */
  store: string
  /** The holder's session id. */
  sid: string
}

/** A held session's launch as the PTY manager handed it to the session
 *  helper: the program, its arguments (one string: the cmd.exe line that goes
 *  verbatim, ProviderSpawnCommand.commandLine) and its environment. */
export interface HeldToolLaunch {
  file: string
  args: readonly string[] | string
  env: Readonly<Record<string, string | undefined>>
}

/** What a provider's heldToolLaunch answers: the launch's arguments in their
 *  relay form (the same shape it was given), or why the launch keeps its
 *  loopback route. `no-tools`: the launch names none of the app's loopback
 *  entries for this session (the built-in tools are off, or the server was not
 *  started when it was built). `unsafe-path`: a path the relay needs cannot
 *  ride the launch exactly. `cmd-line`: the launch is a cmd.exe line, or
 *  hands its arguments to one, and the relay's cannot pass that line's
 *  quoting rule. */
export type HeldToolLaunchAnswer =
  | { args: string[] | string }
  | { refused: 'no-tools' | 'unsafe-path' | 'cmd-line' }

/** 2.1.3-beta.18 section 2 (aicc_planning#430): what a remote launch is
 *  given of the tab: its saved launch options, the folder it starts in on
 *  the host and the app's settings as this start read them. Not the tab's
 *  SSH options: they hold its sign-in. */
export interface RemoteLaunchOptions {
  readonly model?: string
  readonly effortLevel?: string
  readonly permissionMode?: string
  /** The config's extra arguments, as one string. */
  readonly extraArgs?: string
  readonly disableAutoMemory?: boolean
  /** The tab starts again on its last conversation (its SSH options' `reconnect`). */
  readonly reconnect: boolean
  /** The folder the session starts in on the host, absolute. */
  readonly cwd: string
  /** The app's saved settings as this start read them; null when they do not read. */
  readonly settings: Readonly<Record<string, unknown>> | null
  /** The app serves its Conductor tools to this session (2.1.3-beta.18
   *  section 3.2): the built-in tools are on and their server is started.
   *  False: the launch names no tool server of the app's. */
  readonly tools: boolean
  /** 2.1.3-beta.20 section 3.1.7: the tab's account is signed in on the host
   *  in a folder of its own, and the CLI runs with this as its config
   *  folder: absolute, `<host home>/.aicc/accounts/<profile id>`. Absent: the
   *  CLI runs on the host's own sign-in (a config with no account, or one
   *  the host's own sign-in is). */
  readonly configDir?: string
  /** 2.1.3-beta.20 section 3.1.4: a sign-in tab. The launch runs the CLI's
   *  own sign-in in `configDir` instead of a session, for the account of
   *  `email` when this computer knows it, by the account's own sign-in
   *  `method` as this computer records it (the provider package checks it
   *  against the CLI's choices). */
  readonly signIn?: { readonly email?: string; readonly method?: string }
}

/** The machine a remote launch runs on, as its last check on the Machines
 *  page read it (remote-helper/machines.ts RemoteMachineRecord, structurally). */
export interface RemoteLaunchMachine {
  /** The host account's home folder and user name. */
  readonly home: string
  readonly user: string
  /** Where the check found Claude Code's CLI on the host (the login shell's
   *  `-il` lookup, else the exec's PATH); null: not found. A saved shape that
   *  changes when a second provider runs over SSH. */
  readonly claudePath: string | null
}

/** The session helper on the host, for a command a session's file names
 *  (`<helperPath> <mode> --store <store> --session <sid>`: the status, hook
 *  and relay modes): absolute paths on the host, and the holder's session id.
 *  `folder` (2.1.3-beta.18 section 3.2): the session's own folder on the
 *  host, absolute, where core writes the launch's `files`; the launch names
 *  them there. */
export type RemoteHelperCommands = Readonly<HeldToolRelay> & { readonly folder: string }

/** A file on the host a remote launch needs read before it starts: `path`
 *  under the host user's home folder, the folder the session starts in, or
 *  the root of the git checkout that folder is in; plain names joined by `/`,
 *  none of them `.` or `..`. */
export interface RemoteHostRead {
  readonly from: 'home' | 'cwd' | 'checkout'
  readonly path: string
}

/** 2.1.3-beta.19 section 3 (aicc_planning#434): one string field of a file
 *  on the host, read through the session helper's field mode (`aicc-helper
 *  field --file <path under home> --key <dotted key>`), never the file:
 *  `file`, a path under the host user's home folder, plain names joined by
 *  `/`, none of them `.` or `..`; `key`, the field's dotted path, plain names
 *  joined by `.`. The helper answers the one string at that key or nothing. */
export interface RemoteHostField {
  readonly file: string
  readonly key: string
}

/** 2.1.3-beta.19 section 3 (aicc_planning#434): where a helper tab's weekly
 *  bars and extra usage come from, this computer's own reading of the account
 *  the tab's start named, never the host: the provider's account profiles on
 *  this computer, and one usage read of one of them. The provider package's,
 *  as its account field is: core looks nothing up for a provider that gives
 *  none (statusline-watcher.ts setHelperAccount). */
export interface RemoteAccountUsage {
  /** The provider's account profiles on this computer, with the email each is signed in as. */
  profiles(): Promise<ReadonlyArray<{ id: string; accountEmail?: string }>>
  /** One usage read of one of those profiles. */
  usage(profileId: string): Promise<AccountUsage>
}

/** 2.1.3-beta.20 section 3: a sign-in's two files, the one that names its
 *  account and the one that holds its credentials: paths under the host
 *  user's home folder for the host's own sign-in, plain names in the
 *  account's folder for an account's. */
export interface RemoteSignInFiles {
  readonly identity: string
  readonly credentials: string
}

/**
 * 2.1.3-beta.20 section 3 (Sign in on this machine; ADR-030 D7 Standard
 * login): what core needs of a provider to keep its accounts signed in on a
 * host, each in a folder of its own there (`~/.aicc/accounts/<profile id>/`,
 * which core makes, owner-only). Every name, key and word here is the
 * package's; core puts each through its own pattern before a script takes it,
 * and the helper's field mode reads only the keys on its own list.
 */
export interface RemoteAccounts {
  /** The provider's accounts on this computer, in their order, each with
   *  the email it is signed in as. */
  profiles(): Promise<ReadonlyArray<{ id: string; accountEmail?: string; name?: string }>>
  /** A sign-in's files: the host's own, and an account folder's. */
  readonly files: { readonly own: RemoteSignInFiles; readonly folder: RemoteSignInFiles }
  /** The keys of a sign-in's fields: the account its identity file names,
   *  and its credentials' plan, tier and expiry (an integer, ms). */
  readonly keys: { readonly identity: string; readonly plan: string; readonly tier: string; readonly expiresAt: string }
  /** The account folder's links (section 3.1.3), each only ever into the
   *  CLI's own folder in the host user's home (`home`, a plain name): the
   *  folders, made there when missing, and the files. */
  readonly links: { readonly home: string; readonly folders: readonly string[]; readonly files: readonly string[] }
  /** The variable that names the CLI's config folder: the sign-out sets it
   *  to the account's folder. */
  readonly configVar: string
  /** The CLI's own sign-out (section 3.1.8): a program name and its words. */
  readonly signOut: { readonly program: string; readonly args: readonly string[] }
  /** The account folder's settings file: its name, and its text from a
   *  launch's host reads (the host user's own settings made fit for an
   *  account's folder); null content: none, and a copy there goes. */
  settingsCopy(reads: readonly RemoteHostFile[]): { readonly name: string; readonly content: string | null }
}

/** A host read as it came back: its text, or null when it was not read (not
 *  there, not a regular file, or over the bound; and for a `cwd` or
 *  `checkout` read, a link, not the host user's own, or open to others). A
 *  `home` read is read as Claude Code reads the user's own file: a link is
 *  followed (remote-helper/scripts.ts ONE_READ). */
export interface RemoteHostFile extends RemoteHostRead {
  readonly content: string | null
}

/** What a remote launch starts. `program`: the CLI on the host, an absolute
 *  path. `env`: the CLI's own variables, never one core sets (the host
 *  account's, LANG, TERM, COLORTERM, COLORFGBG). `files`: for the session's
 *  own folder on the host, each a plain name and its text. `statusKeep` and
 *  `hookKeep`: the fields of a status payload and of a hook event the app
 *  keeps (a nested field by its dotted path); none: nothing kept. */
export interface RemoteLaunch {
  readonly program: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly files: ReadonlyArray<{ readonly name: string; readonly content: string }>
  readonly statusKeep: readonly string[]
  readonly hookKeep: readonly string[]
  /** 2.1.3-beta.21 (ADR-032; docs/remote/helper-protocol.md section 15, the
   *  clipboard stand-in): the CLI reads a picture by running `xclip` or
   *  `wl-paste`, which it finds by PATH. Core then, on a Linux host only
   *  (remote-helper/session.ts clipStandInFolder), has the session's `files`
   *  exec write the stand-in's two scripts into the session's `bin/` folder
   *  and puts that folder first on the CLI's PATH (remoteLaunchSpec). A
   *  field, not a variable: a provider's `env` may not set PATH. Absent or
   *  false: neither. */
  readonly clipStandIn?: boolean
  /** 2.1.3-beta.21 (ADR-032, row 14; plan block 5.1): the key the app sends
   *  for the CLI's own image paste in this session, from the provider's
   *  table and what its host reads found (Claude Code: `chat:imagePaste` in
   *  the keybindings file of the config folder the session's CLI uses,
   *  mapped through the package's fixed chord-to-bytes table, so a host
   *  picks at most a chord from that table, never raw bytes). Absent: the
   *  session takes no image paste (a sign-in). */
  readonly imagePasteKey?: PasteKey
}

/** A status line as a provider gives it for the tab's strip: StatuslineData's
 *  fields less the session id, which core sets to the tab's own. */
export type RemoteStatusLine = Partial<Omit<StatuslineData, 'sessionId'>>

/** A provider's launch of a session on another machine through the session
 *  helper there, in two steps. Core (src/main/remote-helper) asks it by the
 *  tab's provider id through the registry and keeps ssh, the upload, routing,
 *  frames, the login shell's `-il` wrapper, the host account's variables,
 *  LANG, TERM and the terminal's light or dark scheme; it names no flag or
 *  variable of a CLI. Both steps are pure: they read and write nothing.
 *  Core asks for the launch twice: once before anything is read on the host
 *  (`reads` all null), to check the start, then with the reads; the
 *  program, its arguments and its variables do not change with what was
 *  read (a launch whose program, arguments or variables differ is refused),
 *  only the files and keep-lists may. */
export interface ProviderRemoteLaunch {
  /** The host files the launch needs read first, in order; none: nothing is read. */
  hostReads(options: RemoteLaunchOptions, machine: RemoteLaunchMachine): readonly RemoteHostRead[]
  /** The launch. `reads`: what hostReads named, in its order, as read. */
  launch(options: RemoteLaunchOptions, machine: RemoteLaunchMachine, helper: RemoteHelperCommands, reads: readonly RemoteHostFile[]): RemoteLaunch
  /** 2.1.3-beta.19 section 3 (aicc_planning#434): the host file field that
   *  names the account the tab's CLI is signed in as, which the tab's status
   *  line and header show (an email address, or nothing). Core reads it with
   *  the host reads at every start of the tab, launch or attach
   *  (remote-helper/host-reads.ts readHostForStart). Absent or null: no
   *  account is read for the tab. */
  accountField?(options: RemoteLaunchOptions, machine: RemoteLaunchMachine): RemoteHostField | null
  /** 2.1.3-beta.19 section 3 (aicc_planning#434): the source of the tab's
   *  weekly bars and extra usage for the account its account field named:
   *  this computer's own reading of that account, when it holds it. Handed
   *  with each start's account read; the same source each time, so one
   *  reading serves every tab on an account. Absent: the tab shows no bars
   *  of its own and says they are not available. */
  accountUsage?(): RemoteAccountUsage
  /** 2.1.3-beta.20 section 3 (Sign in on this machine): the provider's
   *  accounts as they sign in on a host, each in a folder of its own there
   *  (RemoteAccounts). Absent: its accounts are not signed in on hosts, and
   *  its tabs run on the host's own sign-in. */
  accounts?(): RemoteAccounts
  /** 2.1.3-beta.21 (aicc_planning#446): true when a tab of this provider
   *  may ask for a review on its machine, in its folder there, by its
   *  reviewing provider (the tool host's rule, offeredReviewTool: a Claude
   *  Code tab's reviewer is Codex). Core registers the tab for it at each
   *  start (remote-helper/review-sessions.ts). Absent: never. */
  reviewsOnMachine?: boolean
  /** The tab's status line from one status the CLI posted, already cut to
   *  the launch's `statusKeep` (2.1.3-beta.18 section 3.2). Untrusted input;
   *  a remote path in it is display text only, never a transcript path.
   *  Null: nothing to show. Absent: a provider whose tabs get no status line
   *  this way. */
  statusLine?(payload: Readonly<Record<string, unknown>>): RemoteStatusLine | null
}

/** 2.1.3-beta.19 section 2 (aicc_planning#439): the launch pty:spawn prepared
 *  for a session's account (src/main/pty-manager.ts CodexLaunch, by shape):
 *  the lease on the account, the executable setup proved, the realm's
 *  environment and where the realm writes its transcripts; main only. */
export interface LocalAccountLaunch {
  readonly lease: AccountLease
  readonly executable: string
  readonly env: Record<string, string>
  readonly sessionsDir: string
  readonly freshConversation?: boolean
  readonly home?: string
  readonly ownership?: RealmOwnership
}

/** The saved options a local launch reads, as pty:spawn hands them over.
 *  `codexLaunch` is the account's launch, under the name pty:spawn gives it. */
export interface LocalLaunchOptions {
  readonly resume?: { uuid: string; cwd: string }
  readonly useResumePicker?: boolean
  readonly isAsk?: boolean
  readonly askPrompt?: string
  readonly codexOptions?: CodexOptions
  readonly codexLaunch?: LocalAccountLaunch
}

/** What a local launch is given of its session: the window, the tab's id,
 *  the provider the launch looked up in the registry (its id and its session
 *  provider, the one the launch builds through), the saved options, the
 *  configured folder resolved, and the terminal's size. */
export interface LocalLaunchRequest {
  readonly win: BrowserWindow
  readonly sessionId: string
  readonly id: ProviderId
  readonly provider: SessionProvider
  readonly options: LocalLaunchOptions | undefined
  readonly resolvedCwd: string
  readonly cols: number
  readonly rows: number
}

/** A launch's hooks between their minting and their keeping (sessions/launch-bindings.ts CodexHooks, by shape). */
export interface LocalLaunchHooks { hookFile: { hookFile: string; dispose(): void } | null; tokenMinted: boolean }

/** 2.1.3-beta.19 section 2 (aicc_planning#439): the PTY manager's
 *  per-session records and the launch bindings' doors a provider's lifecycle
 *  object uses (sessions/launch-bindings.ts LaunchBindingPorts and its
 *  helpers, by shape). Several are Codex's records, kept in core until they
 *  move with the local cutover. Handed to the object, never imported by it,
 *  so no package reaches pty-manager.ts or the launch bindings. */
export interface LifecycleCore {
  readonly ptySessions: ReadonlyMap<string, { ptyProcess: IPty }>
  readonly codexHookFiles: Map<string, { hookFile: string; dispose(): void }>
  readonly codexHookedLaunches: Set<string>
  readonly codexLaunchLeases: Map<string, AccountLease>
  readonly codexAskSessions: Set<string>
  readonly codexTelemetrySources: Map<string, TelemetrySource>
  readonly notIndexedSessions: Map<string, { since: number; provider: ProviderId }>
  readonly codexContextRollouts: Map<string, { path: string; sessionsDir: string }>
  readonly keptCodexConversations: Pick<Map<string, { uuid: string }>, 'delete' | 'get'>
  readonly lastCodexHookRollout: Pick<Map<string, unknown>, 'delete'>
  readonly claudeTranscripts: Pick<Map<string, string>, 'delete' | 'get'>
  noteGatewayToken(sessionId: string, codex: boolean): void
  dropGatewayToken(sessionId: string): void
  keepCodexConversation(sessionId: string, conversation: { uuid: string; cwd: string }, accountId?: string, how?: { inferred: boolean }): void
  markCodexConversationUncertain(uuid: string): void
  clearCodexDoubtFromHook(uuid: string): void
  noteCodexContextRollout(sessionId: string, rollout: { path: string; sessionsDir: string } | null): void
  endSessionNotIndexed(sessionId: string, now: number, opts?: { coversStay?: boolean }): void
  noteCodexFolder(sessionId: string, cwd: string): void
  codexRunWriters(codexRun: IPty): { write: (data: string) => void; writeColourAnswer: (bytes: string) => void }
  bindCodexLease(sessionId: string, lease: AccountLease): void
  bindCodexPane(binding: { sessionId: string; codexRun: IPty; runScreen: SessionRunScreen | undefined; cols: number; rows: number; write: (data: string) => void; writeColourAnswer: (bytes: string) => void }): { filter(data: string): string }
  /** B1e (aicc_planning#423): a gateway token the kill before a take-over
   *  kept for a session served while its tab was not shown is settled:
   *  `replaced` when the take-over wrote its own over it. */
  settleServedToken(sessionId: string, replaced?: boolean): void
}

/** The PTY manager's records and doors a local launch uses besides its
 *  provider's lifecycle core: the hooks' minting and keeping, its records of
 *  resumed conversations and leases, Ask Conductor's question, and its spawn
 *  of an agent's terminal. Handed to the launch, never imported by it. */
export interface LocalLaunchCore extends LifecycleCore {
  mintCodexHooks(sessionId: string, provider: SessionProvider): LocalLaunchHooks
  keepCodexHooks(sessionId: string, hooks: LocalLaunchHooks, hooked: boolean): LocalLaunchHooks
  readonly keptCodexConversations: Pick<Map<string, { uuid: string; cwd: string }>, 'get' | 'delete'>
  readonly codexResumedById: Pick<Map<string, string>, 'set'>
  readonly takenCodexLeases: Pick<WeakSet<AccountLease>, 'add'>
  releaseCodexLeaseOnExit(proc: IPty, lease: AccountLease): void
  closeRunScreens(sessionId: string): void
  forgetCodexHooks(sessionId: string): void
  codexConversationsOpenElsewhere(sessionId: string, accountId: string | undefined): string[]
  typeAskQuestion(win: BrowserWindow, sessionId: string, question: string): Promise<unknown>
  askLaunchFolderHolds(folder: string | undefined, launchFolder: string): boolean
  spawnAgentPty(ctx: { sessionId: string; kind: ProviderId }, file: string, args: string[] | string, opts: IPtyForkOptions): IPty
  noteAgentRunFolder(proc: IPty, sessionId: string, folder: string): void
  watchBundledConptyEarlyExit(sessionId: string, proc: IPty): void
}

/** What a local launch started: the session's terminal, and when (taken
 *  right before the spawn: the moment the session became not indexed, when
 *  it launched so). */
export interface LocalLaunchStarted {
  readonly ptyProcess: IPty
  readonly launchedAt: number
}

/** 2.1.3-beta.19 section 2 (aicc_planning#439): how a provider whose CLI is
 *  the terminal's own program starts a local session (a `direct` launch,
 *  src/main/pty-manager.ts launchStyleOf). The PTY manager asks the session's
 *  provider for it through the registry and names no provider: it runs any
 *  provider that has this group, and refuses one with none. `start` starts
 *  the CLI itself (it hands the PTY manager no program to start: Codex's body
 *  moved here unchanged, its spawn included), so it owes what the PTY
 *  manager's own branches do for a session: the terminal started through
 *  `core.spawnAgentPty`; its data sent to the window on `pty:data:<session id>`
 *  only while `core.ptySessions` holds this terminal for the session, counted
 *  by the PTY integrity monitor and fed to the Watchdog first; what its run
 *  needs bound (its lifecycle object's `bind`); and, for a launch it refuses
 *  or that fails, a throw having started nothing, or having ended what it
 *  started and let go of what it took. */
export interface ProviderLocalLaunch {
  start(request: LocalLaunchRequest, core: LocalLaunchCore): LocalLaunchStarted
}

/** A kept session as the session helper's record gives it to a take-over
 *  (sessions/kept-launches.ts KeptSessionFacts, by shape). */
export interface LifecycleKeptSession {
  readonly conversation: string | null
  readonly account: string | null
  readonly hookFolder: string | null
  readonly pick?: ResumePick
  readonly folder: string | null
  readonly at: number
  readonly hooks?: 'holder'
}

/** A kept session served while its tab is not shown (sessions/kept-launches.ts KeptUnseen, by shape). */
export interface LifecycleKeptUnseen {
  readonly sessionId: string
  readonly provider: ProviderId
  readonly hookFolder: string | null
  readonly pick?: ResumePick
  readonly folder: string | null
  readonly hooks?: 'holder'
}

/** The restored tab's launch a take-over replaces (sessions/launch-bindings.ts
 *  KeptTakeOverBinding, by shape): the provider the launch looked up, the
 *  configured folder resolved, the terminal's size, and what pty:spawn
 *  prepared (an account launch's lease and sessions folder, the account a
 *  launch names, an Ask Conductor launch). */
export interface LifecycleTakeOver {
  readonly win: BrowserWindow
  readonly sessionId: string
  readonly launch: { readonly id: ProviderId; readonly provider: SessionProvider }
  readonly resolvedCwd: string
  readonly cols: number
  readonly rows: number
  readonly codexLaunch?: { lease: AccountLease; sessionsDir: string }
  readonly profileId?: string
  readonly isAsk?: boolean
}

/** A provider's part of what the release of a kept session records of it
 *  (sessions/kept-launches.ts KeptLaunchFacts): what it knows, each field
 *  absent or null when it does not. */
export interface LifecycleFacts {
  readonly conversation?: string | null
  readonly account?: string | null
  readonly hookFolder?: string | null
  readonly pick?: ResumePick
}

/** 2.1.3-beta.19 section 2 (aicc_planning#439): what the app makes around a
 *  provider's local session and drops when it ends, the provider's own part
 *  (S2 of the seam audit). The launch bindings (sessions/launch-bindings.ts)
 *  ask the session's provider for it through the registry, never by its
 *  name: the take-over of a kept session, its serving while its tab is not
 *  shown, the first part of its teardown and its description for keeping.
 *  `bind` is what a launch binds once its process has started; its input is
 *  the provider's own launch's, and only that launch calls it (its local
 *  launch group, its take-over, or Claude Code's shell launch, kept in core
 *  until the local cutover). */
export interface ProviderLifecycle<Bind = unknown> {
  bind(binding: Bind, core: LifecycleCore): void
  /** The account a take-over asks the session helper for: null, no take-over
   *  (the launch was not prepared for one); no `account`, any; else that one
   *  (null: the provider's default account). */
  keptAccount(take: LifecycleTakeOver): { readonly account?: string | null } | null
  /** The bindings of a kept CLI that runs, in place of a launch's, before its
   *  holder is attached. Answers the account profile the session runs on, for
   *  the launch it replaces (undefined: none, or the default account). */
  takeOver(take: LifecycleTakeOver, proc: IPty, kept: LifecycleKeptSession, launchCwd: string, core: LifecycleCore): string | undefined
  /** Its tool calls served while its tab is not shown: the registrations from
   *  the tab's configured folder, and what reaches this run of its hooks. */
  serveUnseen(kept: LifecycleKeptUnseen, provider: SessionProvider, resolvedCwd: string, core: LifecycleCore): void
  /** The teardown's first part (every kill and exit): what the provider's own
   *  launch holds for the session goes. A no-op when it holds nothing. */
  unbind(sessionId: string, core: LifecycleCore): void
  /** What it knows of the session, for its release by an app update. */
  describe(sessionId: string, core: LifecycleCore): LifecycleFacts
}

/** How a session's telemetry finds its transcript. `cwd`: the resolved
 *  working directory the PTY runs in, which Codex uses to claim a new
 *  rollout. `spawnTimestamp`: Date.now() captured immediately before
 *  pty.spawn(), the lower bound of that claim (ts >= spawn - 5s).
 *  `sessionsDir`: where the session's realm writes its transcripts (Codex).
 *  Codex (P3.5): `resumeId`, the conversation the launch resumes (claimed
 *  wherever it is); `pickFile`, where the resume picker records its pick;
 *  `onClaim`, told which conversation the session is on once claimed.
 *  Claude ignores all of it (its telemetry is the statusline file watcher). */
export interface TelemetryOptions {
  cwd: string
  spawnTimestamp: number
  sessionsDir?: string
  resumeId?: string
  /** The rollout the launch chose for `resumeId`: claimed without a walk
   *  when it is still that conversation's, in this realm. */
  resumePath?: string
  pickFile?: string
  /** The pick file's folder as it was made: no pick is read, and nothing
   *  there removed, unless it is still that folder. */
  pickFolder?: PickFolderIdentity
  /** A take-over of a launch through the picker (aicc_planning#419): the
   *  decision the last run's watcher read, read here as the first. */
  picked?: ResumePick['decided']
  /** `certain` (P3.6): false when the rollout could have been another
   *  launch's (two new sessions in one folder, P3.5's recorded limit).
   *  `exact` (P3.10): the conversation is known, not inferred: a resume by
   *  id, the one a picker named, or the one the session's own hook reported
   *  (`fromHook`). */
  onClaim?: (claim: { id: string; cwd: string; certain: boolean; exact?: boolean; fromHook?: boolean }) => void
  /** Told when a claim is let go (the picker decided again after it). */
  onRelease?: () => void
  /** P3.6 (VM finding V2): the conversation the session is on when another
   *  session holds its rollout (a resume by id, the one a picker named, or
   *  since P3.10 the one its own hook reported): the session's all the
   *  same. Since P3.10 its rollout is read here too, as the holder reads it,
   *  so both tabs show its figures. onRelease is told when a later decision
   *  takes it back. */
  onShared?: (conversation: { id: string; cwd: string; exact?: boolean; fromHook?: boolean }) => void
  /** P3.12: the rollout claimed (path, the realm's sessions folder, exact,
   *  shared), told with each onClaim or onShared, and null when a claim is
   *  let go. Checked by the watcher; nothing else supplies it. */
  onRollout?: (rollout: { path: string; sessionsDir: string; exact: boolean; shared: boolean; identity?: string } | null) => void
}

export interface TelemetrySource {
  /** Stop the underlying watcher / tail when the session ends.
   *  `keepPickFolder` (aicc_planning#419): an app update keeps the session
   *  running, so its pick folder stays for its resume picker. */
  stop(opts?: { keepPickFolder?: boolean }): void
  /** Codex (aicc_planning#419): the launch's pick, while its folder is still
   *  the one made; null otherwise. */
  pick?(): ResumePick | null
  /** Codex (P3.10): the session's own hook reported `rolloutPath` as the
   *  conversation it is on. The watcher claims it exactly (it checks the
   *  path is a rollout inside its realm whose session_meta names the id in
   *  its name), or confirms the claim it has. Returns what it claimed, or
   *  null when the path is refused. */
  noteExactRollout?(rolloutPath: string): { id: string; cwd: string } | null
  /** Codex (P3.10): another session's hook proved `rolloutPath` is that
   *  session's conversation: a claim of it here that was only inferred is
   *  let go, and claiming goes on. True when a claim was let go. */
  refuteInferredClaim?(rolloutPath: string): boolean
  /** Codex (P3.12 round 1): a claim made beside another session's whose
   *  holder has let it go is this session's now: reported again. */
  recheckShared?(): boolean
}

/** 2.1.3-beta.15 B3 (aicc_planning#393): one key a quit types into a
 *  session's CLI: `data`, written `atMs` after the quit began. */
export interface ExitKey {
  readonly data: string
  readonly atMs: number
}

export interface HistorySession {
  provider: ProviderId
  sessionId: string
  cwd: string
  label: string
  model?: string
  lastModified: number
}

export interface SessionProvider {
  readonly id: ProviderId
  readonly displayName: string

  resolveBinary(legacyVersion?: LegacyVersion): { cmd: string; args: string[] } | null
  /** See ProviderSpawnCommand. */
  buildSpawnCommand(opts: SpawnOptions): ProviderSpawnCommand
  /** Whether `data` shows the provider's UI running. `commandSent`: whether
   *  the launch command has been written yet (Claude reads more of the screen
   *  as its UI once it has; absent = it has). */
  detectUiRunning(data: string, commandSent?: boolean): boolean
  /** 2.1.3-beta.15 B3 (aicc_planning#393): the keys a quit types into this
   *  provider's CLI when the app started it, in order, each at its time from
   *  the quit's start. Only the session input module types them
   *  (sendExitKeys, for the PTY manager's gracefulExitPty). */
  readonly exitKeys: readonly ExitKey[]

  /** Optional -- Claude only; Codex has no statusline shim. */
  deployStatuslineScript?(resourcesDir: string): Promise<void>
  /** Optional -- Claude only (WP2 PR 4: offered here so no module outside the
   *  package imports its statusline code). Strip the global statusLine stanza
   *  and planted script an older build left in the user's own settings; the
   *  boot heal, best-effort. */
  healGlobalStatusline?(): void
  /** Optional -- Claude only: hand one parsed statusline payload to the
   *  session's telemetry subscribers (ingestSessionTelemetry). The app's
   *  statusline dispatcher calls it for every payload. */
  deliverStatusline?(data: StatuslineData): void
  /** Optional -- Claude only: the `statusLine` value of a local session's
   *  settings file, running the bundled bridge script with the session id and
   *  the path of its status-URL file; null when a path the command would
   *  carry is one the shell would read as more than a path (the app sets up
   *  no status line); undefined when the deployed script is not one a launch
   *  may run (the provider says why in the log; the app sets up no status
   *  line). */
  statuslineSetting?(resourcesDir: string, sessionId?: string, statusUrlFile?: string): { type: 'command'; command: string } | null | undefined
  /** Optional -- Claude only: the session's statusline POST URL on the
   *  conductor MCP server ('' while the server is not bound or the MCP is off;
   *  throws rather than build a URL that fails its charset guard). */
  statusPostUrl?(sessionId: string, remoteMcpPort: number | undefined, mcpPort: number, includeConductorMcp: boolean): string
  /** Optional -- Codex: remove the conductor block an older build wrote into
   *  the user's own provider config; the MCP server asks at start and stop. */
  removeLegacyMcpServerConfig?(): void
  /** Optional -- Codex (2.1.3-beta.11, plan section B2): the launch of a
   *  session the session helper holds, with its `conductor` tool server
   *  started as the helper's relay in place of the loopback address, its
   *  switch and its credential variable, which the launch named before the
   *  holder existed. Asked only for the launch a holder runs; the usual start
   *  keeps the arguments the builder made. Pure: it reads nothing and writes
   *  nothing. */
  heldToolLaunch?(sessionId: string, launch: HeldToolLaunch, relay: HeldToolRelay): HeldToolLaunchAnswer
  /** Optional -- Claude only (2.1.3-beta.18 section 2): the launch of a
   *  session on another machine through the session helper there. Absent:
   *  the provider's SSH tabs take the usual SSH path. */
  readonly remoteLaunch?: ProviderRemoteLaunch
  /** Optional -- Codex only (2.1.3-beta.19 section 2): a local session whose
   *  CLI is the terminal's own program. A provider with this group is
   *  started by it (pty-manager.ts launchStyleOf); one with none is refused
   *  unless its row is Claude Code's shell launch. */
  readonly localLaunch?: ProviderLocalLaunch
  /** Optional -- both packages declare it (2.1.3-beta.19 section 2): what
   *  the app makes around the provider's local session and drops when it
   *  ends (bind, take over, serve while not shown, unbind, describe). A
   *  provider with none: its kept sessions are not taken over or served, and
   *  its sessions' teardown asks every registered provider's. */
  readonly lifecycle?: ProviderLifecycle
  /** Optional -- both packages declare it (2.1.3-beta.18, ADR-030 S12): the
   *  kinds a held session's holder takes and its connections report; how
   *  they reach the holder is the app's hook route (Claude Code: its settings
   *  file; Codex: its launch, as `hookKinds`). At most 16 plain words (ASCII
   *  letters and digits) of at most 64 characters, none twice. Absent, a
   *  session switched by its launch keeps its hooks as they are. */
  readonly heldHookKinds?: readonly string[]
  /**
   * Optional -- copy the provider's resume-picker script into
   * `<resourcesDir>/scripts/`. Both providers implement this in P4. The
   * Claude version copies `scripts/resume-picker.js`; the Codex version
   * copies `scripts/codex-resume-picker.js`.
   */
  deployResumePickerScript?(resourcesDir: string): Promise<void>
  /** Optional -- Codex (P3.10 round 4): prepare the folders the provider's
   *  hooks use, asynchronously and only while the provider is on, with
   *  `secureFolders`, the app's owner-only folder rule (given folders in
   *  order, it makes each this user's alone and reads it back; on Windows in
   *  one PowerShell call). A no-op while they are still ready. Resolves
   *  whether the launch's hook folder is ready. Never throws. `kept`
   *  (2.1.3-beta.14, S16 step 4, aicc_planning#359): the per-launch hook
   *  folders the session helper's records of the sessions an app update kept
   *  running name, asked when left-behind folders are swept; the sweep passes
   *  those by, whatever their age. */
  prepareHookFolders?(resourcesDir: string, secureFolders: (dirs: readonly string[]) => Promise<ReadonlyArray<{ dir: string; ok: boolean; detail?: string }>>, kept?: () => readonly string[]): Promise<boolean>
  /** Optional -- Codex (2.1.3-beta.14, S16 step 4): remove the per-launch
   *  hook folder of a session an app update kept running, once that session
   *  is no longer kept. Only a per-launch folder of this install's own hook
   *  root, emptied of what the app put there and removed as the sweep of
   *  left-behind folders removes one; any other path is left as it is. Never
   *  throws. */
  removeSessionHookFolder?(dir: string): void
  /** Optional -- Codex (2.1.3-beta.17, aicc_planning#407): at start, remove
   *  the per-launch resume-list folders a run left in the system's temp
   *  folder when it ended without its sessions' own end (a kill, a crash, a
   *  quiet uninstall), a day old or more and holding nothing but what the
   *  list writes; never a running session's. Never throws. */
  sweepLeftoverPickFolders?(): void
  /** Optional -- Codex (2.1.3-beta.17, S16 step 5): the hook file of a
   *  session an app update kept running, written again in that session's own
   *  per-launch folder (`dir`, the release's record) with this run's port and
   *  a token minted for the take-over: its CLI's hook reads the file at every
   *  event. Only a per-launch folder of this install's own hook root, as
   *  removeSessionHookFolder takes; the answer removes it the same way. Null
   *  when it cannot be written: nothing is started here. */
  rewriteSessionHooks?(dir: string, sessionId: string, port: number, secret: string): { hookFile: string; dispose(): void } | null
  /** Optional -- Codex (aicc_planning#419): the pick folder of a session an
   *  update kept running, once it is kept no longer: removed as its watcher's
   *  stop removes it, only while it is still the folder made. Never throws. */
  removeSessionPickFolder?(pick: ResumePick): void
  /** Optional -- Codex (2.1.3-beta.5): on macOS and Linux a launch that opens
   *  the resume list runs it on the node the user's login shell names. This
   *  asks that shell once, off the event loop, and keeps the answer for the
   *  launch to read, so no launch starts the shell in place. A no-op on
   *  Windows and once an answer is kept. Never rejects. */
  warmResumeListNode?(): Promise<void>
  /** Optional -- Codex (2.1.3-beta.6): a launch that resumes a conversation
   *  finds its rollout and compares the conversation's recorded folder with
   *  the tab's folder by real path too (a symlinked folder, a Windows
   *  junction), and checks that the tab's folder is a folder and not the home
   *  folder or above it. The real paths and the checks are asked of the disk
   *  off the event loop, each bounded, and kept for the launch to read; the
   *  walk of the sessions folder itself stays synchronous, as it was in the
   *  builder. `sessionsDir` is the launch's own realm's sessions folder,
   *  `sessionId` the tab's session, `configuredCwd` the folder the request
   *  names. Never rejects; with nothing kept the launch compares the exact
   *  spelling and asks the disk in place, as before. */
  warmResumeLookup?(target: { uuid: string; cwd: string }, sessionsDir: string, sessionId?: string, configuredCwd?: string): Promise<void>
  /** Optional -- Codex (P3.10): write the session's hook file (the Hooks
   *  gateway's port, the session id and its token, owner-only, in a folder
   *  made for the launch inside the app's own data folder, P3.10 round 1)
   *  for `buildSpawnCommand`'s `codexHooks`, with the way to remove it when
   *  the session's resources go. Null when it cannot be written, or when the
   *  hook folders were not prepared (round 4, prepareHookFolders): nothing is
   *  started here. */
  prepareSessionHooks?(sessionId: string, port: number, secret: string): { hookFile: string; dispose(): void } | null
  /** Optional -- Codex (P4.1): the skills folder of the provider home a
   *  launch runs in when the app stages its skills there per launch (a
   *  managed account's own folder, by path), else null (this computer's own
   *  sign-in, whose copies the app keeps through its own record instead,
   *  src/main/canvas/codex-user-skills.ts). Path arithmetic only. */
  stagedSkillsDir?(home: string, resourcesDir: string): string | null
  /** Optional: how the session input module's doors type into this
   *  provider's sessions (2.1.3-beta.18 section 4: each door asks the
   *  session's own provider here, and one with no rule for a door takes
   *  nothing there), and for Codex (P4.1, PB9) main's own reading of each
   *  run's screen and the submit primitive that types into its composer. */
  readonly runScreen?: SessionRunScreen
  /** Optional (ADR-032 row 14; plan 2.1.3-beta.21 phase 2, 2.1.2): this
   *  CLI's own clipboard image paste: its key per OS, the formats its read
   *  takes, and whether it reads a copied file itself. Absent: the paste
   *  module pastes no picture into this provider's sessions. */
  readonly clipboardPaste?: ClipboardPasteRule
  /** Subscribe to live telemetry for a spawned session (see TelemetryOptions). */
  ingestSessionTelemetry(
    sessionId: string,
    opts: TelemetryOptions,
    onUpdate: (data: StatuslineData) => void,
  ): TelemetrySource
  listHistorySessions(): Promise<HistorySession[]>
  resumeCommand(sessionId: string): { cmd: string; args: string[] }
  configureMcpServer(serverConfig: { name: string; url: string }): Promise<void>
}

/** 2.1.3-beta.14 B2 (aicc_planning#388): one read of the screen a session
 *  helper's holder keeps for a session (its `screen.read`): the size, the rows
 *  from the top (every row, unless `cut`: then only the bottom ones), and the
 *  window title the session's output last set ('' when it set none; null when
 *  the connection did not ask for it). Untrusted text, read strictly by the
 *  session helper's protocol reader before it gets here. */
export interface HeldScreenRows {
  cols: number
  rows: number
  cut: boolean
  title: string | null
  lines: ReadonlyArray<{ text: string; typed: string; inverse?: string; width?: number; end?: number }>
}

/** WP2 PR 4, P4.1: main's own pane of a session's run (bounded, headless, fed
 *  the run's output from its first byte) and the submit primitive, the one
 *  door through which main types a text into the session's composer. Every
 *  method is keyed by the app's session id; a respawn opens a new pane.
 *  2.1.3-beta.14 B2: a run its session helper holds is read from the
 *  holder's screen instead, and has no pane (`held`). 2.1.3-beta.17 C6: and
 *  the door for a saved image (`submitImage`).
 *
 *  2.1.3-beta.18 section 4 (aicc_planning#432; ADR-030 component rows 3 and
 *  14): each door of the session input module types through the run screen
 *  of the provider that runs the session, by that package's rule for the
 *  door (`retry`, `prompt`, `marker`, `image`, `ask`); a provider with no
 *  member for a door takes nothing there. A package that reads no screen of
 *  its own (Claude Code's) answers `has` false, does nothing at open, feed,
 *  resize and close, and has no `submit`; main opens a pane for a Codex run
 *  only. */
export interface SessionRunScreen {
  /** Open the pane for a session's new run, replacing any earlier one.
   *  `write`: one raw write into that run's process. `current`: whether that
   *  process is still the session's. `clamp`: what every chunk goes through
   *  before the pane parses it (the Watchdog's CSI clamp), with the pane's
   *  own state across chunks. `held` (B2): the run is a terminal a session
   *  helper may hold, which is known only once its first byte comes. Asked
   *  then: a read of the holder's screen, and no pane is opened; none (the
   *  terminal started the usual way, or its holder reads no screen), the pane
   *  is opened then, before that byte is fed. */
  open(sessionId: string, opts: { cols: number; rows: number; write: (data: string) => void; current: () => boolean; clamp: (data: string, state: { residual: string }) => string; held?: () => (() => Promise<HeldScreenRows>) | undefined }): void
  /** The run's output, as its terminal receives it. */
  feed(sessionId: string, data: string): void
  /** Keep the pane at the real pane's size (a holder keeps its own). */
  resize(sessionId: string, cols: number, rows: number): void
  /** The run ended or the session went: a submission still waiting reports
   *  the session gone and types nothing more. */
  close(sessionId: string): void
  /** Whether main reads this session's screen now: through its pane, through
   *  its holder, or (a held run before its first byte) through whichever its
   *  first byte decides. */
  has(sessionId: string): boolean
  /** Type `text` into the composer and submit it, confirmed on screen, after
   *  anything already in flight for the run; waits up to `readyWaitMs` for
   *  the ready, empty composer. Never rejects. `readyBy` (Date.now()'s clock)
   *  ends that wait at the latest, time spent queued included; `stillWanted`
   *  says no and nothing is typed (2.1.3-beta.10 section A2: the Watchdog's
   *  retry sets both). Absent (2.1.3-beta.18 section 4): the package reads
   *  no screen to confirm a text on. */
  submit?(sessionId: string, text: string, opts: { readyWaitMs: number; readyBy?: number; stillWanted?: () => boolean }): Promise<SubmitTextResult>
  /** 2.1.3-beta.17 C6 (aicc_planning#415): a saved image's path into the
   *  composer as the CLI's own paste, then `sentence`, then Enter, by the
   *  package's image rule, after anything already in flight for the run;
   *  waits up to `readyWaitMs` for the ready, empty composer. Never rejects.
   *  Absent: the package has no image rule of this kind. */
  submitImage?(sessionId: string, imagePath: string, sentence: string, opts: { readyWaitMs: number }): Promise<RunScreenImageResult>
  /** ADR-032 (plan 2.1.3-beta.21 phase 2): the CLI's own clipboard image
   *  paste on the package's own screen reading, after anything already in
   *  flight for the run (the door member `clipboard` says what it does).
   *  Never rejects. Absent: the package reads no screen of its own. */
  submitClipboard?(sessionId: string, key: string, sentence: string | null, opts: { readyWaitMs: number; placeholderWaitMs: number }): Promise<RunScreenClipboardResult>

  // 2.1.3-beta.18 section 4: the doors' members. The session input module
  // calls each for a session this provider runs, with the door's own waits
  // and the run the door was asked for (`typing`); a member types only
  // through `typing`, or through the package's own submit primitive. Absent:
  // the door takes nothing for this provider, logs one line, and never types
  // another provider's way.

  /** The Watchdog's retry (submitRetry): `text` into the session. A rule
   *  that reads the screen answers whether it was delivered, waiting up to
   *  `readyWaitMs` and no later than `readyBy`, and types nothing once
   *  `stillWanted` says no; a rule that types at once answers nothing.
   *  `enterDelayMs`: how long an Enter typed as its own write follows the
   *  text's last slice. */
  retry?(sessionId: string, text: string, opts: { readyWaitMs: number; readyBy: number; stillWanted?: () => boolean; enterDelayMs: number }, typing: RunScreenTyping): void | Promise<SubmitTextResult>
  /** A command bar prompt button's Send (submitPrompt; "Type it only" is
   *  the door's own, for any provider with this member): `text`, then its
   *  submission. `readyWaitMs`: how long a rule that reads the screen waits
   *  for the ready, empty composer; `maxCodePoints`: the longest text the
   *  door hands such a rule; `enterDelayMs`: how long an Enter typed as its
   *  own write follows the text's last slice. Never rejects. */
  prompt?(sessionId: string, text: string, opts: { readyWaitMs: number; maxCodePoints: number; enterDelayMs: number }, typing: RunScreenTyping): Promise<PromptButtonResult>
  /** An Agent Canvas marker line (submitMarker), filed on `canvasId` when the
   *  caller named one. A rule that reads the screen answers whether it was
   *  delivered, waiting up to `readyWaitMs`; a rule that holds the line for
   *  later answers nothing and tells the canvas itself. */
  marker?(sessionId: string, line: string, opts: { readyWaitMs: number; canvasId?: string }, typing: RunScreenTyping): void | Promise<SubmitTextResult>
  /** A saved image (submitImage): its path as the CLI's own paste, then
   *  `sentence`, then Enter. `readyWaitMs`: how long a rule that reads the
   *  screen waits for the ready, empty composer; `settleMs`: how long the
   *  sentence follows the paste's last slice; `enterDelayMs`: how long the
   *  Enter follows the sentence's. Never rejects. */
  image?(sessionId: string, imagePath: string, sentence: string, opts: { readyWaitMs: number; settleMs: number; enterDelayMs: number }, typing: RunScreenTyping): Promise<RunScreenImageResult>
  /** Ask Conductor's question (askQuestion, handOffAskQuestion), for a
   *  session that launched as Ask, waiting up to `readyWaitMs` for the
   *  ready, empty composer; `removed` is told how many characters were taken
   *  out first, when any were, because the prompt would drop them. Logs the
   *  question by its length only. Never rejects. */
  ask?(sessionId: string, question: string, opts: { readyWaitMs: number; removed: (count: number) => void }): Promise<SubmitTextResult>
  /** ADR-032 (plan 2.1.3-beta.21 phase 2, 2.1.3): the CLI's own clipboard
   *  image paste (pasteFromClipboard). `key` goes as ONE write through
   *  `typing`, never inside a bracketed paste; then the rule reads the CLI's
   *  image placeholder within `placeholderWaitMs`. With a `sentence` (a press
   *  from outside the terminal, and Snap) it then types the sentence and
   *  Enter; without one it types nothing more (the user is writing). No path
   *  is typed, and nothing is taken back. Never rejects. */
  clipboard?(sessionId: string, key: string, sentence: string | null, opts: { readyWaitMs: number; placeholderWaitMs: number; enterDelayMs: number }, typing: RunScreenTyping): Promise<RunScreenClipboardResult>
  /** 2.1.3-beta.19 section 6.2 (aicc_planning#440): how long, in ms, a lone
   *  Enter typed while one of this provider's held terminals was detached
   *  waits behind the frame before it once the terminal is attached again
   *  (session-helper/helper-pty.ts, flushQueued), so the CLI reads them
   *  apart: the holder writes frames that come back to back into one read.
   *  Absent, or not a positive number: what was queued goes at once, as for
   *  a plain terminal. */
  readonly heldEnterWaitMs?: number
}

/** 2.1.3-beta.18 section 4 (aicc_planning#432): what a door of the session
 *  input module hands a run screen's member for one run, the session's
 *  terminal process when the door was asked. Every byte a member types goes
 *  through `write`, the module's write port (writePty: its duplicate guard,
 *  its 256-byte slices, its launch-pending buffer), as every byte main types
 *  into a session does. */
export interface RunScreenTyping {
  /** The key that leaves tmux's scrollback view, for an SSH Persistent
   *  session ('' for every other session): a write starts with it where
   *  copy-mode would take the keys. */
  readonly leave: string
  /** True for a tab that runs through the session helper on its machine
   *  (2.1.3-beta.18 fix round): the holder there writes each write into the
   *  program whole, so a line and its Enter in one write reach the CLI as one
   *  read, and Claude Code (2.1.332, measured) takes a control character as a
   *  key only in a read shorter than 64 characters. A member types an Enter
   *  there as its own write. False for every other session. */
  readonly wholeWrites: boolean
  /** Whether the session's terminal process is still the run the door was
   *  asked for (false when it had none). */
  live(): boolean
  /** One write into the session's terminal through the write port. */
  write(data: string): void
  /** Resolves `delayMs` after the last slice the write port cuts `data`, just
   *  written, into has gone. */
  settled(data: string, delayMs: number): Promise<void>
  /** 2.1.3-beta.21 (ADR-032; plan block 5.1): the holder's screen of a tab
   *  through the session helper on its machine whose connection reads it
   *  (the remote helper's remoteTabScreen, read when the door is asked), for
   *  a member that reads the CLI's screen there (Claude Code's clipboard
   *  paste, its placeholder). Absent for every other session, and for a tab
   *  whose connection reads no screen now. */
  readonly heldScreen?: () => Promise<HeldScreenRows>
}

/** Why a run screen's image rule did not paste and send an image: the
 *  session gone; a path or sentence it refuses before typing anything; the
 *  ready, empty composer not seen in the wait (`busy-timeout`), or a prompt
 *  up; the CLI's image placeholder not shown after the paste; the sentence
 *  not confirmed on screen (`not-drawn`, `too-tall`); main reads no screen
 *  for the session, so the rule was not asked (`no-screen`, 2.1.3-beta.18
 *  section 4: the check moved from the image door into the package). */
export type RunScreenImageNotPasted = 'session-gone' | 'refused-text' | 'busy-timeout' | 'prompt-on-screen' | 'no-placeholder' | 'not-drawn' | 'too-tall' | 'no-screen'

/** 2.1.3-beta.17 C6: what a run screen's image rule did. `left`: what it
 *  typed may still be at the prompt (it could not take it back for certain);
 *  false when it typed nothing, or took it back and saw the composer empty. */
export type RunScreenImageResult =
  | { pasted: true }
  | { pasted: false; reason: RunScreenImageNotPasted; left: boolean }

/** ADR-032: what a run screen's clipboard paste member did. `placeholder`:
 *  the key went and the CLI showed its image placeholder; `sent`: and then
 *  the sentence and Enter. Otherwise why not: the session gone; the ready
 *  composer not seen in the wait before the key (`busy`, a press from outside
 *  the terminal only); no placeholder within the wait; the sentence not
 *  confirmed (the picture is at the prompt, unsent, and nothing was taken
 *  back); a prompt up after the placeholder, before the sentence was sent
 *  (`prompt-on-screen`: Enter would answer the prompt, so the hint does not
 *  ask for it; review round 2, R2-1); main reads no screen for the session
 *  (`no-screen`). */
export type RunScreenClipboardResult =
  | { outcome: 'placeholder' | 'sent' }
  | { outcome: 'session-gone' | 'busy' | 'no-placeholder' | 'sentence-not-sent' | 'prompt-on-screen' | 'no-screen' }

/** ADR-032 (row 14): a CLI's image paste key, as the bytes of one write, or
 *  none: `unbound`, the account's keybindings took the default away and
 *  bound nothing; `unexpressible`, it bound a chord the fixed chord table
 *  cannot send. `from` says where the chord came from. */
export type PasteKey =
  | { bytes: string; chord: string; from: 'default' | 'keybindings' }
  | { bytes: null; chord: string | null; why: 'unbound' | 'unexpressible' }

/** ADR-032 (row 14; plan 2.1.3-beta.21 phase 2, 2.1.2): one CLI's own
 *  clipboard image paste, per OS. It replaces the renderer's per-provider
 *  image line (session-capabilities.ts IMAGE_LINES), which only the path
 *  route behind the test switch still reads, through `pathRouteLine`. */
export interface ClipboardPasteRule {
  /** The key the app sends for the CLI's image paste in a session on this
   *  computer: `accountDir` is the config folder the session's launch gave
   *  the CLI (its account's own folder; null on this computer's own
   *  sign-in), whose own keybindings a CLI may read. */
  key(ctx: { platform: NodeJS.Platform; accountDir: string | null }): PasteKey
  /** Whether the CLI's clipboard read takes a copied image file itself, so
   *  the app writes nothing for one. */
  readsCopiedFile(platform: NodeJS.Platform): boolean
  /** The clipboard formats the CLI's read takes on `platform` (what the
   *  writer for that OS must leave on the clipboard). */
  formats(platform: NodeJS.Platform): readonly string[]
  /** Whether the program the CLI's clipboard read runs is missing on this
   *  computer (plan 2.1.3-beta.21 phase 3: Claude Code on Linux runs xclip
   *  or wl-paste), so the app sends no key and the hint names it; the paste
   *  module awaits it before the key. Absent: the CLI reads the clipboard
   *  itself. */
  clipboardToolMissing?(platform: NodeJS.Platform): boolean | Promise<boolean>
  /** The path route only (plan Q5, deleted in 2.1.3-beta.22): the line the
   *  renderer typed when main did not paste the path. */
  readonly pathRouteLine: 'enter' | 'composer'
}

export interface SshCapableProvider extends SessionProvider {
  getSshSettingsPath(sessionId: string): string
  /**
   * Path to the per-session MCP config file on the remote, passed via
   * `claude --mcp-config <path>`. Mirrors getSshSettingsPath but for the
   * canonical mcpServers registry (since Claude CLI ignores mcpServers in
   * --settings files).
   */
  getSshMcpConfigPath(sessionId: string): string
  /** Returns shell command to write settings + statusline shim on remote.
   *  opts mirror the renderer master switches (absent = on):
   *  includeStatusLine=false omits the statusLine stanza; includeConductorMcp=false
   *  writes an empty remote mcpServers (no built-in tools). includeAttention
   *  (absent = OFF, unlike the two above) gives the remote Claude the command
   *  hook that carries its attention events back over the terminal
   *  (ssh-attention.ts).
   *  `nonce` (#242 finding F1 (b)): host-generated per-session random token
   *  (randomId(), src/shared/id.ts) baked into the `setup ok` sentinel this
   *  command's script emits -- required, not optional, so a caller cannot
   *  silently regress to the pre-nonce sentinel shape. */
  configureRemoteSettings(
    sessionId: string,
    remotePath: string,
    hooksConfig: { port: number; secret: string } | null,
    opts: { includeStatusLine?: boolean; includeConductorMcp?: boolean; remoteMcpPort?: number; includeAttention?: boolean } | undefined,
    nonce: string,
  ): string
  /** configureRemoteSettings for a Windows remote (cmd.exe), same contract. */
  windowsRemoteSetupCommand(
    sessionId: string,
    opts: { includeStatusLine?: boolean; includeConductorMcp?: boolean; remoteMcpPort?: number } | undefined,
    nonce: string,
  ): string
  /** The launch line on a Windows remote, every variable set cmd.exe's way. */
  windowsLaunchCommand(input: { sessionId: string; envPrefixVars: string[]; extraFlags: string; continueFlag: string }): string
  /** The POSIX command that removes the per-session files a session planted
   *  on the remote; run over its own ssh exec when the session is closed. */
  remoteSessionCleanupCommand(sessionId: string): string
  /** The same removal on a Windows remote (cmd.exe or PowerShell); run over
   *  its own ssh exec on End and on a close. */
  windowsRemoteSessionCleanupCommand(sessionId: string): string
  /** The line a persistent (tmux) session writes before its launch to point
   *  the remote statusline at the staged tmux binary. */
  tmuxBinPatchCommand(sessionId: string): string
  /** End remote: kills exactly this session's tmux session and removes its
   *  per-session files (run over its own ssh exec). */
  remoteTmuxKillCommand(sessionId: string): string
  /** End remote: the in-container kill for a container runtime, '' for none.
   *  `sudoProbeNonce`: printed in a sentinel when sudo cannot elevate. */
  containerKillCommand(sessionId: string, runtime: SshRuntime | undefined, opts?: { hasSudoPassword?: boolean; sudoProbeNonce?: string }): string
  /** End remote: whether `output` carries this End's sudo sentinel. */
  parseEndSudoSentinel(output: string, nonce: string): boolean
  /** The last line of `data`, escapes stripped, as a shell-prompt candidate;
   *  '' when it is too long to be one or is the provider's own composer. */
  lastPromptLine(data: string): string
  /** SessionProvider.detectUiRunning with `commandSent` REQUIRED on the SSH
   *  surface: before the launch command is written only the strict reading
   *  applies, so a remote shell prompt that draws the composer glyph or box
   *  characters is never read as the UI. A call that drops the argument does
   *  not compile here (WP2 PR 4 review, A1-Q1). */
  detectUiRunning(data: string, commandSent: boolean): boolean
  /** Whether the end of `data` is a bare shell prompt (the CLI has exited). */
  looksLikeShellPromptTail(data: string): boolean
}

/** Type guard. It tells the one SSH-capable provider (Claude) apart from the
 *  rest by three members only that provider has; it does not vouch for the
 *  others. Every member is enforced at compile time on the class that
 *  implements SshCapableProvider (ClaudeProvider), and a registered package's
 *  session surface is that class; test fakes that drive only the spawn branch
 *  carry these three. */
export function isSshCapable(p: SessionProvider): p is SshCapableProvider {
  return 'getSshSettingsPath' in p && 'getSshMcpConfigPath' in p && 'configureRemoteSettings' in p
}
