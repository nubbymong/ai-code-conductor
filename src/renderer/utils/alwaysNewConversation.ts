/** #117: a config set to "Always start a new conversation" never offers the
 *  resume picker on its own and never carries a conversation over (launch,
 *  relaunch restore, Restart, Recover). Only true opts in; a missing config
 *  (deleted, or an id-less session) keeps today's behaviour. An explicit
 *  "Restart and pick a conversation" still opens the picker. */
export function configStartsNewConversation(
  configs: ReadonlyArray<{ id: string; alwaysNewConversation?: boolean }> | undefined,
  configId: string | undefined,
): boolean {
  if (!configId || !configs) return false
  return configs.find((c) => c.id === configId)?.alwaysNewConversation === true
}

// Sessions whose next spawn keeps the conversation it is on whatever the
// config says: a Switch account moves the running conversation to another
// account, it does not start the session anew. One-shot, as the picker mark.
const keepConversationSessionIds = new Set<string>()

export function markSessionKeepsConversation(sessionId: string): void {
  keepConversationSessionIds.add(sessionId)
}

/** Consumes the mark: true once after markSessionKeepsConversation. */
export function consumeKeepsConversation(sessionId: string): boolean {
  return keepConversationSessionIds.delete(sessionId)
}

/** Whether this spawn starts a new conversation (TerminalView's
 *  `freshConversation`): the config says so, and neither the resume picker
 *  (an explicit "pick a conversation") nor a Switch account's keep applies. */
export function spawnStartsNewConversation(o: { shellOnly?: boolean; pickerArmed: boolean; keepsConversation: boolean; configStartsNew: boolean }): boolean {
  return !o.shellOnly && !o.pickerArmed && !o.keepsConversation && o.configStartsNew
}
