/**
 * aicc_planning#117: a spawn whose config is set to "Always start a new
 * conversation" carries `freshConversation: true`. Every resume target main
 * would otherwise use -- a restored tab's persisted one, the one a Restart
 * self-captured, Codex's kept one, and the launch gate's view of them -- goes
 * through here, so the flag can only ever REMOVE a resume, never add one.
 * Only `true` counts; anything else keeps the target.
 */
export function resumeUnlessFresh<T>(options: { freshConversation?: boolean } | undefined, target: T | undefined): T | undefined {
  return options?.freshConversation === true ? undefined : target
}
