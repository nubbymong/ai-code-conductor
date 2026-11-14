import { useEffect, useRef } from 'react'
import { useGitHubStore } from '../../../stores/githubStore'
import AccountsSection from './AccountsSection'
import AppWideFeatures from './AppWideFeatures'
import PermissionsSummary from './PermissionsSummary'
import PrivacySettings from './PrivacySettings'
import SyncSettings from './SyncSettings'
export default function GitHubConfigTab() {
  const config = useGitHubStore((s) => s.config)
  const loadConfig = useGitHubStore((s) => s.loadConfig)
  const updateConfig = useGitHubStore((s) => s.updateConfig)
  // Why the last change on this page was not saved (for one, main refuses a
  // save when github-config.json could not be read). Every control here saves
  // through the store, so one line covers the toggles, the selects and the
  // account edits alike; without it a refused change just looks like a click
  // that did nothing.
  const saveError = useGitHubStore((s) => s.saveError)
  const saveErrorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // A refusal from before this page was opened says nothing about it.
    useGitHubStore.setState({ saveError: null })
    loadConfig()
  }, [loadConfig])

  useEffect(() => {
    // The page is long and the control that was refused may be far below.
    if (saveError) saveErrorRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [saveError])

  if (!config) {
    return <div className="p-6 text-overlay1">Loading GitHub config…</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg text-text">GitHub integration</h2>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={config.enabledByDefault}
            onChange={(e) => updateConfig({ enabledByDefault: e.target.checked })}
          />
          <span>
            Enable GitHub
            <span className="block text-[11px] text-overlay0">
              Adds the GitHub panel to new sessions by default. The same master as the setup flow's GitHub On/Off.
            </span>
          </span>
        </label>
      </div>
      {saveError && (
        <div ref={saveErrorRef} role="alert" className="text-xs text-red">
          {saveError}
        </div>
      )}
      <AccountsSection />
      <AppWideFeatures />
      <PrivacySettings />
      <SyncSettings />
      <PermissionsSummary />
      <div className="text-xs text-overlay0 pt-4 border-t settings-divider">
        <strong>No telemetry.</strong> This feature sends no usage data to Anthropic
        or third parties. All requests go to github.com using your configured auth.
      </div>
    </div>
  )
}
