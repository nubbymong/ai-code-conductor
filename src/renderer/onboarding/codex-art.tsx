import { ProviderMark } from '../components/sidebar/Badges'

/**
 * Drawings of the Codex features, shared by Hello Codex (HelloCodex.tsx) and
 * the 2.1.1 What's New showcase pages (ShowcaseVignette, O3). Moved here out
 * of HelloCodex.tsx unchanged, so the showcase can draw them without pulling
 * in Hello Codex's stores. Pure JSX and CSS (`.hc-*` in onboarding.css),
 * decorative: every drawing is aria-hidden, because the copy beside it says
 * everything it draws. Pictures OF the features, not the features.
 */

function Tab({ provider, name, on = false }: { provider: 'claude' | 'codex'; name: string; on?: boolean }) {
  return (
    <div className={`hc-tab${on ? ' on' : ''}`}>
      <ProviderMark providerId={provider} size={14} />
      {name}
    </div>
  )
}

export function HelloArt({ claudeOn }: { claudeOn: boolean }) {
  return (
    <div className="hc-vig" aria-hidden data-testid="hc-art-hello" data-ux-id="hc-art-hello">
      <div className="hc-tabs">
        {claudeOn
          ? <><Tab provider="claude" name="api-server" /><Tab provider="codex" name="api-server (Codex)" on /><Tab provider="claude" name="docs" /></>
          : <><Tab provider="codex" name="api-server (Codex)" on /><Tab provider="codex" name="docs (Codex)" /></>}
      </div>
      <div className="hc-term">
        <div className="dim">&gt;_ OpenAI Codex  model gpt-5.5  account work@example</div>
        <div className="dim">workspace ~/projects/api-server</div>
        <div className="hc-gap" />
        <div><span className="p">&gt;</span> <span className="hl">add a retry to the upload client and a test for it</span></div>
        <div className="dim">  reading src/upload/client.ts</div>
        <div className="dim">  editing src/upload/client.ts</div>
        <div className="ok">  tests passed (12)</div>
      </div>
    </div>
  )
}

/** The Codex accounts list as the showcase draws it: accounts the app added,
 *  a default and a reviewer. No row for the computer's own Codex sign-in, an
 *  option that is removed (owner rule, 2026-10-11). */
export function CodexAccountsArt() {
  return (
    <div className="hc-vig" aria-hidden data-ux-id="hc-art-codex-accounts">
      <div className="hc-row hc-head">
        <ProviderMark providerId="codex" size={16} />
        <b>Codex accounts</b>
        <span className="hc-spacer" />
        <span className="hc-mini-btn">Add Codex account</span>
      </div>
      <div className="hc-row">
        <span className="hc-avatar">W</span>
        <div><div>work@example</div><div className="hc-muted">ChatGPT sign-in</div></div>
        <span className="hc-spacer" />
        <span className="hc-badge def">Default</span>
      </div>
      <div className="hc-row">
        <span className="hc-avatar">R</span>
        <div><div>review-bot key</div><div className="hc-muted">API key</div></div>
        <span className="hc-spacer" />
        <span className="hc-badge rev">Reviewer</span>
      </div>
      <div className="hc-row">
        <span className="hc-avatar">P</span>
        <div><div>personal@example</div><div className="hc-muted">ChatGPT sign-in</div></div>
      </div>
    </div>
  )
}

export function LaunchArt() {
  return (
    <div className="hc-stack" aria-hidden data-testid="hc-art-launch" data-ux-id="hc-art-launch">
      <div className="hc-vig">
        <div className="hc-row hc-head"><b>New saved config</b></div>
        <div className="hc-cards">
          <div className="hc-card"><ProviderMark providerId="claude" size={18} /><div>Claude Code<div className="hc-muted">Anthropic</div></div></div>
          <div className="hc-card on"><ProviderMark providerId="codex" size={18} /><div>Codex<div className="hc-muted">OpenAI</div></div></div>
        </div>
        <div className="hc-field"><span>Account</span><span>work@example</span></div>
        <div className="hc-field"><span>Permissions</span><span>Standard</span></div>
        <div className="hc-field off"><span>SSH</span><span>Not available for Codex in this release</span></div>
      </div>
      <div className="hc-vig">
        <div className="hc-tui">
          <div className="hc-tbox">
            <span className="hc-tt">Resume Codex Conversation</span>
            <div className="hc-trow"><span className="n">1</span><span className="hl">retry for the upload client</span><span className="dim">2h ago</span></div>
            <div className="hc-trow"><span className="n">2</span><span>pagination bug in /orders</span><span className="dim">Yesterday</span></div>
            <div className="hc-trow"><span className="n">3</span><span>update the README examples</span><span className="dim">3d ago</span></div>
            <div className="hc-trow"><span className="new">n</span><span>New conversation</span><span /></div>
          </div>
          <div className="hc-prompt">&gt; 1</div>
        </div>
      </div>
    </div>
  )
}

function ReviewFlow({ from, to, ask, findings }: { from: 'claude' | 'codex'; to: 'Claude' | 'Codex'; ask: string; findings: number }) {
  const who = from === 'claude' ? 'Claude' : 'Codex'
  return (
    <div data-testid={`hc-flow-${from}`} data-ux-id={`hc-flow-${from}`}>
      <div className="hc-flow-lbl">From a {who} session</div>
      <div className="hc-flow">
        <div className="hc-vig hc-vig-mini">
          <div className="hc-tabs">
            {from === 'claude'
              ? <><Tab provider="claude" name="api-server" on /><Tab provider="claude" name="docs" /></>
              : <><Tab provider="codex" name="api-server (Codex)" on /><Tab provider="claude" name="api-server" /></>}
          </div>
          <div className="hc-term hc-term-mini"><span className="p">&gt;</span> <span className="hl">{ask}</span></div>
        </div>
        <span className="hc-arrow" />
        <div className="hc-revbox">separate {to} reviewer - read-only</div>
        <span className="hc-arrow" />
        <div className="hc-finds">
          <div className="hc-fh">{findings} findings</div>
          {Array.from({ length: findings }, (_, i) => (
            <div className="hc-fi" key={i}>{i + 1}. <span className="hc-sk" style={{ flex: 1 - i * 0.2 }} /></div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The review drawing is an illustration of the feature as the build ships
 *  it: with Claude Code off it still shows both directions, and the points
 *  say what review needs. */
export function ReviewArt({ claudeReview }: { claudeReview: boolean }) {
  return (
    <div className="hc-flows" aria-hidden data-testid="hc-art-review" data-ux-id="hc-art-review">
      <ReviewFlow from="claude" to="Codex" ask="ask for a Codex review" findings={3} />
      {claudeReview && <ReviewFlow from="codex" to="Claude" ask="ask for a Claude review" findings={2} />}
    </div>
  )
}
