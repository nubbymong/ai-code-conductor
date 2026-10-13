import { useMemo } from 'react'
import TerminalView from './TerminalView'
import type { Session } from '../stores/sessionStore'
import { partnerShellOf } from '../utils/partnerShell'

interface Props {
  session: Pick<Session, 'configId' | 'createdAt' | 'sessionType' | 'workingDirectory' | 'sshConfig'>
  /** The partner's own PTY id, `<session id>-partner` (App names it). */
  ptyId: string
  /** The assistant of the session the partner sits beside ("Claude"). */
  agentName: string
  isActive: boolean
  onBack: () => void
}

/**
 * The partner terminal of a session: its identity strip and its shell.
 *
 * Which terminal am I in? The Canvas and webview panes answer that by looking
 * different; the partner pane is another terminal, so a user who switched
 * could be typing into a plain shell believing it was the assistant, with the
 * only cue a label change on one button in the command bar. The strip states
 * it, says WHERE the shell runs (#86: this PC, or the SSH session's host), and
 * carries the way back.
 *
 * P3.7 (the C item "narrow-window overlap", row 64): pr-12 keeps the way back
 * clear of the GitHub button floating over this corner (GitHubPanel gh-fab:
 * absolute top-2 right-2, 32px), as the switch note does; the note wraps, the
 * button never shrinks. A long user@host breaks anywhere rather than pushing
 * the button.
 *
 * #86: an SSH session's partner is a plain shell on the session's host, its
 * own plain connection (utils/partnerShell.ts); a local session's is a shell on
 * this PC in the session's folder.
 */
export default function PartnerTerminalPane({ session, ptyId, agentName, isActive, onBack }: Props) {
  // Kept while the session's type, folder and ssh block are the same objects:
  // the session record is replaced on every statusline tick, and a new ssh
  // block each render would make TerminalView drop and take again its
  // subscriptions keyed on it.
  const { sessionType, workingDirectory, sshConfig } = session
  const partner = useMemo(() => partnerShellOf({ sessionType, workingDirectory, sshConfig }), [sessionType, workingDirectory, sshConfig])
  return (
    <>
      <div
        className="flex-none flex items-center gap-2 pl-3 pr-12 py-1 text-[11px] border-b"
        style={{
          background: 'color-mix(in srgb, var(--color-green) 12%, transparent)',
          borderColor: 'color-mix(in srgb, var(--color-green) 28%, transparent)',
          color: 'var(--color-subtext0)',
        }}
        data-ux-id="partner-identity-strip"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-green)' }} aria-hidden>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span className="min-w-0" style={{ overflowWrap: 'anywhere' }} data-testid="partner-strip-note">Partner terminal: a plain shell on {partner.where}, not {agentName}</span>
        <button
          onClick={onBack}
          className="ml-auto shrink-0 whitespace-nowrap flex items-center gap-1 px-2 py-0.5 rounded focus-ring transition-colors hover:bg-surface1"
          style={{ color: 'var(--color-text)' }}
          title={`Back to the ${agentName} terminal`}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          Back to {agentName}
        </button>
      </div>
      <TerminalView
        key={ptyId + '-' + session.createdAt}
        sessionId={ptyId}
        configId={session.configId}
        cwd={partner.cwd}
        ssh={partner.ssh}
        shellOnly={true}
        isActive={isActive}
      />
    </>
  )
}
