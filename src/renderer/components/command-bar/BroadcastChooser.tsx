import React from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import { broadcastChoices } from '../../lib/commandBroadcast'
import { ConfirmCard } from './menus'

/**
 * aicc_planning#413 (2.1.3-beta.17, plan section C2): what every broadcast
 * press opens, in place of the old Send or Cancel question. 'Send "<label>"
 * to', then All (N), the primary button, or Choose sessions: the sessions a
 * broadcast reaches, each with a tick box beside the tab's name, its agent and,
 * for an SSH session, its host as a badge; then Send for the ticked ones.
 * Cancel and Escape send nothing.
 *
 * The list is the sessions a broadcast reached when the press asked
 * (`listed`), shown live: one that ends while the chooser is up drops out, and
 * one opened since is not added, so All answers what the chooser showed. The
 * answer is the ids picked; the CommandBar reads it once (a second Enter sends
 * nothing) and filters it again at the press (liveBroadcastPick).
 *
 * Enter answers the primary button of what is shown: All, or Send once the
 * list is open, so an Enter after unticking a session never reaches it. It is
 * taken wherever focus is, so it never reaches the terminal underneath, except
 * on a button in the card: a focused button answers its own Enter. A held
 * key's repeat is swallowed and answers nothing: holding Enter on a chip opens
 * the chooser on the first keydown, and its repeats must not answer it before
 * it is read.
 */
export default function BroadcastChooser({ label, listed, pressedId, onAnswer }: {
  /** The button's label, for the title. */
  label: string
  /** The sessions a broadcast reached when the press asked, by id, in tab order. */
  listed: readonly string[]
  /** The tab the button was pressed in: marked "this tab" in the list. */
  pressedId: string
  /** The ids picked (All: every session still listed), or null for Cancel. */
  onAnswer: (picked: string[] | null) => void
}) {
  const sessions = useSessionStore((s) => s.sessions)
  const choices = React.useMemo(() => broadcastChoices(sessions, listed), [sessions, listed])
  const [choosing, setChoosing] = React.useState(false)
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(() => new Set<string>())
  const tickedIds = choices.filter((c) => ticked.has(c.id)).map((c) => c.id)

  const answerAll = () => { if (choices.length > 0) onAnswer(choices.map((c) => c.id)) }
  const answerPicked = () => { if (tickedIds.length > 0) onAnswer(tickedIds) }
  const toggle = (id: string) => setTicked((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  // Enter: the primary button of what is shown, read at the key (a ref, so
  // the listener is added once and never answers with a stale list).
  const primary = React.useRef(answerAll)
  primary.current = choosing ? answerPicked : answerAll
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return
      const t = e.target
      if (t instanceof Element && t.closest('[data-testid="broadcast-chooser"] button')) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      primary.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The list takes the keyboard when it opens: Space ticks, Tab moves on.
  const listRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (choosing) listRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus()
  }, [choosing])

  const agents = Array.from(new Set(choices.map((c) => c.agent).filter(Boolean)))
  const none = choices.length === 0
  const body = none
    ? <>No open agent session to send to.</>
    : choosing
      ? (
        <div ref={listRef} role="group" aria-label="Sessions to send to" className="flex flex-col gap-0.5 max-h-[40vh] overflow-y-auto -mx-1" data-testid="broadcast-chooser-list">
          {choices.map((c) => (
            <label key={c.id} className="flex items-center gap-2 px-1 py-1 rounded cursor-pointer min-w-0" data-testid="broadcast-choice" data-session-id={c.id}>
              <input
                type="checkbox"
                checked={ticked.has(c.id)}
                onChange={() => toggle(c.id)}
                className="accent-[var(--brand)] shrink-0"
                data-testid="broadcast-choice-tick"
              />
              <span className="truncate" style={{ color: 'var(--text-primary)' }} data-testid="broadcast-choice-name">{c.name}</span>
              {c.id === pressedId && <span className="shrink-0" style={{ color: 'var(--text-muted)' }} data-testid="broadcast-choice-this-tab">this tab</span>}
              <span className="ml-auto shrink-0" style={{ color: 'var(--text-muted)' }} data-testid="broadcast-choice-agent">{c.agent}</span>
              {c.machine && (
                <span
                  className="shrink-0 max-w-[10rem] truncate rounded px-1 text-[10px] font-semibold leading-[14px] border"
                  style={{ background: 'var(--surface-overlay)', borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
                  title={`SSH: ${c.machine}`}
                  data-testid="broadcast-choice-machine"
                >
                  {c.machine}
                </span>
              )}
            </label>
          ))}
        </div>
      )
      : <>All sends it once to each open {agents.join(' and ')} session, SSH and background tabs included. Terminal-only tabs and Ask Conductor never get it.</>

  return (
    <ConfirmCard
      testId="broadcast-chooser"
      title={`Send "${label}" to`}
      body={body}
      actions={choosing
        ? [{ label: `Send (${tickedIds.length})`, primary: true, disabled: tickedIds.length === 0, testId: 'broadcast-chooser-send', onClick: answerPicked }]
        : [
            { label: 'Choose sessions', disabled: none, testId: 'broadcast-chooser-choose', onClick: () => setChoosing(true) },
            { label: `All (${choices.length})`, primary: true, disabled: none, testId: 'broadcast-chooser-all', onClick: answerAll },
          ]}
      onCancel={() => onAnswer(null)}
    />
  )
}
