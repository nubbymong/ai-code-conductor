import { useId } from 'react'
import { ChangelogEntry } from '../changelog'
import { releaseWarnings } from '../onboarding/upgrade-flow'

// Shared renderer for the What's New changelog, used by BOTH surfaces so they
// never drift: the full-screen WhatsNewModal shown after install/upgrade, and
// the browsable "What's New" section inside the Feature Guide.

const TYPE_COLORS: Record<string, string> = {
  feature: 'text-green',
  fix: 'text-red',
  improvement: 'text-blue',
}
const TYPE_LABELS: Record<string, string> = {
  feature: 'New',
  fix: 'Fix',
  improvement: 'Improved',
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * A release's warnings (`ChangelogEntry.warnings`): what a user should know
 * before relying on that release. They sit FIRST in the release, straight
 * under its version line, in the one amber block of the section, so they are
 * read before the highlights and the changes. Nothing renders for a release
 * that has none.
 *
 * The release history lists every release, and more than one can carry
 * warnings, so each block has an id of its own (the version is part of it).
 * The block is named by its visible label, so a screen reader says the word
 * once.
 */
function ReleaseWarnings({ entry }: { entry: ChangelogEntry }) {
  const labelId = useId()
  const warnings = releaseWarnings(entry)
  if (warnings.length === 0) return null
  return (
    <div
      role="note"
      aria-labelledby={labelId}
      data-ux-id={`whatsnew-warnings-${entry.version}`}
      className="mb-3 px-3 py-2.5 rounded-lg border border-yellow/40 bg-yellow/10"
    >
      <div id={labelId} className="text-xs font-semibold uppercase tracking-wide text-yellow mb-1.5">Warnings</div>
      <ul className="list-disc pl-5 space-y-1 text-sm text-text">
        {warnings.map((warning, i) => (
          <li key={i}>{warning}</li>
        ))}
      </ul>
    </div>
  )
}

export function VersionSection({ entry }: { entry: ChangelogEntry }) {
  return (
    <div className="mb-6 last:mb-0">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-lg font-bold text-text">v{entry.version}</span>
        <span className="text-xs text-overlay0">{formatDate(entry.date)}</span>
      </div>
      <ReleaseWarnings entry={entry} />
      {entry.highlights && (
        <p className="text-sm text-subtext1 mb-3 italic">{entry.highlights}</p>
      )}
      <ul className="space-y-1.5">
        {entry.changes.map((change, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className={`${TYPE_COLORS[change.type]} font-medium shrink-0 w-16`}>
              {TYPE_LABELS[change.type]}
            </span>
            <span className="text-subtext0">{change.description}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The changelog as a stack of version sections, newest first (as ordered). */
export function WhatsNewEntries({ entries }: { entries: ChangelogEntry[] }) {
  return (
    <>
      {entries.map((entry) => (
        <VersionSection key={entry.version} entry={entry} />
      ))}
    </>
  )
}
