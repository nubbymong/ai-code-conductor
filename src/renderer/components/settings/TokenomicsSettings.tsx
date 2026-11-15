import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderAccountsStore } from '../../stores/providerAccountsStore'
import { Section } from '../SettingsPage'
import { tkAccountLabel, TK_PROVIDERS, TK_PROVIDER_LABEL } from '../tokenomics/tk-labels'
import type { TkAccountPresent, TkProvider } from '../../../shared/types'

/**
 * Settings, General, Tokenomics (2.1.3-beta.4): Tokenomics as an optional
 * service.
 *
 * The switch is on by default, so nothing changes for anyone who does not
 * touch it. Off, main stops the worker that reads the conversation files and
 * starts nothing in its place; what was recorded before stays in its
 * database, and the worker keeps how far it read each file there, so turning
 * it back on reads only what was written since.
 *
 * Below it, the accounts whose usage the figures leave out. That is a filter
 * on what the page shows and nothing more: an account left out is still read
 * and recorded, so it saves no disk work, and putting it back shows all of
 * it. The list is the accounts the recorded usage has, with the ones already
 * left out, so each can be put back. Usage recorded to no account (older
 * history, sessions run outside the app) is not an account: it cannot be
 * left out, and the text says so.
 */

const NONE: string[] = []

/** The provider an account key names, or null. */
function providerOf(accountKey: string): TkProvider | null {
  const at = accountKey.indexOf(':')
  const provider = at > 0 ? accountKey.slice(0, at) : ''
  return (TK_PROVIDERS as readonly string[]).includes(provider) ? provider as TkProvider : null
}

export function TokenomicsSettings() {
  const enabled = useSettingsStore((s) => s.settings.tokenomicsEnabled !== false)
  const excluded = useSettingsStore((s) => s.settings.tokenomicsExcludedAccounts) ?? NONE
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const [present, setPresent] = useState<TkAccountPresent[]>([])

  useEffect(() => {
    if (!enabled) { setPresent([]); return }
    const tk = window.electronAPI?.tokenomics
    if (typeof tk?.accounts !== 'function') return
    let live = true
    const load = (): void => {
      tk.accounts!({ includeExcluded: true })
        .then((r) => { if (live) setPresent(Array.isArray(r) ? r : []) })
        // Not ready yet (just switched on): its status push asks again, and
        // so does each pass that completes.
        .catch(() => {})
    }
    load()
    const unsub = typeof tk.onIndexStatus === 'function' ? tk.onIndexStatus(() => load()) : null
    // A pass that completes may have recorded accounts: on an index that was
    // empty the worker was ready before any was, and says so here, not in a
    // status push.
    const unsubComplete = typeof tk.onIndexComplete === 'function' ? tk.onIndexComplete(() => load()) : null
    return () => { live = false; unsub?.(); unsubComplete?.() }
  }, [enabled])

  // The accounts with recorded usage, and the ones already left out. Usage
  // recorded to no account is not an account and cannot be left out.
  const keys = [...new Set([...present.map((a) => a.accountKey), ...excluded])].filter((k) => k !== '')
  const options = keys
    .map((key) => {
      const provider = providerOf(key)
      const name = tkAccountLabel(snapshot, key)
      return { key, order: provider ? TK_PROVIDERS.indexOf(provider) : TK_PROVIDERS.length, label: provider ? `${TK_PROVIDER_LABEL[provider]}: ${name}` : name }
    })
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))

  const setExcluded = (key: string, leaveOut: boolean): void => {
    const next = leaveOut ? [...excluded.filter((k) => k !== key), key] : excluded.filter((k) => k !== key)
    void updateSettings({ tokenomicsExcludedAccounts: next })
  }

  return (
    <Section
      title="Tokenomics"
      testId="settings-tokenomics"
      icon={<path d="M8 2v12M11 4.5H6.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />}
    >
      <label className="flex items-start gap-2 text-sm text-subtext0 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => { void updateSettings({ tokenomicsEnabled: e.target.checked }) }}
          className="mt-0.5 rounded border-surface1"
          data-testid="settings-tokenomics-enabled"
        />
        <span>
          Tokenomics
          <span className="block text-[10px] text-[var(--text-muted)]">
            Reads your assistants&apos; own conversation files in the background to count tokens and estimate cost for the Tokenomics page. On by default. Turning it off stops its worker at once and nothing is read; what was recorded before is kept. Turning it back on picks up from where it stopped.
          </span>
        </span>
      </label>

      <div className="pl-6" data-testid="settings-tokenomics-excluded">
        <div className="text-sm text-subtext0">Leave these accounts out of the figures</div>
        <div className="text-[10px] text-[var(--text-muted)] mb-1">
          This only hides an account&apos;s usage from the totals, charts and lists. Its conversation files are still read and recorded, so it saves no disk work, and an account you put back is complete. Usage that was not recorded to an account stays in the figures: older history, and sessions run outside the app.
        </div>
        {options.length === 0 ? (
          <div className="text-[11px] text-[var(--text-muted)]">
            {enabled ? 'Accounts appear here once usage has been recorded for them.' : 'Turn Tokenomics on to choose accounts.'}
          </div>
        ) : (
          options.map((o) => (
            <label key={o.key} className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer py-0.5">
              <input
                type="checkbox"
                checked={excluded.includes(o.key)}
                onChange={(e) => setExcluded(o.key, e.target.checked)}
                className="rounded border-surface1"
                data-testid="settings-tokenomics-exclude"
                data-account-key={o.key}
              />
              {o.label}
            </label>
          ))
        )}
      </div>
    </Section>
  )
}
