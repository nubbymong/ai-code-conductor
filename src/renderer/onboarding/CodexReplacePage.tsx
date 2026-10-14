import { useEffect, useRef, useState } from 'react'
import './onboarding.css'
import { OnboardingShell } from './OnboardingShell'
import { otherDialogOpen } from './contain-focus'
import { useProviderAccountsStore, providerView, externalHomeFolder } from '../stores/providerAccountsStore'
import { AddProviderAccountDialog } from '../components/settings/accounts/AddProviderAccountDialog'
import { addedCodexAccountIds, markCodexReplaceSeen, retiredCodexSignIn } from './codex-replace-gate'

/** Above the onboarding root (z-index 100), so the add-account dialog it
 *  opens paints over the page, as on the Set up Codex page. */
const OVER_ONBOARDING = 'z-[110]'

/** What the page says, as data so a test can pin every line. `folder` is the
 *  folder main names for that sign-in (externalHomeFolder), or null.
 *  `inactive`: the account for that sign-in is inactive, so nothing launches
 *  on it, and the lines about its launch confirmations do not apply. */
export function codexReplaceCopy(folder: string | null, opts: { inactive?: boolean } = {}): { heading: string; lines: string[]; note: string } {
  const where = folder ? ` (${folder})` : ''
  const intro = `In 2.1.1-beta.2 you chose to use the Codex sign-in already on this computer${where}. This app no longer uses that sign-in: Codex accounts are always added in the app now, each with its own sign-in.`
  return {
    heading: 'Replace this sign-in with a Codex account',
    lines: opts.inactive
      ? [intro, 'It is inactive, so nothing starts on it. Add a Codex account to use Codex in this app.']
      : [
          intro,
          'It keeps working for now, but every launch on it must be confirmed, and it cannot run code reviews. Add a Codex account to replace it.',
          'Then, when a session that used it starts, its confirmation lets you start it on the new account instead. A saved config that used this sign-in moves to it too.',
          "A restored tab's conversation does not move that way. To keep it, choose Launch in that confirmation, then use Switch account on the running session, which carries the conversation over.",
        ],
    note: 'Nothing is signed out here: the Codex CLI keeps its own sign-in. Its row in Settings, Accounts says how to retire it.',
  }
}

/**
 * "Replace this sign-in with a Codex account" (O5, owner decision
 * 2026-10-11): shown once, at a start, to someone who chose the Codex sign-in
 * already on this computer in 2.1.1-beta.2 (codex-replace-gate.ts). A boot
 * gate ('codexReplace'), mounted the way "Do you use Codex?" is.
 *
 *   - Add a Codex account opens the usual add-account dialog over the page.
 *     Once an account has been added, the page is done: it stamps and
 *     closes. A dialog closed without adding one leaves the page up.
 *   - Not now (or Escape) stamps and closes; the account keeps working, and
 *     its row and every launch confirmation on it still say it is being
 *     retired.
 *
 * It signs nothing out, archives nothing and changes no config: moving a
 * session or config off the sign-in is the launch confirmation's offer.
 */
export function CodexReplacePage({ onDone }: {
  /** The page was left (stamped). */
  onDone: () => void
}) {
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const provider = providerView(snapshot, 'codex')
  const copy = codexReplaceCopy(externalHomeFolder(snapshot, 'codex'), { inactive: retiredCodexSignIn(snapshot)?.lifecycle === 'inactive' })
  /** The accounts added in the app when the dialog opened; null while closed. */
  const [before, setBefore] = useState<Set<string> | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const done = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const leave = () => {
    if (done.current) return
    done.current = true
    markCodexReplaceSeen()
    onDoneRef.current()
  }

  // An account added through the dialog: the page has done its job. The
  // snapshot that lists it can land before or after the dialog closes, so
  // this waits for both (the dialog closed, and the new account listed).
  useEffect(() => {
    if (dialogOpen || !before) return
    for (const id of addedCodexAccountIds(snapshot)) {
      if (!before.has(id)) { leave(); return }
    }
  }, [dialogOpen, before, snapshot])

  // Escape is Not now, unless a dialog opened above the page is the one it
  // is for (the add-account dialog handles its own).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (otherDialogOpen(rootRef.current)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      leave()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const add = () => {
    if (!provider) return
    setBefore(addedCodexAccountIds(useProviderAccountsStore.getState().snapshot))
    setDialogOpen(true)
  }

  return (
    <OnboardingShell phase={0} showPhases={false}>
      <>
        <div className="p2" ref={rootRef} data-testid="codex-replace">
          <div className="p2-inner" style={{ width: 'min(640px, 100%)' }}>
            <h2 className="h2">{copy.heading}</h2>
            {copy.lines.map((line, i) => (
              <p key={i} className="p2-sub" data-testid={`codex-replace-line-${i}`}>{line}</p>
            ))}
            <p className="as-note" data-testid="codex-replace-note">{copy.note}</p>
          </div>
        </div>
        <div className="foot">
          <button className="back" type="button" onClick={leave} data-testid="codex-replace-not-now">Not now</button>
          <button className="cta" type="button" onClick={add} disabled={!provider} autoFocus data-testid="codex-replace-add">Add a Codex account</button>
        </div>
        {dialogOpen && provider && (
          <AddProviderAccountDialog provider={provider} overlayZ={OVER_ONBOARDING} onClose={() => setDialogOpen(false)} />
        )}
      </>
    </OnboardingShell>
  )
}
