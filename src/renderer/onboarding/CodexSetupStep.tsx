import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AccountsSnapshot, AccountView, InstallRecipeView, PathHintView, ProviderInstallationView, SignInMethod } from '../../shared/providers'
import { SIGN_IN_METHODS } from '../../shared/providers'
import {
  useProviderAccountsStore, providerAccountActions, providerView, selectProviderAccounts, accountDisplayName,
} from '../stores/providerAccountsStore'
import { AddProviderAccountDialog, methodCopy } from '../components/settings/accounts/AddProviderAccountDialog'
import { useSessionStore } from '../stores/sessionStore'
import { InstallRecipeList, afterInstallMessage, type RunnableRecipe } from './InstallRecipeList'
import { PathHintNotice, pathHintIsNote } from './PathHintNotice'
import { openInstallTab, installTabRunning, useInstallTabRunning, type InstallTab } from '../utils/installTab'

const CHECK = String.fromCodePoint(0x2713)

/** Above the onboarding root (z-index 100), so the add-account dialog it
 *  opens is not painted underneath the page. */
const OVER_ONBOARDING = 'z-[110]'

type Installation =
  | { kind: 'unavailable' }
  | { kind: 'checking' }
  | { kind: 'missing'; text: string }
  | { kind: 'update'; text: string }
  | { kind: 'usable'; version?: string; tooNew: boolean }

/** What the page can say about the Codex CLI, from main's discovery only. The
 *  snapshot does not carry the minimum version, so a too-old CLI is named by
 *  its own version and never by the one it falls short of. */
export function codexInstallation(p: ProviderInstallationView | undefined): Installation {
  if (!p) return { kind: 'unavailable' }
  switch (p.discoveryState) {
    case 'unchecked': return { kind: 'checking' }
    case 'missing': return { kind: 'missing', text: 'Codex CLI not found' }
    case 'invalid': return { kind: 'missing', text: 'Codex was found but did not run as expected' }
    case 'error': return { kind: 'missing', text: 'Codex could not be checked' }
    case 'found':
    default: {
      const named = p.version ? `Codex ${p.version}` : 'Codex'
      switch (p.compatibility) {
        case 'supported': return { kind: 'usable', version: p.version, tooNew: false }
        case 'too-new': return { kind: 'usable', version: p.version, tooNew: true }
        case 'too-old': return { kind: 'update', text: `${named} found; it is too old for this app` }
        case 'unsupported': return { kind: 'update', text: `${named} found; this app does not support it` }
        default: return { kind: 'update', text: 'Codex found, but its version could not be read' }
      }
    }
  }
}

/** Codex accounts added in this app that are signed in and usable now. The
 *  sign-in already on this computer (an account 2.1.1-beta.2 registered for
 *  ~/.codex: external, and so unverified) never counts (O5, owner decision
 *  2026-10-11), the same rule Hello Codex keeps (hello-codex.ts codexSetUp):
 *  with only that, the page still offers a new Codex account. */
export function signedInCodexAccounts(snapshot: AccountsSnapshot | null): AccountView[] {
  return selectProviderAccounts(snapshot, 'codex').filter(
    (a) => a.lifecycle === 'active' && a.lastKnownAuthState === 'signed-in' && a.operationalState !== 'blocked' && !a.external && !a.unverified,
  )
}

/** The newer of two answers for the same provider: main pushes a snapshot
 *  after each check, but the check's own answer can arrive first. */
function newer(a: ProviderInstallationView | undefined, b: ProviderInstallationView | undefined): ProviderInstallationView | undefined {
  if (!a) return b
  if (!b) return a
  return (b.lastCheckedAt ?? 0) > (a.lastCheckedAt ?? 0) ? b : a
}

function CheckRow({ tone, children, testId }: { tone: 'ok' | 'warn' | 'pending'; children: ReactNode; testId?: string }) {
  return (
    <div className="checkrow" data-testid={testId}>
      <div className={tone === 'ok' ? 'badge ok' : tone === 'warn' ? 'badge warn' : 'badge pending'}>{tone === 'ok' ? CHECK : '!'}</div>
      <div className="nm">{children}</div>
    </div>
  )
}

/** What the confirmation says about where the line runs. */
const CONFIRM_WHERE = 'Run this in a new terminal tab? It types the line below. Setup steps aside so you can watch it, and you come back to it when you are done.'

/** The terminal tab this page last opened for a recipe. Held for the
 *  renderer's lifetime, not the page's, so a page shown again (Back, then
 *  Next) still knows that install is running while its tab is open. */
let openedTab: InstallTab | null = null

/**
 * "Set up Codex" (WP2 commit 6e, canvas F2). Shown when the user chose Codex
 * on the assistants page, or answered Yes on the one-time "Do you use
 * Codex?" page after an update. Everything it says comes from main: the
 * discovery in the accounts snapshot (checked again on entry) and the
 * install recipes.
 *
 *   - Not found: the install recipes, verbatim, OpenAI's installer first,
 *     each with Run it for me and Copy (InstallRecipeList). A recipe main
 *     allows to run (it sends the line to type, `runLine`) runs in a visible
 *     terminal tab after the user confirms that line, one at a time; the line
 *     ends the tab's shell when its command ends, and the page then checks
 *     again. "Check again" looks again; a check that still finds nothing
 *     says what to do.
 *   - Too old: the version found and the update recipe.
 *   - Ready: sign in to a new Codex account through the Accounts surface's
 *     own add-account dialog, started at the chosen method. That is the
 *     only way in. The Codex sign-in already on this computer is never
 *     offered, checked or taken in (O5, owner decision 2026-10-11: a Codex
 *     account is always added in the app, as a Claude account is).
 *   - Signed in: done, and Next continues. Only an account added in the
 *     app counts (signedInCodexAccounts).
 */
export function CodexSetupStep({ onNext, onBack, stepAside, returns }: {
  onNext: () => void
  /** Absent when no page comes before this one (an upgrader handed only this
   *  page): there is then no Back button. */
  onBack?: () => void
  /** Let the terminal the page opened be seen (the harness steps aside). */
  stepAside: () => void
  /** Counts the user's returns from that terminal: each one checks again. */
  returns: number
}) {
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const [answer, setAnswer] = useState<ProviderInstallationView | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  const [recipes, setRecipes] = useState<InstallRecipeView[] | null | undefined>(undefined)
  const [dialog, setDialog] = useState<null | { method?: SignInMethod }>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  // Set in setup as well as cleared in cleanup: StrictMode (development)
  // runs cleanup then setup again with the same refs, and a ref only ever
  // cleared would leave the page believing it had gone away.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const provider = newer(providerView(snapshot, 'codex'), answer)
  const install = codexInstallation(provider)
  const signedIn = signedInCodexAccounts(snapshot)

  // What main said helps when its check found nothing: Codex is in
  // OpenAI's install folder, which the login shell's PATH lacks (macOS and
  // Linux), or a restart would help.
  const [pathHint, setPathHint] = useState<PathHintView | undefined>(undefined)
  const checkAgain = async () => {
    setChecking(true)
    setError(null)
    // Main brings its PATH up to date before it looks (owner decision D4).
    const r = await providerAccountActions.discover('codex')
    if (!mounted.current) return
    setChecking(false)
    setPathHint(r.ok ? r.pathHint : undefined)
    if (r.ok) setAnswer(r.installation)
    else setError({ code: r.code, message: r.message })
  }

  // On entry, and on every return from the terminal: look again, the user
  // may have installed or updated Codex since.
  useEffect(() => {
    void checkAgain()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returns])

  // Read again after every check: the update commands are the ones for the
  // install that check found, which an install or update since may change.
  const checkedAt = provider?.lastCheckedAt
  useEffect(() => {
    let live = true
    void providerAccountActions.installRecipes('codex').then((r) => { if (live) setRecipes(r) })
    return () => { live = false }
  }, [checkedAt])

  // One install at a time: while the tab this page opened is still running
  // (open, and its shell has not exited), Run is off for the whole page and
  // says where it is running.
  const [tab, setTab] = useState(openedTab)
  const running = useInstallTabRunning(tab)
  const busyReason = tab && running ? `Already running in the ${tab.label} tab` : undefined

  // The line ends the tab's shell when its command ends: once the page has
  // seen its tab running and then ended (exited, or closed), it checks again,
  // once per tab. A tab that ended while the page was not shown is covered by
  // the check every entry makes.
  const seenRunning = useRef<string | null>(null)
  const [endedTab, setEndedTab] = useState<string | null>(null)
  useEffect(() => {
    if (!tab) return
    if (running) { seenRunning.current = tab.id; return }
    if (seenRunning.current !== tab.id) return
    seenRunning.current = null
    setEndedTab(tab.id)
    void checkAgain()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, running])
  // The user's own Check again: a check that still finds nothing says what to do.
  const [userChecked, setUserChecked] = useState(false)

  // Types main's line, exactly: the page never builds or picks what runs.
  const run = (recipe: RunnableRecipe) => {
    // Read live, not from this render: a second click that lands before the
    // page re-renders must not open a second install.
    if (installTabRunning(openedTab, useSessionStore.getState().sessions)) return
    const label = recipe.purpose === 'update' ? 'Update Codex' : 'Install Codex'
    openedTab = openInstallTab({ label, runLine: recipe.runLine })
    setTab(openedTab)
    setEndedTab(null)
    setUserChecked(false)
    stepAside()
  }

  const done = install.kind === 'usable' && signedIn.length > 0
  const methods = provider ? SIGN_IN_METHODS.filter((m) => provider.signInMethods[m]?.enabled) : []

  let body: ReactNode
  // Which of the page's states is showing: the page's primary control (the
  // one marked data-autofocus) differs by state, so focus follows it.
  let view: string = install.kind
  if (install.kind === 'unavailable') {
    body = <p className="cx-muted" data-testid="codex-setup-unavailable">The account list is not available right now. You can set up Codex later in Settings, Accounts.</p>
  } else if (install.kind === 'checking') {
    body = <CheckRow tone="pending" testId="codex-setup-checking">Checking for the Codex CLI...</CheckRow>
  } else if (install.kind === 'missing' || install.kind === 'update') {
    // Still not found after a command this page ran ended, or after the
    // user's own Check again: what to do, once that check has answered. (A
    // Codex found but too old has its own line above.) A path hint that says
    // what helps takes its place; a restart that only may help
    // (pathHintIsNote) is a note, shown after it.
    const ended = !!endedTab && endedTab === tab?.id
    const hint = checking || install.kind !== 'missing' ? undefined : pathHint
    const after = checking || install.kind !== 'missing' || (hint && !pathHintIsNote(hint)) ? null
      : ended ? afterInstallMessage('Codex', { ended: true }) : userChecked ? afterInstallMessage('Codex', { ended: false }) : null
    body = (
      <div data-testid={install.kind === 'missing' ? 'codex-setup-missing' : 'codex-setup-update'}>
        <CheckRow tone={install.kind === 'missing' ? 'pending' : 'warn'} testId="codex-setup-check">{install.text}</CheckRow>
        <InstallRecipeList
          purpose={install.kind === 'missing' ? 'install' : 'update'}
          recipes={recipes}
          toolName="Codex"
          testIdPrefix="codex"
          confirmWhere={CONFIRM_WHERE}
          onRun={run}
          busyReason={busyReason}
        />
        {after && <p className="cx-muted" role="status" data-testid="codex-setup-after-install">{after}</p>}
        {hint && <PathHintNotice hint={hint} toolName="Codex" providerId="codex" testIdPrefix="codex" onAdded={() => { void checkAgain() }} />}
      </div>
    )
  } else {
    const versionRow = (
      <>
        <CheckRow tone="ok" testId="codex-setup-found">{install.version ? `Codex ${install.version} found` : 'Codex found'}</CheckRow>
        <CheckRow tone={install.tooNew ? 'warn' : 'ok'} testId="codex-setup-version">
          {install.tooNew ? 'Newer than the versions this app was tested with; it will still be used' : 'Version supported'}
        </CheckRow>
      </>
    )
    if (done) {
      view = 'done'
      body = (
        <div data-testid="codex-setup-done">
          {versionRow}
          {signedIn.map((a) => (
            <CheckRow key={a.id} tone="ok" testId={`codex-setup-signed-in-${a.id}`}>Signed in: {accountDisplayName(snapshot, a)}</CheckRow>
          ))}
        </div>
      )
    } else {
      // Sign in to a new Codex account: the only way in (O5).
      view = 'sign-in'
      body = (
        <div data-testid="codex-setup-sign-in">
          {versionRow}
          <div className="cx-h3">Sign in to a new Codex account</div>
          {methods.length === 0 && <p className="cx-muted">No sign-in method is available for Codex here.</p>}
          {provider && methods.map((m, i) => {
            const copy = methodCopy(provider, m)
            return (
              <button
                key={m}
                className={i === 0 ? 'cx-choice primary' : 'cx-choice'}
                type="button"
                onClick={() => setDialog({ method: m })}
                data-autofocus={i === 0 ? '' : undefined}
                data-testid={`codex-setup-method-${m}`}
              >
                <b>{copy.title}</b>
                <span>{copy.sub}</span>
              </button>
            )
          })}
        </div>
      )
    }
  }

  const needsCli = install.kind === 'missing' || install.kind === 'update'

  // Focus goes to the page's primary control, the first enabled one marked
  // data-autofocus (an install or update command's button, else Check again;
  // the first sign-in method; Next; Skip for now when the account list is not
  // there), when the page opens, when its state
  // moves on (a check finished, a sign-in landed), when the add-account dialog
  // closes and when the user comes back from the terminal. Only while nothing
  // has focus (the page body): a control the user is on keeps it, and nothing
  // is taken from under the add-account dialog.
  const pageRef = useRef<HTMLDivElement>(null)
  const recipesLoaded = recipes !== undefined
  useEffect(() => {
    if (dialog) return
    // Not found or too old: the commands are the primary, so wait for them
    // rather than settle on Check again a moment before they arrive.
    if (needsCli && !recipesLoaded) return
    const at = document.activeElement
    if (at && at !== document.body) return
    // The page's own section: this page's body and its footer.
    const scope = pageRef.current?.parentElement
    const primary = Array.from(scope?.querySelectorAll<HTMLButtonElement>('[data-autofocus]') ?? []).find((el) => !el.disabled)
    primary?.focus()
  }, [view, needsCli, recipesLoaded, dialog, returns])

  return (
    <>
      <div className="p2" ref={pageRef}>
        <div className="p2-inner" data-testid="codex-setup">
          <h2 className="h2">Set up Codex</h2>
          {body}
          {/* The body already says the account list is not available: say it once. */}
          {error && !(install.kind === 'unavailable' && error.code === 'registry-unavailable') && (
            <div className="gh-err" role="alert" data-testid="codex-setup-error">{error.message}</div>
          )}
        </div>
      </div>
      <div className="foot">
        {onBack && <button className="back" onClick={onBack} type="button" data-testid="codex-setup-back">← Back</button>}
        <span className="cx-foot-actions">
          {needsCli && (
            <button className="back" type="button" onClick={() => { setUserChecked(true); void checkAgain() }} disabled={checking} data-autofocus="" data-testid="codex-setup-check-again">
              {checking ? 'Checking...' : 'Check again'}
            </button>
          )}
          {done ? (
            <button className="cta" onClick={onNext} type="button" data-autofocus="" data-testid="codex-setup-next">Next →</button>
          ) : (
            <button className="skip" onClick={onNext} type="button" data-autofocus={install.kind === 'unavailable' ? '' : undefined} data-testid="codex-setup-skip">Skip for now →</button>
          )}
        </span>
      </div>
      {dialog && provider && (
        <AddProviderAccountDialog provider={provider} initialMethod={dialog.method} overlayZ={OVER_ONBOARDING} onClose={() => setDialog(null)} />
      )}
    </>
  )
}
