import askMarkUrl from '../assets/aicc-code-conductor.svg'
import { newSince } from './upgrade-flow'

/**
 * The What's New feature showcase (owner-approved design, 2026-08-24; scope
 * revised 2026-08-25, #463): after the one-line summary page, each flagship
 * gets a full page of its own — heading, tagline, a few one-liner points, a
 * "where to find it" locator, and a drawn vignette (ShowcaseVignette).
 *
 * SHOWCASES_21 tours everything the 2.1 line added over 2.0, because it has
 * two audiences (#463): a 2.0 user deciding what the update gave them, and a
 * first-run user meeting these features for the first time. Copy must read
 * for both: name what the feature IS before what it replaced, and keep
 * upgrade-only framing ("three rows became one") out of headings.
 *
 * SHOWCASES_211 is the 2.1.1 story, told against 2.1.0 (O3, 2026-10-11):
 * Codex was already there, as a Beta with one switch and one sign-in, so the
 * pages lead with what changed, never with "Codex arrived". It is upgrade
 * only: a fresh install meets Codex on its own setup pages and in Hello
 * Codex, and the summary there stays the 2.1 story.
 *
 * Curated HERE, not in changelog.ts, for the same reason WhatsNewV2Step's
 * SECTIONS are: changelog.ts is a fragile pure-data literal that
 * scripts/gen-changelog.js extracts by bracket-matching, and the showcase is
 * editorial content for the upgrade flow, not part of the release record. By
 * construction nothing in this file can break `npm run changelog` or the
 * "Changelog in sync" CI.
 *
 * The summary page links here: a WhatsNewItem carrying `seeIt: '<page id>'`
 * grows a "See it →" chip that jumps to that page. An id with no matching page
 * renders no chip, so the two files cannot drift into a dead button.
 */

export type ShowcaseArtKind =
  | 'canvas'
  | 'watchdog'
  | 'oneRow'
  | 'panel'
  | 'accounts'
  | 'multiSpawn'
  | 'remoteResume'
  | 'sidebarMarks'
  | 'askConductor'
  // 2.1.1: drawings shared with Hello Codex (codex-art.tsx), and the usage page.
  | 'codexHello'
  | 'codexAccounts'
  | 'codexLaunch'
  | 'codexReview'
  | 'usage'

export interface ShowcasePoint {
  /** Bold lead-in, ending in a full stop unless the rest continues the sentence. */
  lead: string
  rest: string
  /** P3.6: this point alone is about something that needs Claude Code in
   *  this release, on a page that is not (the page's own `needsClaude`
   *  below): it is not shown while Claude Code is off. */
  needsClaude?: boolean
}

export interface ShowcasePage {
  id: string
  /** The first build that shipped this page, prerelease included (O2's
   *  table): the page shows only to someone whose anchor is older
   *  (whatsNewAnchorFor, newSince). Pinned by a frozen table in
   *  whatsnew-showcase.test.tsx, so a new page cannot inherit an old tag. */
  since: string
  /** Shown to upgraders only: the page is told against a before (2.1.1's
   *  Codex pages are told against 2.1.0). */
  upgradeOnly?: boolean
  heading: string
  tagline: string
  /** Three or four; more is a wall and belongs in the Feature Guide. */
  points: ShowcasePoint[]
  /** The muted locator under the points: pre + emphasised + post. */
  where: { pre: string; em: string; post: string }
  art: ShowcaseArtKind
  /** Optional brand-mark asset URL drawn beside the heading (#586). Only pages
   *  with a mark of their own set it; the copy column is otherwise unchanged. */
  mark?: string
  /** P3.4 (row 14): the page is about something that needs Claude Code in
   *  this release (Claude sessions only), so it is not shown while Claude
   *  Code is off. The phase that brings the feature to Codex lifts it (named
   *  in that phase's entry of docs/wp2/completion-plan.md: askConductor
   *  P4.3; P3.6 lifted it from accounts (P4.7 from its Insights point), P3.10
   *  from watchdog, and P4.1 from canvas); remoteResume keeps it, since Codex
   *  over SSH is outside this release. */
  needsClaude?: boolean
}

export const SHOWCASES_21: ShowcasePage[] = [
  {
    id: 'canvas',
    since: '2.1.0-rc.1',
    // O3 C3: "new to this line" read as news to a 2.1.0 user who has had the
    // canvas all along, and broke this file's own rule on upgrade framing.
    heading: 'The Agent Canvas',
    tagline: "Your agent renders its work as a real page inside the app. You point at what's wrong; it reads every note and fixes it all in one pass.",
    points: [
      { lead: 'Mockups, plans, your build.', rest: 'Ask for something visual and it appears on the canvas, versioned.' },
      { lead: 'Review needed, counted.', rest: 'The button turns amber with one number for every round owed.' },
      { lead: 'A note can offer choices.', rest: 'A/B/C chips — your click picks the winner, or name it in chat.' },
      { lead: 'Nothing is overwritten.', rest: 'History picks the artifact; a stepper walks its versions.' },
    ],
    where: { pre: 'Where: the ', em: 'Canvas', post: ' button in the session toolbar, beside Snap.' },
    art: 'canvas',
  },
  {
    id: 'oneRow',
    since: '2.1.0-rc.1',
    heading: 'One row runs the session',
    tagline: "Tools first, then your Global buttons, then this config's Session buttons — under every terminal, in a single row.",
    points: [
      { lead: 'It knows its session.', rest: 'A Codex session says Codex; on SSH, buttons say which computer runs them.' },
      { lead: 'Overflow folds', rest: 'into a per-band "N more" pill instead of wrapping under the terminal.' },
      { lead: 'Your buttons are reviewed, never changed.', rest: 'A clash carries a small amber mark until you look at it.' },
    ],
    where: { pre: 'Where: ', em: "under every session's terminal", post: '.' },
    art: 'oneRow',
  },
  {
    id: 'panel',
    since: '2.1.0-rc.3',
    heading: 'The left panel has two modes',
    tagline: 'Saved configs are the launcher; Running sessions are the work. Quick Start keeps your pinned configs one click away.',
    points: [
      { lead: 'Saved ⇄ Running.', rest: 'Two tabs, so launching and tending sessions stop sharing one crowded list.' },
      { lead: 'A config is a template.', rest: 'A running one shows a count pill, and its Quick Start pin can Start another instance.' },
      { lead: 'Sized by you.', rest: 'Drag the panel edge; the width sticks. Double-click resets it.' },
    ],
    where: { pre: 'Where: the ', em: 'left panel', post: ' — the tabs sit at the top of its sessions list.' },
    art: 'panel',
  },
  {
    id: 'multiSpawn',
    since: '2.1.0-rc.12',
    heading: 'Several copies of one config, on purpose',
    tagline: 'A saved config runs one session at a time unless you say otherwise. Mark it Allow Multi Spawn and it gains a copy count, a batch launcher, and a firm stop on the accidental double.',
    points: [
      { lead: 'Off unless you ask.', rest: 'A running config that is not Multi Spawn declines a second launch, and offers to enable it.' },
      { lead: 'A copy count on the row.', rest: 'Set it to 3, press once, three sessions start. It remembers the number you chose.' },
      { lead: 'Select, then launch the lot.', rest: 'Tick boxes on Saved and Quick Start, with a bar that counts what you picked.' },
      { lead: 'It reads what you already run.', rest: 'Configs you genuinely keep several copies of are switched on for you, once, after an update.' },
    ],
    where: { pre: "Where: a config's settings, under the ", em: 'connection cards', post: ' — then on the row itself.' },
    art: 'multiSpawn',
  },
  {
    id: 'remoteResume',
    since: '2.1.0-rc.12',
    needsClaude: true, // kept: resuming a remote Claude; Codex over SSH is excluded in this release
    heading: 'Pick a remote session back up',
    tagline: 'Leave a persistent SSH session running on its host and it waits for you in the sidebar. One click puts you back in the same Claude, in the same conversation.',
    points: [
      { lead: 'Docked at the foot of Running.', rest: 'A card each: the host, how long ago you left it, Resumable or Unreachable.' },
      { lead: 'Click to resume.', rest: 'Same session, same work. Launching the config from Saved always starts something new.' },
      { lead: 'Checked gently.', rest: 'A ping while you are looking; a real sign-in to the host only when there is a reason.' },
      { lead: 'Right-click to Remove.', rest: 'It ends the session on the host too, so nothing keeps a Claude you have finished with.' },
    ],
    where: { pre: 'Where: the ', em: 'Remote Resumable', post: ' section, at the bottom of the Running tab.' },
    art: 'remoteResume',
  },
  {
    id: 'sidebarMarks',
    since: '2.1.0-rc.12',
    heading: 'Read the sidebar at a glance',
    tagline: 'Three kinds of remote session wear three different marks, the account dot leads every row, and nothing hides behind the buttons that appear on hover.',
    points: [
      // aicc_planning#88: not "plain", which reads as "no AI" (Terminal only's word).
      { lead: 'Blue SSH.', rest: 'A remote session that ends when the link drops.' },
      { lead: 'Green SSH, with a chain link.', rest: 'Persistent, so it keeps running on the host without you.' },
      { lead: 'A teal container mark.', rest: 'The session runs inside a container on that host, named on hover.' },
      { lead: 'Identity first.', rest: 'The account dot leads the row, and loose configs sit under an Ungrouped heading that folds.' },
    ],
    where: { pre: 'Where: the ', em: 'Saved and Running tabs', post: ' — and the same three marks in the session header.' },
    art: 'sidebarMarks',
  },
  {
    // P3.6 (row 22): Claude Code and Codex alike switch mid-session, keeping
    // the conversation, so the page reads for both and shows with Claude
    // Code off; P4.7 (row 68) lifted its Insights point too: Run all makes one
    // report over every account of both assistants.
    id: 'accounts',
    since: '2.1.0-rc.3',
    heading: 'Every account, one app',
    tagline: 'Sign in to more than one account and switch mid-session. Usage and costs follow each account separately.',
    points: [
      { lead: 'Switch mid-session.', rest: 'The session restarts under the new account and resumes the same conversation.' },
      { lead: 'Usage at a glance.', rest: "The footer meters each account's window while you work." },
      { lead: 'Named and coloured.', rest: 'Give each account a name and a colour in Settings, Accounts; its sessions show them on the status strip and in the sidebar.' },
      { lead: 'Insights across accounts.', rest: 'With two or more signed in, reports read them all at once.' },
    ],
    where: { pre: 'Where: the ', em: 'account pill', post: ' at the left of the session strip switches it; add a second account and the footer meters each one.' },
    art: 'accounts',
  },
  {
    id: 'watchdog',
    since: '2.1.0-rc.1',
    heading: "The Watchdog waits so you don't have to",
    tagline: "A rate limit doesn't have to end your evening: the session reads the banner, waits out the reset, and types the retry itself.",
    points: [
      { lead: 'Off by default.', rest: 'One switch in Settings turns it on.' },
      { lead: 'Careful hands.', rest: 'It never types over your draft or an open prompt.' },
      { lead: 'It watches the screen you see', rest: '— the rendered pane, not a stale log.' },
    ],
    where: { pre: 'Where: ', em: 'Settings → General → Session Watchdog', post: '.' },
    art: 'watchdog',
  },
  {
    id: 'askConductor',
    since: '2.1.0-rc.14',
    heading: 'Ask Conductor',
    tagline: 'A session that has read the manual. Ask how the app works — settings, accounts, remote sessions — in plain English.',
    points: [
      { lead: 'Always there.', rest: 'Docked at the foot of the sidebar; opens as a tab and behaves like any session.' },
      { lead: 'Knows the app, not your code.', rest: "It answers for the Conductor and for the assistant it runs on, Claude Code or Codex, and says which one you're asking about." },
      { lead: 'It can install a helper skill.', rest: 'Say "install the skill" and your other sessions of that assistant on this machine (on Codex, those of that account) can answer Conductor questions themselves, such as which settings file wins or how accounts share settings, without opening this tab.' },
      { lead: 'Nothing happens without you.', rest: 'It explains and proposes; the one file the skill install writes goes through your approval, and so would any remote install.' },
    ],
    where: { pre: 'Where: the ', em: 'Ask Conductor', post: ' pill at the foot of the sidebar.' },
    art: 'askConductor',
    mark: askMarkUrl,
  },
]

/**
 * The 2.1.1 story (O3 B1-B5, as its verdict corrected them): what Codex became
 * in 2.1.1, told against 2.1.0. Nothing here offers or describes using the
 * computer's own Codex sign-in: that option is removed (owner rule,
 * 2026-10-11), and every Codex account is one the app adds.
 */
export const SHOWCASES_211: ShowcasePage[] = [
  {
    id: 'codexAssistant',
    since: '2.1.1-beta.2',
    upgradeOnly: true,
    heading: 'Codex is now a full assistant',
    // Worded as the summary's "Codex asks once." line is: it never names the
    // retired tab the way a pointer to it would (settings-codex-tab-retired).
    tagline: 'Codex no longer has its own Settings tab or single sign-in: it now has accounts of its own, its own setup, and most of what Claude sessions have.',
    points: [
      { lead: 'One switch each.', rest: 'The Providers card turns Claude Code and Codex on or off, and says whether each is installed and which version.' },
      { lead: 'Installed for you.', rest: "Codex missing or too old? Its row lists OpenAI's own commands, each with Run it for me and Copy." },
      { lead: 'Codex alone works too.', rest: 'With Claude Code off, Ask Conductor, Insights and Cloud Agents run on Codex.' },
      { lead: 'On this computer.', rest: 'In this release Codex sessions and reviews run locally, not over SSH.' },
    ],
    where: { pre: 'Where: ', em: 'Settings, Accounts', post: ', the Providers card at the top.' },
    art: 'codexHello',
  },
  {
    id: 'codexAccounts',
    since: '2.1.1-beta.2',
    upgradeOnly: true,
    heading: 'Codex accounts of their own',
    tagline: 'Add every Codex account you use. Each one signs in inside its own folder, so sessions never mix identities.',
    points: [
      { lead: 'ChatGPT or an API key.', rest: 'Sign in either way; a key goes to Codex, and this app never stores it.' },
      { lead: 'A default and a reviewer.', rest: 'New sessions use the default; reviews use the reviewer, or the default when none is set.' },
      { lead: 'Named and linked.', rest: "Click an account's round chip to name it, colour it, or link it to another of your accounts." },
      { lead: 'chatgpt.com in the app.', rest: 'Each Codex account can sign in to chatgpt.com from its menu, in its own browser storage.' },
    ],
    where: { pre: 'Where: ', em: 'Settings, Accounts', post: ', then Add Codex account.' },
    art: 'codexAccounts',
  },
  {
    id: 'codexSessions',
    since: '2.1.1-beta.2',
    upgradeOnly: true,
    // Not O3's "A Codex session works like a Claude one": the verdict has the
    // page lead with reopening, Restart and Switch Account, and some of a
    // Claude session's tools are still Claude's only (the safeguard check).
    // The shared tools are the summary's "The tools you know." line.
    heading: 'A Codex session keeps its place',
    tagline: 'A Codex session now comes back to its conversation, and keeps it through a restart or a change of account.',
    points: [
      { lead: 'It reopens where it was.', rest: 'A Codex session open when the app closed comes back in the same conversation, under the same account.' },
      { lead: 'Restart and pick a conversation.', rest: "From the session's Restart menu, choose an earlier conversation to carry on." },
      { lead: 'Switch Account.', rest: 'With two or more Codex accounts, move a running session to another and keep the conversation.' },
      { lead: 'Trust the hooks once.', rest: "For the attention dot, Codex asks once per account to review this app's hooks: choose Trust all and continue." },
    ],
    where: { pre: "Where: a Codex session's ", em: 'Restart menu', post: ', in its header.' },
    art: 'codexLaunch',
  },
  {
    id: 'codeReview',
    since: '2.1.1-beta.2',
    upgradeOnly: true,
    needsClaude: true, // a review asks the OTHER assistant: both must be on
    heading: 'Code review, both ways',
    // Told against 2.1.0: a Claude session could already ask Codex.
    tagline: 'A Codex session can now ask Claude for a second opinion, too.',
    points: [
      { lead: 'From a Codex session (new).', rest: 'Ask for a "Claude review", and Claude reviews the change on your Claude reviewer account.' },
      { lead: 'Reviewer accounts.', rest: 'Each review runs on the reviewer account of the assistant asked, or its default when none is set.' },
      { lead: 'A switch each way.', rest: 'Settings, General, Built-in Tools names the account each direction uses, and says why when a review cannot run.' },
      { lead: 'A separate reviewer.', rest: 'Each review is a one-off, read-only reviewer in the project; it never uses one of your open sessions.' },
    ],
    where: { pre: 'Where: ask in ', em: 'any session', post: '; the switches are in Settings, General, Built-in Tools.' },
    art: 'codexReview',
  },
  {
    id: 'usageBoth',
    since: '2.1.1-beta.2',
    upgradeOnly: true,
    heading: 'Usage and spend for Codex',
    tagline: 'Every Codex account gets its own usage and spend, kept apart from every other account and never merged.',
    points: [
      { lead: 'The Usage page.', rest: 'A section per assistant. A Codex account signed in with ChatGPT shows its 5-hour and weekly allowance, or its credits; an API-key account is billed per token.' },
      { lead: 'The usage strip.', rest: 'One pill per person at the foot of the window, grouped by provider.' },
      { lead: 'Tokenomics by account.', rest: 'Provider and Account filters, with each figure split by assistant.' },
      { lead: 'Insights for Codex.', rest: 'Pick a Codex account in the Insights account picker and run its report.' },
    ],
    where: { pre: 'Where: ', em: 'Account usage', post: ' on the left rail (with two or more accounts), and Tokenomics.' },
    art: 'usage',
  },
]

/** Every showcase page, oldest set first: the order the app changed in. */
export const SHOWCASES: readonly ShowcasePage[] = [...SHOWCASES_21, ...SHOWCASES_211]

/**
 * Which showcase pages to show someone whose anchor is `anchor`
 * (whatsNewAnchorFor): the pages new since it, oldest first, and for a fresh
 * install (`fresh`, no anchor) every page that is not upgrade-only.
 *
 * This reverses the earlier rule that the showcase did NOT depend on where
 * the user came from (O1/O2, 2026-10-11): that rule replayed all nine 2.1
 * pages on every 2.1.x update, beta.1 to beta.2 included. Now a 2.1.0 user
 * gets the 2.1.1 pages only; a 2.0 user gets the 2.1 pages and then the
 * 2.1.1 ones, fourteen after the rename page and the summary (an open owner
 * question on the Agent Canvas review); a fixes-only update gets
 * none. (First-run users see the 2.1 pages via the fresh-install step, #463:
 * the flagships ARE the app's introduction.)
 */
export function showcasesFor(anchor: string | undefined, opts: { fresh?: boolean } = {}): ShowcasePage[] {
  return SHOWCASES.filter((p) => newSince(p.since, anchor) && !(opts.fresh && p.upgradeOnly))
}
