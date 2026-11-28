/**
 * Clipboard image paste on macOS and Linux app machines (ADR-032; plan
 * 2.1.3-beta.21 phase 3, 3.2 and 3.3; aicc_planning#447). Run ONLY by the
 * paste-e2e job (ci.yml) on the GitHub macOS and Ubuntu runners, never on
 * this repo's own computers: it launches the built app (out/main/index.js)
 * with real Claude Code 2.1.332 (PASTE_E2E_CLAUDE, the folder holding
 * `claude`, installed by the job from its platform package with scripts off)
 * and Codex 0.157.1 (PASTE_E2E_CODEX, its npm prefix) against probe P11's
 * model stand-in on a loopback port (helper/probes/p11-model-stand-in.cjs),
 * which names each PNG a turn carries by its decoded pixels
 * (helper/probes/png-rgba.cjs). Each CLI re-encodes what it reads from the
 * clipboard, so a picture is compared by its pixels, exactly.
 *
 * PASTE_E2E names the part: `probe` runs PM1 and PM2 (macOS) or PL1 (Linux);
 * `readings` runs the app's own route into each CLI. On Linux the job runs
 * the spec once per state of the two programs Claude Code reads the clipboard
 * with (PASTE_E2E_LINUX_TOOLS: `none`, `xclip`, `wl-paste`), installing and
 * removing them between runs, under Xvfb (X11). Every reading is written to
 * PASTE_E2E_OUT as JSON and printed as one `[paste-e2e]` line.
 *
 * DECISION LINES, fixed before measuring (plan 3.2).
 *   PM1 (macOS): after the app's write (its formats, built by
 *     src/main/paste/picture-formats.ts and written by one clipboard.write of
 *     one item in main, as src/main/paste/unix-writers.ts writes them),
 *     `osascript -e 'clipboard info'` lists «class PNGf» and «class TIFF»,
 *     and both CLIs, sent Ctrl+V (0x16) as one write, show "[Image #N]" and
 *     carry the picture by its pixels. Recorded beside it, for the cause if
 *     it fails: the W3C image/png write alone (the Windows writer), and that
 *     write with the TIFF added. If the app's write fails PM1, the writer
 *     becomes the candidate that passes; if none does, TIFF is added by
 *     osascript with sips (ADR-032's fallback).
 *   PM2 (macOS): what beta.20 gave each CLI with the terminal focused. Option+V
 *     typed the square root sign (the app sets no macOptionIsMeta); it is
 *     sent here, and whether a placeholder shows is recorded. A focused Ctrl+V
 *     or Cmd+V with no text sent nothing in beta.20 (its capture handler said
 *     nothing to paste, terminalKeybindings.ts at 49a8ddb9), so no byte
 *     reached either CLI; the byte the new route sends is PM1's. Recorded
 *     either way: the new route replaces both.
 *   PL1 (Linux, X11 under Xvfb): after the app's write (image/png), Claude
 *     Code with xclip, with wl-paste and with neither, and Codex, each sent
 *     Ctrl+V: does it show "[Image #N]" and carry the picture? Recorded
 *     beside it: the raw image/png write, and `xclip -o -t TARGETS` where
 *     xclip is installed. If a CLI does not attach under X11 (with its
 *     program there), Snap on Linux says it is not available on this
 *     computer in this beta, and the owner is told.
 *   READ, probe run 46139776011 (b33fd288). PM1: the app's write left
 *     «class PNGf» and TIFF picture (with the system's own translations
 *     beside them); Claude Code showed "[Image #N]" 345 ms after Ctrl+V and
 *     Codex 213 ms, each turn carrying the picture by its pixels: PM1 PASSES,
 *     and the writer stays as built. The W3C write alone and the W3C write
 *     with the TIFF were read the same way by both CLIs (recorded). PM2: the
 *     square root sign was typed into both CLIs' composers and no placeholder
 *     showed: beta.20's focused Option+V pasted nothing, as suspected. PL1:
 *     Codex attached in all three states (54 ms); Claude Code attached with
 *     xclip (59 ms; TARGETS listed image/png) and not with wl-paste alone or
 *     with neither. Both writes the same. So under X11 Claude Code needs
 *     xclip, and the hint's rule follows that reading (the Claude package's
 *     claudeClipboardToolMissing); no CLI is shown not available.
 * NOT MEASURED HERE, and written down as not measured: Wayland desktops, and
 * the macOS privacy prompt (Paste from Other Apps). The real-Mac check is
 * 2.1.3-beta.23's, with aicc_planning#448.
 *
 * READINGS (plan 3.3), every press asserted, --retries=0. For each CLI, a
 * picture as Snap leaves it (the app's formats, written in main), then:
 *   - the image paste key with the terminal focused (macOS: Option+V as a
 *     Mac sends it, key '√' and code KeyV, through the DevTools protocol;
 *     Linux: Alt+V): "[Image #N]" and nothing more typed; then a sentence and
 *     Enter typed here, and the turn carries the picture;
 *   - the same key from outside the terminal: the app sends the key, its
 *     sentence and Enter, and the turn carries the picture;
 *   - the text paste chord (Cmd+V on macOS, Ctrl+V on Linux) with only a
 *     picture on the clipboard (plan Q2), focused: "[Image #N]";
 *   - macOS: a copied PNG file (a file URL, as Finder leaves it) and the key
 *     from outside: Claude Code gets the picture the app writes, Codex reads
 *     the file itself; `clipboard info` after it is the app writer's own;
 *   - Linux under X11 without xclip (neither program, or wl-paste alone,
 *     which PL1 read does not serve Claude Code there): Claude Code gets no
 *     key and the paste hint names both programs; Codex pastes as before.
 * A red press is diagnosed from its readings, never retried.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { spawnSync } from 'child_process'
import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { launchIsolatedApp, closeIsolatedApp, type IsolatedApp } from './helpers/electron-app'
import { seedCodexAccount, realmDirOf, createCodexConfig, openSession, activeSessionId, terminalRows, answerFirstScreen, ptyWrite } from './helpers/codex-mode'
import { nextFirstScreen, FOOTER, type FirstScreenAnswer } from './helpers/codex-first-screens'
import { isolatedHomeDir } from './helpers/isolated-env'
import { macPictureFormats, linuxPictureFormats, osClipboardFormat, type PictureFormat } from '../../src/main/paste/picture-formats'
import { PASTE_NOTES } from '../../src/shared/clipboard-paste'

/** GitHub compares the dispatch input without case (ci.yml), so it is read in lower case. */
const MODE = (process.env.PASTE_E2E ?? '').toLowerCase()
const OUT = process.env.PASTE_E2E_OUT ?? path.resolve(__dirname, '../../test-results/paste-e2e')
const CODEX_PREFIX = process.env.PASTE_E2E_CODEX ? path.resolve(process.env.PASTE_E2E_CODEX) : ''
const CLAUDE_DIR = process.env.PASTE_E2E_CLAUDE ? path.resolve(process.env.PASTE_E2E_CLAUDE) : ''
/** Linux: which of the two programs the job left installed for this run. */
const TOOLS = process.env.PASTE_E2E_LINUX_TOOLS ?? ''
const IS_MAC = process.platform === 'darwin'
const IS_LINUX = process.platform === 'linux'
const CLAUDE_VERSION_UNDER_TEST = '2.1.332'
const CLAUDE_FAKE_KEY = 'sk-ant-e2e-fake-key-not-real-0000000000'
const CODEX_FAKE_KEY = 'sk-e2e-fake-key-not-real'
/** Everything but loopback goes nowhere (as snap-windows.spec.ts). */
const DEAD_PROXY = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
const START_MS = 120_000
const PLACEHOLDER_BOUND_MS = 15_000
const TURN_MS = 20_000
/** The app's own wait for a placeholder (session-input CLIPBOARD_PLACEHOLDER_WAIT_MS) and its sentence. */
const APP_PRESS_MS = 10_000 + 10_000
const CTRL_V = '\u0016'
const IMAGE_RE = /\[Image #\d{1,3}\]/g
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type StandInEvent = {
  ev: string; t: number; id: number; path?: string; kind?: string
  images?: Array<{ kind?: string; width?: number | null; height?: number | null; rgbaSha256?: string; rgbSha256?: string; pixelsUnread?: string; sha256?: string }>
}
type StandIn = { listen: () => Promise<number>; close: () => Promise<void> }
const req = createRequire(__filename)
const { createModelStandIn } = req('../../helper/probes/p11-model-stand-in.cjs') as { createModelStandIn: (o: { onEvent: (e: StandInEvent) => void }) => StandIn }
const { pngPixelHashes } = req('../../helper/probes/png-rgba.cjs') as { pngPixelHashes: (b: Buffer) => { rgbaSha256?: string; rgbSha256?: string; unread?: string } }

let ctx: IsolatedApp | undefined
let standIn: StandIn | undefined
const standInEvents: StandInEvent[] = []
const mainLines: string[] = []
const tabs: Record<'claude' | 'codex', { sid: string; label: string }> = { claude: { sid: '', label: 'Paste Claude' }, codex: { sid: '', label: 'Paste Codex' } }

function save(name: string, value: unknown): void {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(value, null, 2))
  console.log(`[paste-e2e] ${name} ${JSON.stringify(value)}`)
}

// ── the environment: a minimal one, never the runner's whole ───────────────
/** The runner's variables a launched app or CLI keeps, beside the ones the
 *  isolated launch sets itself (helpers/isolated-env.ts). */
// TMPDIR stays the runner's own: Chromium's single-instance socket is made
// in it, and a deeper folder would pass macOS's 104-byte socket path limit.
const KEEP = IS_LINUX ? ['USER', 'LOGNAME', 'LANG', 'TMPDIR', 'DISPLAY', 'XAUTHORITY'] : ['USER', 'LOGNAME', 'LANG', 'TMPDIR']
const FIXED_BY_LAUNCH = new Set(['NODE_ENV', 'E2E_HEADLESS', 'CCC_E2E_DATA_DIR', 'CCC_FORCE_SPLASH', 'USERPROFILE', 'HOME'])
const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
const nodeDir = path.dirname(process.execPath)

function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: [nodeDir, ...SYSTEM_PATH].join(':'), SHELL: IS_MAC ? '/bin/zsh' : '/bin/bash', TERM: 'xterm-256color' }
  for (const k of KEEP) { const v = process.env[k]; if (v) env[k] = v }
  return { ...env, ...extra }
}

/** The app's launch environment over the isolated one: every runner
 *  variable dropped but KEEP's and the launch's own, then the minimal set. */
function appEnv(extra: Record<string, string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const k of Object.keys(process.env)) if (!FIXED_BY_LAUNCH.has(k) && !KEEP.includes(k)) out[k] = undefined
  return { ...out, ...minimalEnv(extra) }
}

// ── seeding ────────────────────────────────────────────────────────────────
/** Every spelling of a folder (macOS: /var is /private/var). */
function spellings(dir: string): string[] {
  const s = new Set<string>([dir])
  try { s.add(fs.realpathSync.native(dir)) } catch { /* the name given */ }
  try { s.add(fs.realpathSync(dir)) } catch { /* the name given */ }
  return [...s]
}

/** Claude Code's folder: onboarding done, the made-up key approved, the project trusted. */
function seedClaudeConfig(dir: string, projectDir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const proj = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1, allowedTools: [] }
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: CLAUDE_VERSION_UNDER_TEST, theme: 'dark', numStartups: 1, autoUpdates: false,
    hasAcknowledgedCostThreshold: true, customApiKeyResponses: { approved: [CLAUDE_FAKE_KEY.slice(-20)], rejected: [] },
    projects: Object.fromEntries(spellings(projectDir).map((p) => [p, proj])),
  }, null, 2))
}

/** The Codex account's config: the model stand-in on loopback, no retries, the project trusted. */
function codexConfigToml(port: number, projectDir: string): string {
  return [
    '# paste-e2e (plan 2.1.3-beta.21 phase 3): TEST HARNESS ONLY, a throwaway Codex home. The model is the loopback stand-in; no network.',
    'model_provider = "pastee2e"',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.pastee2e]',
    'name = "paste-e2e model stand-in (loopback test harness)"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
    ...spellings(projectDir).flatMap((p) => [`[projects.'${p}']`, 'trust_level = "trusted"', '']),
  ].join('\n')
}

/** The job's Codex run once outside the app on the account's folder. */
function runCodexCli(dataDir: string, realm: string, args: string[], input?: string) {
  const home = isolatedHomeDir(dataDir)
  fs.mkdirSync(home, { recursive: true })
  return spawnSync(path.join(CODEX_PREFIX, 'bin', 'codex'), args, {
    env: minimalEnv({ HOME: home, CODEX_HOME: realm, ...DEAD_PROXY }), input, encoding: 'utf8', timeout: 60_000,
  })
}

async function launch(name: string): Promise<{ claudeProject: string; codexProject: string }> {
  expect(CODEX_PREFIX, 'PASTE_E2E_CODEX names the Codex the job installed').not.toBe('')
  expect(CLAUDE_DIR, 'PASTE_E2E_CLAUDE names the Claude Code the job installed').not.toBe('')
  standInEvents.length = 0
  mainLines.length = 0
  standIn = createModelStandIn({ onEvent: (e) => { standInEvents.push(e) } })
  const port = await standIn.listen()
  let claudeProject = ''
  let codexProject = ''
  ctx = await launchIsolatedApp({
    seedExtra: (dataDir) => {
      seedCodexAccount(dataDir, { fake: false, domTerminal: true, method: 'apiKey' })
      codexProject = path.join(dataDir, 'codex-project')
      claudeProject = path.join(dataDir, 'claude-project')
      fs.mkdirSync(codexProject, { recursive: true })
      fs.mkdirSync(claudeProject, { recursive: true })
      const realm = realmDirOf(dataDir)
      fs.writeFileSync(path.join(realm, 'config.toml'), codexConfigToml(port, codexProject))
      const login = runCodexCli(dataDir, realm, ['login', '--with-api-key'], `${CODEX_FAKE_KEY}\n`)
      if (login.status !== 0) throw new Error(`the made-up key's sign-in failed (exit ${login.status}): ${login.stderr}`)
      seedClaudeConfig(path.join(dataDir, 'claude-config'), claudeProject)
    },
    env: (dataDir) => appEnv({
      PATH: [path.join(CODEX_PREFIX, 'bin'), CLAUDE_DIR, nodeDir, ...SYSTEM_PATH].join(':'),
      CODEX_HOME: (() => { const d = path.join(dataDir, 'codex-home'); fs.mkdirSync(d, { recursive: true }); return d })(),
      CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude-config'),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: CLAUDE_FAKE_KEY,
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...DEAD_PROXY,
    }),
  })
  ctx.app.on('console', (m) => { mainLines.push(m.text()) })
  const area = await ctx.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  await (await ctx.app.browserWindow(ctx.page)).evaluate((w, b) => w.setBounds(b), { x: area.x, y: area.y, width: Math.min(1280, area.width), height: Math.min(800, area.height) })
  // What the app's login shell finds by name (it starts both CLIs through it), for a cause.
  const appPath = [path.join(CODEX_PREFIX, 'bin'), CLAUDE_DIR, nodeDir, ...SYSTEM_PATH].join(':')
  const found = spawnSync(IS_MAC ? '/bin/zsh' : '/bin/bash', ['-l', '-c', 'command -v claude; command -v codex; command -v xclip; command -v wl-paste'], { env: minimalEnv({ PATH: appPath, HOME: isolatedHomeDir(ctx.dataDir) }), encoding: 'utf8', timeout: 30_000 })
  save(`${name}-launched`, { platform: process.platform, tools: TOOLS || null, which: toolsHere(), loginShellFinds: (found.stdout ?? '').trim().split('\n') })
  return { claudeProject, codexProject }
}

/** This run's processes still running: their command line names its own
 *  data folder (a mkdtemp folder no other run has). */
function leftovers(dataDir: string): Array<{ pid: number; args: string }> {
  const r = spawnSync('/bin/ps', ['-A', '-o', 'pid=,args='], { env: minimalEnv(), encoding: 'utf8', timeout: 30_000 })
  return (r.stdout ?? '').split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), args: m[2] })).filter((p) => p.pid !== process.pid && p.args.includes(dataDir))
}

/** The end of a run: each CLI ended first (Ctrl+C twice), so no session's
 *  program outlives the app; then the app, the stand-in, and any process of
 *  this run still running, each stopped only while its command line still
 *  names this run's folder. Each step's time is recorded, for a cause (run
 *  46139776011's Linux run with neither program hit Playwright's 30 s worker
 *  teardown after this step had ended). */
async function closeAll(name: string): Promise<void> {
  const t0 = Date.now()
  const marks: Record<string, number> = {}
  const dataDir = ctx?.dataDir
  for (const cli of ['claude', 'codex'] as const) {
    if (!ctx || !tabs[cli].sid) continue
    for (let i = 0; i < 2; i++) { await ptyWrite(ctx.page, tabs[cli].sid, '\u0003').catch(() => undefined); await sleep(400) }
  }
  marks.clisEnded = Date.now() - t0
  await closeIsolatedApp(ctx)
  ctx = undefined
  marks.appClosed = Date.now() - t0
  await standIn?.close()
  standIn = undefined
  marks.standInClosed = Date.now() - t0
  const left = dataDir ? leftovers(dataDir) : []
  for (const p of left) {
    if (!leftovers(dataDir!).some((q) => q.pid === p.pid)) continue
    try { process.kill(p.pid, 'SIGKILL') } catch { /* gone */ }
  }
  marks.swept = Date.now() - t0
  save(`${name}-teardown`, { marks, leftovers: left.map((p) => ({ pid: p.pid, args: p.args.slice(0, 160) })), after: dataDir ? leftovers(dataDir).length : 0 })
}

/** Which of Claude Code's two Linux programs are installed (command -v). */
function toolsHere(): Record<string, string | null> {
  if (!IS_LINUX) return {}
  const out: Record<string, string | null> = {}
  for (const t of ['xclip', 'wl-paste']) {
    const r = spawnSync('/bin/sh', ['-c', `command -v ${t}`], { env: minimalEnv(), encoding: 'utf8', timeout: 10_000 })
    out[t] = r.status === 0 ? r.stdout.trim() : null
  }
  return out
}

// ── tabs ───────────────────────────────────────────────────────────────────
const screenOf = async (page: Page): Promise<string> => (await terminalRows(page)).map((r) => r.replace(/\s+$/, '')).join('\n')
const CLAUDE_READY_RE = /(?:^|\n) {0,2}─{8,} *\n {0,2}[❯>](?: [^\n]*)?\n {0,2}─{8,}/u
const CLAUDE_FIRST_SCREENS: Array<{ re: RegExp; keys: string[] }> = [
  { re: /No, exit[\s\S]*Yes, I trust this folder/, keys: ['\u001b[B', '\r'] },
  { re: /text style|Dark mode/i, keys: ['\r'] },
  { re: /use this API key/i, keys: ['\u001b[A', '\r'] },
  { re: /trust (the files in )?this folder/i, keys: ['\r'] },
  { re: /Press Enter to continue/i, keys: ['\r'] },
  { re: /Enter to (?:confirm|select|continue)/i, keys: ['\r'] },
]
/** Codex at its composer: the footer, and the prompt sign on the row above it. */
function codexAtRest(screen: string): boolean {
  const shown = screen.split('\n').filter((l) => l.trim() !== '')
  for (let i = shown.length - 1; i >= 1; i--) if (FOOTER.test(shown[i])) return /^ ?›(?: |$)/.test(shown[i - 1]) && !/esc to interrupt/i.test(screen)
  return false
}
const claudeAtRest = (screen: string) => CLAUDE_READY_RE.test(screen) && !/esc to interrupt/i.test(screen)
const atRest = async (cli: 'claude' | 'codex') => { const s = await screenOf(ctx!.page); return cli === 'codex' ? codexAtRest(s) : claudeAtRest(s) }

async function openClaudeTab(projectDir: string): Promise<void> {
  const page = ctx!.page
  await page.locator('[data-testid="panel-tab-saved"]').click()
  await page.locator('[data-testid="new-button"]').click()
  await page.locator('[data-testid="new-menu-config"]').click()
  await expect(page.locator('text=New saved config')).toBeVisible({ timeout: 30_000 })
  await page.locator('[role="radiogroup"][aria-label="Provider"] label:has(input[value="claude"])').click()
  await page.locator('[role="radiogroup"][aria-label="Connection"] label:has(input[value="local"])').click()
  await page.locator('input[placeholder*="path"]').first().fill(projectDir)
  await page.locator('input[placeholder="e.g. App Dev"]').fill(tabs.claude.label)
  await page.locator('[data-testid="session-dialog-submit"]').click()
  await expect(page.locator('text=New saved config')).toHaveCount(0, { timeout: 30_000 })
  await openSession(page, tabs.claude.label)
  tabs.claude.sid = await activeSessionId(page)
  const answered: string[] = []
  const deadline = Date.now() + START_MS
  while (Date.now() < deadline) {
    const text = await screenOf(page)
    const first = CLAUDE_FIRST_SCREENS.find((s) => s.re.test(text) && answered.filter((a) => a === s.re.source).length < 3)
    if (first && !CLAUDE_READY_RE.test(text)) {
      answered.push(first.re.source)
      for (const k of first.keys) { await ptyWrite(page, tabs.claude.sid, k); await sleep(300) }
      await sleep(700)
      continue
    }
    if (claudeAtRest(text)) { await sleep(300); if (await atRest('claude')) { save('claude-start', { answered, ms: START_MS - (deadline - Date.now()) }); return } }
    await sleep(250)
  }
  const screen = (await screenOf(page)).split('\n').filter((l) => l.trim()).slice(-25)
  save('claude-start', { answered, screen, mainLines: mainLines.filter((l) => /claude|launch|pty|spawn|refus/i.test(l)).slice(-60) })
  throw new Error(`no Claude Code prompt within ${START_MS} ms; the screen:\n${screen.join('\n')}`)
}

async function openCodexTab(projectDir: string): Promise<void> {
  const page = ctx!.page
  await createCodexConfig(page, { label: tabs.codex.label, dir: projectDir })
  await openSession(page, tabs.codex.label)
  tabs.codex.sid = await activeSessionId(page)
  const answered: FirstScreenAnswer[] = []
  const deadline = Date.now() + START_MS
  while (Date.now() < deadline) {
    const rows = await terminalRows(page)
    const next = nextFirstScreen(rows, answered)
    if (next.act === 'answer') { answered.push({ kind: next.kind, screen: await answerFirstScreen(page, tabs.codex.sid, next.kind) }); continue }
    if (codexAtRest(await screenOf(page))) { await sleep(300); if (await atRest('codex')) { save('codex-start', { answered: answered.map((a) => a.kind), ms: START_MS - (deadline - Date.now()) }); return } }
    await sleep(250)
  }
  const screen = (await screenOf(page)).split('\n').filter((l) => l.trim()).slice(-25)
  save('codex-start', { answered: answered.map((a) => a.kind), screen, mainLines: mainLines.filter((l) => /codex|launch|pty|spawn|refus/i.test(l)).slice(-60) })
  throw new Error(`no Codex composer within ${START_MS} ms; the screen:\n${screen.join('\n')}`)
}

async function show(cli: 'claude' | 'codex'): Promise<void> {
  await openSession(ctx!.page, tabs[cli].label)
  expect(await activeSessionId(ctx!.page)).toBe(tabs[cli].sid)
}

// ── pictures ───────────────────────────────────────────────────────────────
/** A 320 by 200 opaque pattern of its own for `seed`, as a PNG made in main. */
async function picturePng(app: ElectronApplication, seed: number): Promise<Buffer> {
  const b64 = await app.evaluate(({ nativeImage }, k) => {
    const width = 320
    const height = 200
    const bgra = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      bgra[i] = (x * 3 + k * 41) & 0xff; bgra[i + 1] = (y * 5 + k * 17) & 0xff; bgra[i + 2] = ((x ^ y) + k * 29) & 0xff; bgra[i + 3] = 255
    }
    return nativeImage.createFromBitmap(bgra, { width, height }).toPNG().toString('base64')
  }, seed)
  return Buffer.from(b64, 'base64')
}

/** The ways a picture is written in main: the app's own formats, and the
 *  candidates recorded beside them. */
type WriteWay = 'app' | 'w3c-png' | 'w3c-png+tiff' | 'raw-png'
function formatsFor(way: WriteWay, png: Buffer): PictureFormat[] {
  if (way === 'app') return IS_MAC ? macPictureFormats(png) : linuxPictureFormats(png)
  if (way === 'w3c-png') return [{ type: 'image/png', bytes: png }]
  if (way === 'w3c-png+tiff') return [{ type: 'image/png', bytes: png }, ...macPictureFormats(png).filter((f) => f.type === osClipboardFormat('public.tiff'))]
  return [{ type: osClipboardFormat('image/png'), bytes: png }]
}

/** One clipboard.write of one item in main, as src/main/paste/unix-writers.ts writes; then what main reads back. */
async function writeInMain(app: ElectronApplication, formats: PictureFormat[]): Promise<{ error: string | null; types: string[] }> {
  return app.evaluate(async ({ clipboard, ClipboardItem }, entries) => {
    let error: string | null = null
    try {
      const items: Record<string, Blob> = {}
      for (const [type, b64] of entries) items[type] = new Blob([new Uint8Array(Buffer.from(b64, 'base64'))])
      await clipboard.write([new ClipboardItem(items)])
    } catch (e) { error = (e as Error).message }
    let types: string[] = []
    try { types = (await clipboard.read()).flatMap((it) => it.types) } catch (e) { types = [`read failed: ${(e as Error).message}`] }
    return { error, types }
  }, formats.map((f) => [f.type, f.bytes.toString('base64')] as [string, string]))
}

/** What the OS says the clipboard holds: macOS clipboard info; Linux xclip's TARGETS where xclip is installed. */
function osClipboardReading(): string {
  if (IS_MAC) {
    const r = spawnSync('/usr/bin/osascript', ['-e', 'clipboard info'], { env: minimalEnv(), encoding: 'utf8', timeout: 30_000 })
    return `${r.stdout ?? ''}${r.stderr ? ` [stderr] ${r.stderr}` : ''}`.trim()
  }
  const xclip = toolsHere().xclip
  if (!xclip) return 'not read (no xclip)'
  const r = spawnSync(xclip, ['-selection', 'clipboard', '-o', '-t', 'TARGETS'], { env: minimalEnv(), encoding: 'utf8', timeout: 10_000 })
  return `${(r.stdout ?? '').trim().split('\n').join(',')}${r.stderr ? ` [stderr] ${r.stderr.trim()}` : ''}`
}

/** macOS: a PNG file copied to the clipboard as Finder leaves one (a file URL). */
function copyFileOnMac(file: string): string {
  const r = spawnSync('/usr/bin/osascript', ['-e', `set the clipboard to POSIX file "${file}"`], { env: minimalEnv(), encoding: 'utf8', timeout: 30_000 })
  return `${r.status}${r.stderr ? ` [stderr] ${r.stderr.trim()}` : ''}`
}

const placeholders = async (): Promise<number> => ((await screenOf(ctx!.page)).match(IMAGE_RE) ?? []).length
const requestsWith = (from: number, cli: 'claude' | 'codex', rgba: string) => standInEvents.slice(from).filter((e) => e.ev === 'request' && e.path === (cli === 'codex' ? '/v1/responses' : '/v1/messages') && (e.images ?? []).some((i) => i.rgbaSha256 === rgba))
const lastImages = (from: number, cli: 'claude' | 'codex') => standInEvents.slice(from).filter((e) => e.ev === 'request' && e.path === (cli === 'codex' ? '/v1/responses' : '/v1/messages')).map((e) => (e.images ?? []).slice(-1).map((i) => ({ kind: i.kind, width: i.width, height: i.height, unread: i.pixelsUnread })))

/** Wait for a new placeholder after `before`, up to `bound`; its time or null. */
async function placeholderAfter(before: number, bound: number): Promise<number | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < bound) {
    if ((await placeholders()) > before) return Date.now() - t0
    await sleep(50)
  }
  return null
}

/** Wait for a turn carrying `rgba` since `from`. */
async function turnCarried(from: number, cli: 'claude' | 'codex', rgba: string | undefined, bound = TURN_MS): Promise<boolean> {
  if (!rgba) return false
  const t0 = Date.now()
  while (Date.now() - t0 < bound) {
    if (requestsWith(from, cli, rgba).length > 0) return true
    await sleep(100)
  }
  return false
}

/** Back at rest after a turn (its reply on screen), so the next press meets the composer. */
async function settle(cli: 'claude' | 'codex'): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < TURN_MS) { if (await atRest(cli)) return; await sleep(250) }
}

/** The probes' press: a picture written in main by `way`, `key` typed into
 *  the CLI as a terminal would, the placeholder timed; then a sentence and
 *  Enter, and whether the turn carried the picture by its pixels. */
async function probePress(cli: 'claude' | 'codex', way: WriteWay, key: string, seed: number): Promise<Record<string, unknown>> {
  await show(cli)
  const png = await picturePng(ctx!.app, seed)
  const ref = pngPixelHashes(png)
  const r: Record<string, unknown> = { cli, way, key: key === CTRL_V ? 'Ctrl+V' : JSON.stringify(key) }
  r.write = await writeInMain(ctx!.app, formatsFor(way, png))
  r.os = osClipboardReading()
  const before = await placeholders()
  const from = standInEvents.length
  await ptyWrite(ctx!.page, tabs[cli].sid, key)
  r.placeholderMs = await placeholderAfter(before, PLACEHOLDER_BOUND_MS)
  if (r.placeholderMs === null) {
    r.screen = (await screenOf(ctx!.page)).split('\n').filter((l) => l.trim()).slice(-10)
    // Clear what the key typed, if anything, so the next press meets an empty composer.
    await ptyWrite(ctx!.page, tabs[cli].sid, '\u0015')
    await sleep(500)
    return r
  }
  await ptyWrite(ctx!.page, tabs[cli].sid, ` p11 probe pe-${cli}-${seed}`)
  await sleep(500)
  await ptyWrite(ctx!.page, tabs[cli].sid, '\r')
  r.turnCarriedPicture = await turnCarried(from, cli, ref.rgbaSha256)
  r.turnImages = lastImages(from, cli)
  await settle(cli)
  return r
}

// ── the app's own presses (readings) ───────────────────────────────────────
/** The image paste key as this OS sends it: macOS Option+V (key '√', code
 *  KeyV, Alt) through the DevTools protocol, so the app meets the event a
 *  Mac makes; Linux Alt+V. */
async function pressImageKey(page: Page): Promise<string> {
  if (IS_MAC) {
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: '√', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 9 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', modifiers: 1, key: '√', code: 'KeyV', text: '√', unmodifiedText: 'v' })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: '√', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 9 })
    } finally { await cdp.detach().catch(() => undefined) }
    return 'Option+V (key √, code KeyV)'
  }
  await page.keyboard.press('Alt+KeyV')
  return 'Alt+V'
}

/** The terminal focused as a click leaves it (xterm's input box), with no
 *  mouse event a CLI could read. */
const focusTerminal = async () => { await ctx!.page.locator('[data-terminal-active] textarea.xterm-helper-textarea').focus(); await sleep(200) }
const focusOutside = async () => { await ctx!.page.locator('[data-testid="panel-tab-running"]').focus(); await sleep(200) }
const hintShown = (text: string) => ctx!.page.locator('[role="status"]', { hasText: text })

/** One of the app's presses into `cli`, the picture written as Snap leaves it (or a copied file). */
async function appPress(cli: 'claude' | 'codex', how: 'image-focused' | 'image-outside' | 'text-chord' | 'copied-file', seed: number): Promise<Record<string, unknown>> {
  await show(cli)
  const png = await picturePng(ctx!.app, seed)
  const ref = pngPixelHashes(png)
  const r: Record<string, unknown> = { cli, how }
  if (how === 'copied-file') {
    const file = path.join(ctx!.dataDir, `copied-${seed}.png`)
    fs.writeFileSync(file, png)
    r.copied = copyFileOnMac(file)
  } else {
    r.write = await writeInMain(ctx!.app, formatsFor('app', png))
  }
  r.osBefore = osClipboardReading()
  const before = await placeholders()
  const from = standInEvents.length
  if (how === 'image-focused') { await focusTerminal(); r.key = await pressImageKey(ctx!.page) }
  else if (how === 'text-chord') { await focusTerminal(); await ctx!.page.keyboard.press(IS_MAC ? 'Meta+KeyV' : 'Control+KeyV'); r.key = IS_MAC ? 'Cmd+V' : 'Ctrl+V' }
  else { await focusOutside(); r.key = await pressImageKey(ctx!.page) }
  r.placeholderMs = await placeholderAfter(before, APP_PRESS_MS)
  if (how === 'copied-file') r.osAfter = osClipboardReading()
  if (r.placeholderMs === null) {
    r.screen = (await screenOf(ctx!.page)).split('\n').filter((l) => l.trim()).slice(-10)
    r.hint = await ctx!.page.locator('[role="status"]').allTextContents().catch(() => [])
    r.mainLines = mainLines.filter((l) => /\[paste\]/.test(l)).slice(-6)
    return r
  }
  if (how === 'image-focused' || how === 'text-chord') {
    await sleep(300)
    r.typedAfterKey = (await screenOf(ctx!.page)).includes('I just pasted an image')
    await ptyWrite(ctx!.page, tabs[cli].sid, ` p11 probe pe-${cli}-${seed}`)
    await sleep(500)
    await ptyWrite(ctx!.page, tabs[cli].sid, '\r')
  }
  r.turnCarriedPicture = await turnCarried(from, cli, ref.rgbaSha256, TURN_MS + 10_000)
  r.turnImages = lastImages(from, cli)
  r.mainLines = mainLines.filter((l) => /\[paste\]/.test(l)).slice(-3)
  await settle(cli)
  return r
}

const skipUnless = (want: 'probe' | 'readings') => {
  test.skip(!IS_MAC && !IS_LINUX, 'macOS and Linux app machines: the GitHub macOS and Ubuntu runners')
  test.skip(MODE !== want, `the paste-e2e job with paste_e2e=${want} only (ci.yml)`)
}

// ── PM1, PM2 (macOS) and PL1 (Linux) ───────────────────────────────────────
test.describe('paste probes: PM1 and PM2 on macOS, PL1 on Linux', () => {
  test.describe.configure({ mode: 'serial' })
  skipUnless('probe')
  const rows: Array<Record<string, unknown>> = []
  test.beforeAll(async () => {
    test.setTimeout(60_000 + 2 * START_MS + 60_000)
    const { claudeProject, codexProject } = await launch(`probe${TOOLS ? `-${TOOLS}` : ''}`)
    await openCodexTab(codexProject)
    await openClaudeTab(claudeProject)
  })
  test.afterAll(async () => {
    test.setTimeout(60_000)
    save(`probe${TOOLS ? `-${TOOLS}` : ''}`, { platform: process.platform, tools: TOOLS || null, which: toolsHere(), rows, paste: mainLines.filter((l) => /\[paste\]/.test(l)).slice(-40) })
    await closeAll(`probe${TOOLS ? `-${TOOLS}` : ''}`)
  })

  test(IS_MAC ? 'PM1: each write\'s formats, and both CLIs on Ctrl+V' : 'PL1: each write\'s formats, and both CLIs on Ctrl+V', async () => {
    const ways: WriteWay[] = IS_MAC ? ['app', 'w3c-png', 'w3c-png+tiff'] : ['app', 'raw-png']
    test.setTimeout(ways.length * 2 * (PLACEHOLDER_BOUND_MS + TURN_MS * 2 + 10_000) + 60_000)
    let seed = 10
    for (const way of ways) {
      for (const cli of ['claude', 'codex'] as const) {
        const r = await probePress(cli, way, CTRL_V, ++seed)
        rows.push({ probe: IS_MAC ? 'PM1' : 'PL1', ...r })
        console.log(`[paste-e2e] ${IS_MAC ? 'PM1' : 'PL1'} ${JSON.stringify(r)}`)
      }
    }
  })

  test('PM2: beta.20\'s focused Option+V (the square root sign typed) into each CLI', async () => {
    test.skip(!IS_MAC, 'macOS only')
    test.setTimeout(2 * (PLACEHOLDER_BOUND_MS + TURN_MS * 2 + 10_000) + 60_000)
    let seed = 40
    for (const cli of ['claude', 'codex'] as const) {
      const r = await probePress(cli, 'app', '√', ++seed)
      rows.push({ probe: 'PM2', ...r, ctrlV: 'beta.20 sent no byte for a focused Ctrl+V or Cmd+V with no text (terminalKeybindings.ts at 49a8ddb9); the byte the new route sends is PM1\'s' })
      console.log(`[paste-e2e] PM2 ${JSON.stringify(r)}`)
    }
  })
})

// ── READINGS: the app's own route into each CLI ────────────────────────────
test.describe('paste readings: the app\'s own route into Claude Code and Codex', () => {
  test.describe.configure({ mode: 'serial' })
  skipUnless('readings')
  const rows: Array<Record<string, unknown>> = []
  test.beforeAll(async () => {
    test.setTimeout(60_000 + 2 * START_MS + 60_000)
    const { claudeProject, codexProject } = await launch(`readings${TOOLS ? `-${TOOLS}` : ''}`)
    await openCodexTab(codexProject)
    await openClaudeTab(claudeProject)
  })
  test.afterAll(async () => {
    test.setTimeout(60_000)
    save(`readings${TOOLS ? `-${TOOLS}` : ''}`, { platform: process.platform, tools: TOOLS || null, which: toolsHere(), rows, paste: mainLines.filter((l) => /\[paste\]/.test(l)).slice(-60) })
    await closeAll(`readings${TOOLS ? `-${TOOLS}` : ''}`)
  })

  /** Whether Claude Code's program is there for this run (always on macOS). */
  const claudeCanRead = () => IS_MAC || TOOLS === 'xclip'
  const hows = (): Array<'image-focused' | 'image-outside' | 'text-chord' | 'copied-file'> => (IS_MAC ? ['image-focused', 'image-outside', 'text-chord', 'copied-file'] : ['image-focused', 'image-outside', 'text-chord'])

  for (const cli of ['codex', 'claude'] as const) {
    test(`${cli}: the image paste key in and out of the terminal, the text chord with only a picture${IS_MAC ? ', a copied file' : ''}`, async () => {
      test.skip(IS_LINUX && TOOLS === 'wl-paste', 'Linux with wl-paste alone: Codex is read with neither and with xclip; Claude Code\'s hint is the test below')
      test.skip(cli === 'claude' && !claudeCanRead(), 'Linux without xclip: Claude Code\'s hint is the test below')
      test.setTimeout(hows().length * (APP_PRESS_MS + TURN_MS * 3 + 10_000) + 60_000)
      let seed = cli === 'codex' ? 60 : 80
      const mine: Array<Record<string, unknown>> = []
      for (const how of hows()) {
        const r = await appPress(cli, how, ++seed)
        mine.push(r)
        rows.push(r)
        console.log(`[paste-e2e] reading ${JSON.stringify(r)}`)
      }
      for (const r of mine) {
        expect(r.placeholderMs, `${cli} ${r.how}: "[Image #N]" within the app's wait`).not.toBeNull()
        expect(r.turnCarriedPicture, `${cli} ${r.how}: the turn carried the picture, by its pixels`).toBe(true)
        if (r.how === 'image-focused' || r.how === 'text-chord') expect(r.typedAfterKey, `${cli} ${r.how}: nothing typed after the key`).toBe(false)
      }
    })
  }

  test('Linux under X11 without xclip (neither program, or wl-paste alone): Claude Code gets no key, and the hint names both', async () => {
    test.skip(!IS_LINUX || (TOOLS !== 'none' && TOOLS !== 'wl-paste'), 'Linux without xclip only')
    test.setTimeout(APP_PRESS_MS + 60_000)
    expect(toolsHere(), 'what the job left installed').toEqual(TOOLS === 'none' ? { xclip: null, 'wl-paste': null } : { xclip: null, 'wl-paste': '/usr/bin/wl-paste' })
    await show('claude')
    const png = await picturePng(ctx!.app, 99)
    const w = await writeInMain(ctx!.app, formatsFor('app', png))
    const before = await placeholders()
    const from = standInEvents.length
    await focusOutside()
    await pressImageKey(ctx!.page)
    await expect(hintShown('xclip')).toBeVisible({ timeout: 5_000 })
    const hint = await hintShown('xclip').textContent()
    rows.push({ cli: 'claude', how: 'no-clipboard-tool', write: w, hint })
    expect(hint).toContain(PASTE_NOTES['no-clipboard-tool'])
    await sleep(2_000)
    expect(await placeholders(), 'no key: no placeholder').toBe(before)
    expect(standInEvents.slice(from).filter((e) => e.ev === 'request' && e.path === '/v1/messages'), 'no turn').toEqual([])
  })
})
