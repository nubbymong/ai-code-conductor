import { useState } from 'react'
import { releaseLine } from '../utils/versionLabel'
import { compareVersions, finalRelease } from '../../shared/version-order'
import { useSettingsStore } from '../stores/settingsStore'
import { changelog, type ChangelogEntry } from '../changelog'
import { entriesSince, newSince } from './upgrade-flow'
import { showcasesFor, ShowcasePage } from './showcase-pages'
import { ShowcaseVignette } from './ShowcaseVignette'
import { RenamePageView } from './RenamePage'
import { usesClaude, usesCodex, claudeWasMissingAtSetup } from './provider-choice'
import { runningVersion } from './whats-new-gate'
import { codexAnswered } from './codex-reconfirm-gate'

export interface WhatsNewItem {
  /** Three or four words, ending in a full stop — it runs inline with `desc`. */
  title: string
  /** ONE line. If it needs two sentences, it belongs in the Feature Guide. */
  desc: string
  /** The first build that shipped what this line tells, prerelease included
   *  (`2.1.1-beta.2`, not `2.1.1`). The page shows a line only when it is
   *  newer than where the user comes from (the anchor: whatsNewAnchorFor).
   *  The frozen table in whatsnew-showcase.test.tsx pins every tag, so a new
   *  line cannot silently inherit a neighbour's. */
  since: string
  /** #463: a line that only makes sense against a BEFORE (“the app was
   *  renamed”) — hidden from the fresh-install cohort, who have no before. */
  upgradeOnly?: boolean
  /** The mirror of upgradeOnly: a line for the fresh-install cohort only,
   *  because upgraders are told the same thing in more detail elsewhere in
   *  their own set. */
  freshOnly?: boolean
  /** The line tells of the one-time Codex question that follows the run
   *  (CodexReconfirmPage), so it is hidden once that question is answered:
   *  every 2.1.1 prerelease anchors at 2.1.0, and a tester who answered on
   *  beta.2 is not asked again on beta.3 (decideCodexReconfirm). */
  untilCodexAnswered?: boolean
  /** Id of a showcase page (showcase-pages.ts). Grows a "See it →" chip that
   *  jumps to that page; an id with no matching page renders no chip. */
  seeIt?: string
  /** P3.4 (row 14): the line is about something that needs Claude Code in
   *  this release, so it is hidden while Claude Code is off (as upgradeOnly
   *  hides a line from a fresh install). The phase that brings the feature
   *  to Codex lifts it (named in that phase's entry of
   *  docs/wp2/completion-plan.md: Agent Canvas P4.1, Ask Conductor and the
   *  guide line P4.3; P4.7 lifted it from Insights; P3.6 lifted it from Switch mid-session,
   *  P3.10 from Session Watchdog). SSH Persistent and Remote Resumable keep it, as the
   *  remote resume page does: the persistent remote session wraps the
   *  remote claude command, and the only agent an SSH session runs in
   *  this release is Claude Code. */
  needsClaude?: boolean
}

export interface WhatsNewSection {
  heading: string
  /** P3.10: the heading while Claude Code is off, for a section that names
   *  Claude and keeps a line that works with Codex (the Watchdog's). */
  headingWithoutClaude?: string
  /** P4.11 (INT-7): the heading while Claude Code and Codex are both on, for
   *  a section whose lines now work for both. */
  headingWithCodex?: string
  items: WhatsNewItem[]
}

/**
 * The rename/roadmap prelude (#525): one page ahead of the summary. Upgraders
 * arriving from a build that predates the rename open on it — they knew the
 * app as Claude Command Center and are owed the why. `RENAME_SHIPPED_IN` is
 * the release whose changelog entry announced the rename; an upgrader whose
 * anchor is that or later has lived under the new name for their whole
 * tenure, and re-showing the page on every update would wear it out.
 * Fresh installs see the same page under a "Welcome to" lead-in (owner call,
 * canvas R1: the roadmap is the app's own introduction) — their gate is the
 * `fresh` flag, not this function.
 *
 * Declared ahead of the sections: the "New name." line is tagged with it.
 */
export const RENAME_SHIPPED_IN = '2.1.0-beta.6'

// The upgrade summary (registry step 0, when(): lastSeenVersion exists).
// Curated highlights only — the flow's own pages do the actual setup, and the
// full history stays in the Feature Guide. Fresh installs meet the same page
// after Welcome, under an introduction heading.
//
// SHAPE (user call 2026-08-21, replacing seven equal paragraph cards): named
// sections, one line per item. The card grid was rejected as "a horrible wall
// of text — people wont read that"; the fix is not smaller type but less of it,
// grouped so the eye can pick the part it cares about. If a line needs a second
// sentence to make sense, the line is wrong — link the Feature Guide instead.
//
// WHICH lines a user sees is decided per line by its `since` tag against the
// anchor (O1/O2, 2026-10-11): everything newer than where they come from, and
// nothing they have already been told. Sets are listed oldest first, the order
// the app changed in. A new release adds its own set below; the drift guard in
// whatsnew-showcase.test.tsx fails until the newest changelog release has one.
const SECTIONS_20: WhatsNewSection[] = [
  {
    heading: 'Setup & privacy',
    items: [
      { since: '2.0.0', title: 'Guided setup.', desc: 'Every feature asks before it turns on, and stays yours to change in Settings.' },
      { since: '2.0.0', title: 'A privacy pass.', desc: 'The status line and built-in tools are delivered per session; your global Claude config is never written.' },
    ],
  },
  {
    heading: 'Tools',
    items: [
      { since: '2.0.0', title: 'Built-in Tools, your call.', desc: 'Vision, code review, host screenshots and the Agent Canvas each get a real switch.' },
      { since: '2.0.0', title: 'Codex support.', desc: "Run OpenAI's Codex CLI beside Claude, with a switch of its own." },
    ],
  },
  {
    heading: 'Help',
    items: [
      { since: '2.0.0', title: 'A guide that answers back.', desc: 'The ? button opens a searchable guide, and a session that has read the docs.' },
    ],
  },
  {
    heading: 'Under the hood',
    items: [
      { since: '2.0.0', title: 'A modern engine.', desc: 'Electron 44, React 19 and xterm.js 6 — fast, on a current security baseline.' },
    ],
  },
]

// Tags: the first tag whose summary carried the line (git show v<tag>:...),
// as O2's table does for the showcase pages.
const SECTIONS_21: WhatsNewSection[] = [
  {
    heading: 'Sessions',
    items: [
      { since: '2.1.0-rc.12', title: 'SSH Persistent.', desc: 'A connection kind of its own — the remote session survives a dropped VPN.', needsClaude: true },
      { since: '2.1.0-beta.16', title: 'Partner terminal.', desc: 'A plain shell beside your session, labelled so you always know which is which.' },
      { since: '2.1.0-rc.1', title: 'One row.', desc: 'The tools and your command buttons sit in a single row under the terminal.', seeIt: 'oneRow' },
      { since: '2.1.0-rc.3', title: 'Two-mode panel.', desc: 'Saved configs and Running sessions each get a tab, with Quick Start pins — and the panel resizes.', seeIt: 'panel' },
      { since: '2.1.0-rc.12', title: 'Multi Spawn.', desc: 'Mark a config to run several copies at once; everything else is safe from a stray double launch.', seeIt: 'multiSpawn' },      { since: '2.1.0-rc.12', title: 'Remote Resumable.', desc: 'A persistent SSH session you left running waits at the foot of Running, one click from where you were.', seeIt: 'remoteResume', needsClaude: true },
      { since: '2.1.0-rc.12', title: 'Marks you can read.', desc: 'SSH, SSH Persistent and container sessions each wear their own mark, everywhere they appear.', seeIt: 'sidebarMarks' },
    ],
  },
  {
    heading: 'Working with Claude',
    headingWithoutClaude: 'Working with Codex',
    headingWithCodex: 'Working with Claude and Codex',
    items: [
      // WP2 PR 4, P4.1 (row 51): the canvas works in Codex sessions too.
      { since: '2.1.0-beta.16', title: 'Agent Canvas.', desc: "Your agent draws a mockup in the app. Mark up what's wrong; it picks the notes up.", seeIt: 'canvas' },
      { since: '2.1.0-rc.1', title: 'Session Watchdog.', desc: 'Waits out a rate limit and types the retry itself. Off by default.', seeIt: 'watchdog' },
      { since: '2.1.0-beta.16', title: 'Ask Conductor.', desc: 'A session that has read the docs — and can install a helper skill for the rest.', seeIt: 'askConductor' },
    ],
  },
  {
    heading: 'Accounts & usage',
    items: [
      // 2.1.1: Codex runs as a second assistant, with accounts of its own.
      // Fresh installs only: an upgrader is told this, in more detail, by
      // the 2.1.1 set below (O3: two "Codex accounts." lines otherwise).
      { since: '2.1.1-beta.2', title: 'Codex accounts.', desc: 'Codex runs beside Claude Code or alone, each account with its own sign-in.', freshOnly: true },
      // P3.6 (row 22): a Codex account switches mid-session too, keeping the
      // conversation; the claude.ai sign-in the line also named stays Claude's.
      { since: '2.1.0-beta.16', title: 'Switch mid-session.', desc: 'Change a running session\'s account without losing the conversation.', seeIt: 'accounts' },
      // Split out of the Switch mid-session line, which named it from beta.16.
      { since: '2.1.0-beta.16', title: 'claude.ai in the app.', desc: 'Sign in to claude.ai in-app, for each account.', needsClaude: true },
      { since: '2.1.0-beta.16', title: 'Insights.', desc: 'Usage reports across every account at once, not one at a time.' },
    ],
  },
  {
    heading: 'The app itself',
    items: [
      // O3 C12 follow-up: "nothing else changes" went with the rename bullet's
      // "Nothing changes": the earlier Codex setting does not carry over.
      { since: RENAME_SHIPPED_IN, title: 'New name.', desc: 'Claude Command Center is now AI Code Conductor; same install, same path.', upgradeOnly: true },
      { since: '2.1.0-beta.16', title: 'Signed and notarised.', desc: 'Windows signed, macOS notarised, every update SHA-256 checked.' },
    ],
  },
]

// The 2.1.1 story (O3 A1-A13, as its verdict corrected them), told against
// 2.1.0: Codex was already there as a Beta, so no line announces Codex as
// such, only what changed. Upgrade only, like its showcase pages: a fresh
// install keeps the 2.1 story and meets Codex on its own setup pages. Nothing
// here offers the computer's own Codex sign-in, which is removed (owner rule,
// 2026-10-11). "Accounts & usage" shares the 2.1 heading on purpose: a 2.0
// upgrader sees both sets, merged under one heading (summarySections).
const SECTIONS_211: WhatsNewSection[] = [
  {
    heading: 'Codex, a full assistant',
    items: [
      { since: '2.1.1-beta.2', upgradeOnly: true, title: 'Codex, no longer Beta.', desc: 'One Providers card turns each assistant on or off and installs Codex for you; Codex can run alone.', seeIt: 'codexAssistant' },
      { since: '2.1.1-beta.2', upgradeOnly: true, title: 'Codex accounts.', desc: 'Several Codex accounts, each signed in inside its own folder, with a default and a reviewer.', seeIt: 'codexAccounts' },
      { since: '2.1.1-beta.2', upgradeOnly: true, title: 'Sessions that carry on.', desc: 'A Codex session reopens in its conversation, restarts into an earlier one, and switches account.', seeIt: 'codexSessions' },
      { since: '2.1.1-beta.2', upgradeOnly: true, title: 'Claude reviews Codex too.', desc: 'A Codex session can now ask Claude for a review; each direction uses its own reviewer account.', seeIt: 'codeReview', needsClaude: true },
      { since: '2.1.1-beta.2', upgradeOnly: true, title: 'The tools you know.', desc: 'The Agent Canvas, Vision, the Session Watchdog, Plan mode, Compact and Logs work for Codex too.' },
    ],
  },
  {
    heading: 'Accounts & usage',
    items: [
      { since: '2.1.1-beta.2', upgradeOnly: true, title: 'Usage for Codex.', desc: 'The Usage page and the usage strip cover Codex accounts, each shown on its own, never merged.', seeIt: 'usageBoth' },
      { since: '2.1.1-beta.2', upgradeOnly: true, title: 'Tokenomics by account.', desc: 'Filter spend by provider and by account.' },
      { since: '2.1.1-beta.2', upgradeOnly: true, title: 'chatgpt.com in the app.', desc: 'Each Codex account can sign in to chatgpt.com, kept apart from every other account.' },
    ],
  },
  {
    heading: 'Across the app',
    items: [
      { since: '2.1.1-beta.2', upgradeOnly: true, title: 'Ask Conductor on Codex.', desc: 'It runs on Codex too; with both assistants on, pick which in Settings, General.' },
      { since: '2.1.1-beta.2', upgradeOnly: true, title: 'Three more for Codex.', desc: 'Sentinel, Insights and Cloud Agents cover Codex sessions and accounts too.' },
      { since: '2.1.1-beta.2', upgradeOnly: true, title: 'Claude 5.5 models.', desc: 'Opus 5.5, Sonnet 5.5 and Haiku 5.5 are in the model picker.', needsClaude: true },
      { since: '2.1.1-beta.1', upgradeOnly: true, title: 'Remote scrolling.', desc: "The mouse wheel scrolls an SSH Persistent session's history, as it does a local one.", needsClaude: true },
    ],
  },
  {
    heading: 'Before you start',
    items: [
      // The O3 verdict's A13: the line that tells an upgrader what to do next.
      // Every Codex account is one the app adds (owner rule, 2026-10-11).
      // Worded so it never names the retired tab the way a pointer to it
      // would (settings-codex-tab-retired.test.tsx sweeps the source).
      { since: '2.1.1-beta.2', upgradeOnly: true, untilCodexAnswered: true, title: 'Codex asks once.', desc: 'Codex no longer has its own Settings tab or single sign-in: answer once, then add a Codex account.' },
    ],
  },
]

// 2.1.3 (aicc_planning#117). "Sessions" shares the 2.1 heading on purpose, as
// "Accounts & usage" does above: an older upgrader sees one merged section.
const SECTIONS_213: WhatsNewSection[] = [
  {
    heading: 'Sessions',
    items: [
      { since: '2.1.3', title: 'Always a new conversation.', desc: 'Tick it in a config and its sessions skip the resume list and start fresh, every time.' },
    ],
  },
]

/** Every curated set, oldest first. */
export const WHATS_NEW_SECTIONS: readonly WhatsNewSection[] = [...SECTIONS_20, ...SECTIONS_21, ...SECTIONS_211, ...SECTIONS_213]

/**
 * The curated lines that are new to someone whose anchor is `anchor`
 * (whatsNewAnchorFor), in the order the app changed; a section left with no
 * line goes. No anchor (a fresh install) means every line. Cohort and
 * provider filters are the page's (summarySections). `sets` is for tests
 * that need a curated history of their own; the page uses the real one.
 */
export function sectionsFor(anchor: string | undefined, sets: readonly WhatsNewSection[] = WHATS_NEW_SECTIONS): WhatsNewSection[] {
  return sets
    .map((s) => ({ ...s, items: s.items.filter((it) => newSince(it.since, anchor)) }))
    .filter((s) => s.items.length > 0)
}

/** What a page view depends on beyond the anchor. */
export interface SummaryView {
  /** Where the user comes from (whatsNewAnchorFor); ignored when fresh. */
  anchor?: string
  /** The first-run cohort: nothing is "new" to them. */
  fresh: boolean
  /** Claude Code is in use (P3.4). */
  withClaude: boolean
  /** Codex is in use (P4.11 headings). */
  withCodex: boolean
  /** The one-time Codex question is answered (codexAnswered): the lines
   *  marked untilCodexAnswered go. Absent counts as not answered. */
  codexAnswered?: boolean
}

/** The `data-ux-id` of a section, from the heading it shows. */
export function sectionUxId(heading: string): string {
  return `section-${heading.toLowerCase().replace(/[^a-z]+/g, '-')}`
}

/**
 * The summary's sections as the page shows them: the lines new since the
 * anchor, for this cohort (upgradeOnly / freshOnly), these providers
 * (needsClaude) and the Codex answer (untilCodexAnswered), under the heading
 * each section shows for them.
 *
 * Sections that SHOW the same heading are merged, first one's place, lines in
 * order. Two sets can share a heading ("Accounts & usage"), and a provider
 * variant can land on another section's heading, while the heading is the
 * React key and the section's data-ux-id: a duplicate would collide on both.
 */
export function summarySections(v: SummaryView, sets: readonly WhatsNewSection[] = WHATS_NEW_SECTIONS): WhatsNewSection[] {
  const headingFor = (s: WhatsNewSection): string =>
    !v.withClaude ? s.headingWithoutClaude ?? s.heading : v.withCodex ? s.headingWithCodex ?? s.heading : s.heading
  const merged: WhatsNewSection[] = []
  for (const s of sectionsFor(v.fresh ? undefined : v.anchor, sets)) {
    const items = s.items.filter((it) =>
      !(v.fresh ? it.upgradeOnly : it.freshOnly) && (v.withClaude || !it.needsClaude) && !(v.codexAnswered && it.untilCodexAnswered))
    if (items.length === 0) continue
    const heading = headingFor(s)
    const same = merged.find((m) => sectionUxId(m.heading) === sectionUxId(heading))
    if (same) same.items = [...same.items, ...items]
    else merged.push({ heading, items })
  }
  return merged
}

/** The showcase pages the page shows, for this anchor, cohort and providers.
 *  P3.6: a page that shows with Claude Code off leaves out its points that
 *  need it. */
export function summaryShowcases(v: Omit<SummaryView, 'withCodex'>): ShowcasePage[] {
  return showcasesFor(v.fresh ? undefined : v.anchor, { fresh: v.fresh })
    .filter((p) => v.withClaude || !p.needsClaude)
    .map((p) => (v.withClaude ? p : { ...p, points: p.points.filter((pt) => !pt.needsClaude) }))
}

/**
 * An update with nothing curated since the anchor (O1/O2: a fixes-only
 * build) gets ONE line, made from the changelog entries since the anchor, and
 * never an older curated set as though it were new. With no entry since (a
 * downgrade, or a build whose changelog head is behind it) it reads the
 * running build's own entry; with none of that either, it says only that.
 */
export function fixesAndPolish(entries: readonly ChangelogEntry[], currentVersion: string): WhatsNewSection {
  // Each change type counted under its own name, so a feature is never
  // passed off as an "improvement".
  const counts = { fix: 0, improvement: 0, feature: 0 }
  for (const e of entries) for (const c of e.changes) if (c.type in counts) counts[c.type]++
  const named = (n: number, one: string, many: string) => (n > 0 ? `${n} ${n === 1 ? one : many}` : '')
  const parts = [
    named(counts.fix, 'fix', 'fixes'),
    named(counts.improvement, 'improvement', 'improvements'),
    named(counts.feature, 'new feature', 'new features'),
  ].filter(Boolean)
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
  const desc = list ? `${list} in this update.` : 'Small fixes in this update.'
  return { heading: 'This update', items: [{ since: currentVersion, title: 'Fixes and polish.', desc }] }
}

/** The changelog entries the fixes-only line counts (see fixesAndPolish). */
export function fixesEntries(entries: readonly ChangelogEntry[], anchor: string | undefined, currentVersion: string): ChangelogEntry[] {
  const since = entriesSince(entries, anchor, currentVersion)
  return since.length > 0 ? since : entries.filter((e) => compareVersions(e.version, currentVersion) === 0)
}

/** What the summary page shows: its sections, the showcase pages behind it,
 *  and whether this is the fixes-only page. */
export interface SummaryContent {
  sections: WhatsNewSection[]
  showcases: ShowcasePage[]
  fixesOnly: boolean
}

/**
 * The summary page's content for a view (WhatsNewV2Step renders exactly this).
 *
 * The empty delta is judged AFTER the cohort and provider filters (O2): a
 * Codex-only user whose only new lines need Claude Code has nothing new, and
 * neither has an upgrader whose only new line is the Codex question they have
 * already answered. Judged on the unfiltered lines instead, the page would
 * show no lines at all under a "things worth knowing" sub-line. A fixes-only
 * page has ONE line (fixesAndPolish over `entries` since the anchor) and no
 * showcase pages. `sets` is for tests; the page uses the real curated sets.
 */
export function summaryContent(
  view: SummaryView,
  entries: readonly ChangelogEntry[],
  currentVersion: string,
  sets: readonly WhatsNewSection[] = WHATS_NEW_SECTIONS,
): SummaryContent {
  const curated = summarySections(view, sets)
  const fixesOnly = !view.fresh && curated.length === 0
  const sections = fixesOnly ? [fixesAndPolish(fixesEntries(entries, view.anchor, currentVersion), currentVersion)] : curated
  const showcases = fixesOnly ? [] : summaryShowcases(view)
  return { sections, showcases, fixesOnly }
}

/** The summary heading: where the user comes from, when that reads as a real
 *  version older than this build (O1: "What's new in 2.1" named only the
 *  line, on a 2.1.1 build). A downgrade or an unreadable stamp gets the plain
 *  heading rather than a false "since". */
export function whatsNewHeading(anchor: string | undefined, currentVersion: string): string {
  return anchor && finalRelease(anchor) !== null && compareVersions(anchor, currentVersion) < 0
    ? `What's new since ${anchor}`
    : "What's new"
}

/** The line under the heading: singular for one line (O2: "1 things"). */
export function whatsNewSubLine(count: number, pages: number, fixesOnly: boolean): string {
  if (fixesOnly) return 'This update is fixes and polish.'
  const lines = `${count} ${count === 1 ? 'thing' : 'things'} worth knowing, in one line ${count === 1 ? '' : 'each'}`.trimEnd()
  if (pages === 0) return `${lines}.`
  return pages === 1
    ? `${lines}, and 1 of them has a page of its own, just behind this one.`
    : `${lines}, and ${pages} of them have a page of their own, just behind this one.`
}

export function showRenamePageFor(anchor: string | undefined, currentVersion: string): boolean {
  if (!anchor) return false // fresh installs are gated by `fresh`, not by version
  if (releaseLine(currentVersion) === '2.0') return false // the 2.0 line predates the rename
  // The beta-channel tester arm (owner call, canvas R2 2026-08-27) is gone: it
  // was scoped to "until we hit stable", and 2.1 is stable. A tester's anchor
  // already drops to the last final release (whatsNewAnchorFor), which keeps
  // them on the whole story of the release they test, never on the rename.
  return compareVersions(anchor, RENAME_SHIPPED_IN) < 0
}

function ShowcasePageView({ page, index, ofShowcases, claudeOn }: { page: ShowcasePage; index: number; ofShowcases: number; claudeOn: boolean }) {
  return (
    <div className="p2">
      <div className="p2-inner sc-page" style={{ width: 'min(1000px, 95vw)' }} data-ux-id={`showcase-page-${page.id}`}>
        <div className="sc-copy">
          {/* Counts SHOWCASES (1 of 3), not run pages — the footer's "Page 2 of
              4" includes the summary. Named apart so the two denominators are
              never confused for each other. */}
          <div className="sc-eyebrow" data-ux-id="showcase-eyebrow">Feature showcase · {index} of {ofShowcases}</div>
          {page.mark ? (
            <div className="sc-hgroup">
              <img src={page.mark} alt="" aria-hidden className="sc-mark" draggable={false} />
              <h2 className="sc-h" data-ux-id="showcase-heading">{page.heading}</h2>
            </div>
          ) : (
            <h2 className="sc-h" data-ux-id="showcase-heading">{page.heading}</h2>
          )}
          <p className="sc-tagline" data-ux-id="showcase-tagline">{page.tagline}</p>
          <div className="sc-points" data-ux-id="showcase-points">
            {page.points.map((pt) => (
              <div className="sc-pt" key={pt.lead}>
                <span className="wn-dot sc-dot" />
                <div><b>{pt.lead}</b> {pt.rest}</div>
              </div>
            ))}
          </div>
          <p className="sc-where" data-ux-id="showcase-where">
            {page.where.pre}<b>{page.where.em}</b>{page.where.post}
          </p>
        </div>
        <div className="sc-art" data-ux-id="showcase-art">
          <ShowcaseVignette kind={page.art} claudeOn={claudeOn} />
        </div>
      </div>
    </div>
  )
}

export function WhatsNewV2Step({
  onNext,
  ctaLabel = 'Set it up →',
  hint = 'The next pages set these up, one at a time.',
  fresh = false,
  anchor,
}: {
  onNext: () => void
  /** Footer CTA. The harness passes "Continue" when this page ends the run —
   *  on an ordinary upgrade there is usually nothing left to set up. */
  ctaLabel?: string
  hint?: string
  /** #463: first-run cohort — nothing is "new" to them, so the heading
   *  introduces the app instead of diffing it, and every line and page that
   *  is not upgrade-only shows. */
  fresh?: boolean
  /** Where this user comes from (whatsNewAnchorFor), fixed by the harness
   *  for the run from the boot snapshot. Never read from the live stamp: a
   *  stamp landing mid-run would reshape the pages under the user. */
  anchor?: string
}) {
  const current = runningVersion()
  // P3.4 (row 14): with Claude Code off (or setup found no Claude Code and
  // the run goes on with Codex only, as the Welcome page reads it) a line or
  // page about something that needs Claude Code is not shown.
  const withClaude = useSettingsStore((s) => usesClaude(s.settings)) && !claudeWasMissingAtSetup()
  const withCodex = useSettingsStore((s) => usesCodex(s.settings))
  // Read as the run's last hint reads it (OnboardingHarness, notesRunEndHint):
  // answered means the one-time Codex question does not follow this run.
  const answered = useSettingsStore((s) => codexAnswered(s.settings))
  const view: SummaryView = { anchor, fresh, withClaude, withCodex, codexAnswered: answered }
  // The empty delta is judged AFTER the cohort and provider filters (O2;
  // summaryContent, where the tests pin it).
  // The showcase (owner design 2026-08-24): the summary is page 0; each
  // flagship feature new since the anchor gets a full page behind it. With
  // no page for this user it collapses to exactly the old single-page step:
  // no dots, no skip, the harness CTA; and a fixes-only update has none.
  const { sections, showcases, fixesOnly } = summaryContent(view, changelog, current)
  const count = sections.reduce((n, s) => n + s.items.length, 0)
  // #525: pre-rename upgraders AND fresh installs (owner call, canvas R1)
  // open on the rename/roadmap page. The 2.0 line predates both the rename
  // and the roadmap, so it never shows it.
  const prelude = releaseLine(current) !== '2.0' && (fresh || showRenamePageFor(anchor, current)) ? 1 : 0
  const summaryIx = prelude
  const [pageIx, setPageIx] = useState(0)
  const total = prelude + 1 + showcases.length
  const isLast = pageIx === total - 1
  const jumpTo = (id: string) => {
    const ix = showcases.findIndex((p) => p.id === id)
    if (ix >= 0) setPageIx(summaryIx + 1 + ix)
  }
  return (
    <>
      {prelude === 1 && pageIx === 0 ? (
        <RenamePageView fresh={fresh} />
      ) : pageIx === summaryIx ? (
        <div className="p2">
          <div className="p2-inner" style={{ width: 'min(920px, 95vw)' }}>
            <h2 className="h2" data-ux-id="whatsnew-heading">{fresh ? <>What you&apos;re getting</> : whatsNewHeading(anchor, current)}</h2>
            <p className="p2-sub" data-ux-id="whatsnew-sub">{whatsNewSubLine(count, showcases.length, fixesOnly)}</p>

            <div className="wn-sections" data-ux-id="whatsnew-sections">
              {sections.map((s) => (
                <section key={s.heading} data-ux-id={sectionUxId(s.heading)}>
                  <h3 className="wn-sec-h">{s.heading}</h3>
                  {s.items.map((it) => (
                    <div className="wn-item" key={it.title}>
                      <span className="wn-dot" />
                      <div>
                        <span className="wn-t">{it.title}</span>{' '}
                        <span className="wn-d">{it.desc}</span>
                        {it.seeIt && showcases.some((p) => p.id === it.seeIt) && (
                          <button
                            type="button"
                            className="wn-see"
                            onClick={() => jumpTo(it.seeIt!)}
                            data-ux-id={`see-${it.seeIt}`}
                          >
                            See it &rarr;
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </div>

            <p className="gh-freebie" data-ux-id="whatsnew-pointer">
              The detail for any of these lives in <b>Feature Guide &rarr; What&apos;s New</b>, any time.
            </p>
          </div>
        </div>
      ) : (
        <ShowcasePageView page={showcases[pageIx - summaryIx - 1]} index={pageIx - summaryIx} ofShowcases={showcases.length} claudeOn={withClaude} />
      )}
      <div className="foot">
        <span className="hint" data-ux-id="whatsnew-hint">
          {/* Only the last page may promise what comes next — that is the
              harness-supplied `hint`, which knows whether anything follows.
              Earlier pages say only where you are: a hard-coded "the tour
              continues" is a lie on the common notes-only upgrade, the exact
              bug the hint plumbing exists to prevent (see OnboardingHarness). */}
          {isLast ? hint : `Page ${pageIx + 1} of ${total}.`}
        </span>
        {total > 1 && (
          <div className="wn-foot-dots" data-ux-id="whatsnew-dots" role="group" aria-label="Showcase pages">
            {prelude === 1 && (
              <button type="button" className={`wn-fdot${pageIx === 0 ? ' on' : ''}`} onClick={() => setPageIx(0)} aria-label="The new name" aria-current={pageIx === 0 ? 'page' : undefined} data-ux-id="whatsnew-dot-rename"><i /></button>
            )}
            <button type="button" className={`wn-fdot${pageIx === summaryIx ? ' on' : ''}`} onClick={() => setPageIx(summaryIx)} aria-label="Summary" aria-current={pageIx === summaryIx ? 'page' : undefined} data-ux-id="whatsnew-dot-summary"><i /></button>
            {showcases.map((p, ix) => (
              <button type="button" key={p.id} className={`wn-fdot${pageIx === summaryIx + 1 + ix ? ' on' : ''}`} onClick={() => setPageIx(summaryIx + 1 + ix)} aria-label={p.heading} aria-current={pageIx === summaryIx + 1 + ix ? 'page' : undefined} data-ux-id={`whatsnew-dot-${p.id}`}><i /></button>
            ))}
          </div>
        )}
        {!isLast && (
          <button type="button" className="skip wn-skip" onClick={onNext} data-ux-id="whatsnew-skip">
            Skip the showcase
          </button>
        )}
        <button
          className="cta"
          onClick={() => (isLast ? onNext() : setPageIx(pageIx + 1))}
          type="button"
          data-ux-id="whatsnew-cta"
        >
          {isLast ? ctaLabel : 'Next →'}
        </button>
      </div>
    </>
  )
}
