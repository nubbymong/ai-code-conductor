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
