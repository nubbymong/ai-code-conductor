import type { ReactNode } from 'react'
import type { ShowcaseArtKind } from './showcase-pages'
import askMarkUrl from '../assets/aicc-code-conductor.svg'
import { CodexAccountsArt, HelloArt, LaunchArt, ReviewArt } from './codex-art'

/**
 * The drawn illustrations for the What's New showcase pages — pure CSS
 * mini-app vignettes (styles in onboarding.css under `.sv-*`), no screenshots
 * and no emoji, per the project's JSX conventions. Decorative: every vignette
 * is aria-hidden, because the copy beside it says everything it draws.
 *
 * These are pictures OF the features, not the features: a change to the real
 * canvas pane or command bar does not oblige a change here, only a glance at
 * whether the picture still tells the truth.
 */

function CanvasVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-canvas">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-toolrow">
        <span className="sv-toolchip">Snap</span>
        <span className="sv-toolchip sv-amber">Review needed · 2</span>
        <span className="sv-toolchip">Logs</span>
        <span className="sv-toolchip">Browser</span>
      </div>
      <div className="sv-body">
        <div className="sv-main">
          <div className="sv-mode-line"><span className="sv-mode">MOCKUP</span><span className="sv-keel" /></div>
          <div className="sv-chips"><span className="sv-chip sv-on">Inspect</span><span className="sv-chip">Sketch</span><span className="sv-chip">Region</span></div>
          <div className="sv-framed">
            <span className="sv-frame-tag">PAGE UNDER REVIEW</span>
            <div className="sv-form">
              <div className="sv-mock-h" />
              <div className="sv-mock-field" />
              <div className="sv-mock-field" />
              <div className="sv-mock-btn" />
            </div>
            <span className="sv-pin">1</span>
            <div className="sv-note">
              <div className="sv-note-who">Your note · #1</div>
              <div className="sv-note-txt">The button feels cramped against the fields.</div>
              <div className="sv-abc"><span className="sv-pick">A · more gap</span><span>B · full width</span><span>C · move right</span></div>
            </div>
          </div>
        </div>
        <div className="sv-panel">
          <div className="sv-pn-h">NEEDS YOU (2)</div>
          <div className="sv-pn-row" />
          <div className="sv-pn-row" />
          <div className="sv-pn-h sv-pn-dim">WITH THE AGENT</div>
          <div className="sv-pn-row sv-pn-faint" />
        </div>
      </div>
    </div>
  )
}

function WatchdogVignette() {
  return (
    <div className="sv-term" aria-hidden data-ux-id="showcase-art-watchdog">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-term-body">
        <div className="sv-tline sv-dim">&gt; refactoring src/pipeline/ingest.ts …</div>
        <div className="sv-tline sv-dim">&gt; 14 files changed, tests green</div>
        <div className="sv-banner">You&apos;ve hit your usage limit. Resets at 3:00 PM.</div>
        <div className="sv-wd-chip"><span className="sv-wd-dot" /> Watchdog: waiting 42 min, retry 1 of 3</div>
        <div className="sv-typed">&gt; continue where you left off<span className="sv-caret" /></div>
      </div>
    </div>
  )
}

function OneRowVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-oneRow">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-term-lines">
        <div>&gt; claude …</div>
        <div className="sv-dim">&gt; working…</div>
      </div>
      <div className="sv-toolrow sv-toolrow-bar">
        <span className="sv-toolchip">+ Add</span>
        <span className="sv-toolchip">Snap</span>
        <span className="sv-toolchip">Canvas</span>
        <span className="sv-toolchip">Logs</span>
        <span className="sv-toolchip">Browser</span>
        <span className="sv-sep" />
        <span className="sv-toolchip sv-blue">build</span>
        <span className="sv-toolchip sv-green">test</span>
        <span className="sv-sep" />
        <span className="sv-toolchip sv-peach">deploy</span>
        <span className="sv-toolchip">3 more</span>
      </div>
    </div>
  )
}

function PanelVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-panel">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-panel-body">
        <div className="sv-chips"><span className="sv-chip">Saved 23</span><span className="sv-chip sv-on">Running 3</span></div>
        <div className="sv-qs">
          <span className="sv-qs-dot" />
          Orchid
          <span className="sv-qs-count">1</span>
          <span className="sv-chip sv-on sv-qs-start">▸ Start</span>
        </div>
        <div className="sv-pn-h sv-pn-neutral">Active sessions</div>
        <div className="sv-pn-row" />
        <div className="sv-pn-row" />
        <div className="sv-pn-row sv-pn-faint" />
      </div>
    </div>
  )
}

function AccountsVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-accounts">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-panel-body">
        <div className="sv-pn-h sv-pn-neutral">Accounts</div>
        <div className="sv-acct"><span className="sv-acct-dot" style={{ background: 'var(--ob)' }} />work<span className="sv-meter"><i style={{ width: '62%' }} /></span>62%</div>
        <div className="sv-acct"><span className="sv-acct-dot" style={{ background: 'var(--status-warning)' }} />personal<span className="sv-meter"><i style={{ width: '28%' }} /></span>28%</div>
        <div className="sv-acct"><span className="sv-acct-dot" style={{ background: 'var(--status-success)' }} />team<span className="sv-meter"><i style={{ width: '9%' }} /></span>9%</div>
        <div className="sv-wd-chip"><span className="sv-wd-dot" /> Switched account — the session kept going</div>
      </div>
    </div>
  )
}

function MultiSpawnVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-multiSpawn">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-panel-body">
        <div className="sv-chips"><span className="sv-chip sv-on">Saved 23</span><span className="sv-chip">Select</span></div>
        <div className="sv-qs">
          <span className="sv-qs-dot" />
          Orchid
          <span className="sv-qs-count">3</span>
          <span className="sv-chip sv-on sv-qs-start">▸ ×3</span>
        </div>
        <div className="sv-qs">
          <span className="sv-qs-dot" style={{ background: 'var(--status-warning)' }} />
          Ingest
          <span className="sv-qs-count">1</span>
          <span className="sv-chip sv-qs-start">▸</span>
        </div>
        <div className="sv-wd-chip"><span className="sv-wd-dot" /> Ingest is already running — enable Multi Spawn &amp; launch?</div>
      </div>
    </div>
  )
}

function RemoteResumeVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-remoteResume">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-panel-body">
        <div className="sv-pn-h sv-pn-neutral">Active sessions</div>
        <div className="sv-pn-row" />
        <div className="sv-pn-row" />
        <div className="sv-pn-h sv-pn-dim">Remote Resumable 2</div>
        <div className="sv-qs">
          <span className="sv-qs-dot" />
          build-box
          <span className="sv-chip sv-green sv-qs-start">Resumable</span>
        </div>
        <div className="sv-qs sv-dim">
          <span className="sv-qs-dot" style={{ background: 'var(--status-warning)' }} />
          rack-pi
          <span className="sv-chip sv-peach sv-qs-start">Unreachable</span>
        </div>
        <div className="sv-wd-chip"><span className="sv-wd-dot" /> you@build-box · left 2h ago</div>
      </div>
    </div>
  )
}

function SidebarMarksVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-sidebarMarks">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-panel-body">
        <div className="sv-pn-h sv-pn-neutral">Saved</div>
        <div className="sv-qs">
          <span className="sv-qs-dot" />
          api
          <span className="sv-chip sv-blue sv-qs-start">SSH</span>
        </div>
        <div className="sv-qs">
          <span className="sv-qs-dot" style={{ background: 'var(--status-success)' }} />
          build-box
          <span className="sv-chip sv-green sv-qs-start">SSH persistent</span>
        </div>
        <div className="sv-qs">
          <span className="sv-qs-dot" style={{ background: 'var(--status-warning)' }} />
          sandbox
          <span className="sv-chip sv-teal sv-qs-start">container</span>
        </div>
        <div className="sv-pn-h sv-pn-dim">Ungrouped</div>
        <div className="sv-pn-row" />
      </div>
    </div>
  )
}

function AskConductorVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-askConductor">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-split">
        <div className="sv-rail">
          <div className="sv-pn-row" />
          <div className="sv-pn-row" />
          <div className="sv-pn-row sv-pn-faint" />
          <div className="sv-rail-gap" />
          <div className="sv-askpill">
            <img src={askMarkUrl} alt="" className="sv-askpill-mark" draggable={false} />
            <span>
              <span className="sv-askpill-t">Ask Conductor</span>
              <span className="sv-askpill-s">Ask about the app</span>
            </span>
          </div>
        </div>
        <div className="sv-convo">
          <div className="sv-msg sv-msg-q">I changed my output style but my sessions ignore it — why?</div>
          <div className="sv-msg sv-msg-a">Settings are read when a session <b>starts</b>, and the nearest file wins. Check the project&apos;s own settings file — it overrides your personal one.</div>
          <div className="sv-msg sv-msg-q">Useful — install the helper skill so my other sessions know this too.</div>
          <div className="sv-permcard">
            <span className="sv-permcard-t">Write file<i>~/.claude/skills/ask-conductor/SKILL.md</i></span>
            <span className="sv-permcard-allow">Allow</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The 2.1.1 usage page: a section per assistant, each account apart. With
 *  Claude Code off (P3.4) it draws the Codex section alone: nothing about
 *  Claude Code shows to a Codex-only user. */
function UsageVignette({ claudeOn }: { claudeOn: boolean }) {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-usage">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-panel-body">
        {claudeOn && (
          <>
            <div className="sv-pn-h sv-pn-neutral">Claude Code</div>
            <div className="sv-acct"><span className="sv-acct-dot" style={{ background: 'var(--ob)' }} />work<span className="sv-meter"><i style={{ width: '62%' }} /></span>62%</div>
          </>
        )}
        <div className="sv-pn-h sv-pn-neutral">Codex</div>
        <div className="sv-acct"><span className="sv-acct-dot" style={{ background: 'var(--status-success)' }} />work@example, 5-hour<span className="sv-meter"><i style={{ width: '40%' }} /></span>40%</div>
        <div className="sv-acct"><span className="sv-acct-dot" style={{ background: 'var(--status-success)' }} />work@example, weekly<span className="sv-meter"><i style={{ width: '22%' }} /></span>22%</div>
        <div className="sv-acct"><span className="sv-acct-dot" style={{ background: 'var(--status-warning)' }} />review-bot key<span className="sv-meter" />per token</div>
        <div className="sv-wd-chip"><span className="sv-wd-dot" /> Each account apart, never merged</div>
      </div>
    </div>
  )
}

/** A drawing shared with Hello Codex, under the showcase's own ux id so a
 *  page's art can be found by its kind. */
function Shared({ kind, children }: { kind: ShowcaseArtKind; children: ReactNode }) {
  return (
    <div aria-hidden data-ux-id={`showcase-art-${kind}`} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
      {children}
    </div>
  )
}

export function ShowcaseVignette({ kind, claudeOn = true }: {
  kind: ShowcaseArtKind
  /** Claude Code is on: the Codex drawing then shows Claude tabs beside the
   *  Codex one, as Hello Codex's does, and the usage drawing a Claude Code
   *  section. Off, neither draws anything of Claude Code's. */
  claudeOn?: boolean
}) {
  // 2.1.1 (O3): the Hello Codex drawings. The review page shows only with
  // Claude Code on and tells both directions, so its drawing does too.
  if (kind === 'codexHello') return <Shared kind={kind}><HelloArt claudeOn={claudeOn} /></Shared>
  if (kind === 'codexAccounts') return <Shared kind={kind}><CodexAccountsArt /></Shared>
  if (kind === 'codexLaunch') return <Shared kind={kind}><LaunchArt /></Shared>
  if (kind === 'codexReview') return <Shared kind={kind}><ReviewArt claudeReview /></Shared>
  if (kind === 'usage') return <UsageVignette claudeOn={claudeOn} />
  if (kind === 'canvas') return <CanvasVignette />
  if (kind === 'watchdog') return <WatchdogVignette />
  if (kind === 'panel') return <PanelVignette />
  if (kind === 'accounts') return <AccountsVignette />
  if (kind === 'multiSpawn') return <MultiSpawnVignette />
  if (kind === 'remoteResume') return <RemoteResumeVignette />
  if (kind === 'sidebarMarks') return <SidebarMarksVignette />
  if (kind === 'askConductor') return <AskConductorVignette />
  return <OneRowVignette />
}
