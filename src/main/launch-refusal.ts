/**
 * The marker a managed-launch refusal carries, and the sentence inside it.
 *
 * On its own, with no imports, so modules that must stay free of the
 * account-profiles graph (claude-headless, which is unit-tested against a stub
 * pty-manager with no electron) can still turn a refusal into text a user
 * reads. account-profiles re-exports both.
 */

/** Prefix every managed-launch refusal carries, so a caller can tell an
 *  ISOLATION FAULT apart from an ordinary failure (a missing CLI, a timeout)
 *  instead of swallowing both in one bare catch (adversarial review, MAJOR 7). */
export const MANAGED_LAUNCH_REFUSAL = '[profiles] refusing a managed Claude launch'

/** The sentence inside an error thrown by a managed launch refusal, without
 *  the log marker in front of it, for text a user reads (an agent's banner, a
 *  run's error), starting with a capital letter. A message that is not a
 *  managed launch refusal is returned unchanged. */
export function launchRefusalText(message: string): string {
  const prefix = `${MANAGED_LAUNCH_REFUSAL}: `
  const at = message.indexOf(prefix)
  if (at < 0) return message
  const sentence = message.slice(at + prefix.length)
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/** For a terminal line about ANY failed spawn: the sentence when the message
 *  IS a managed launch refusal (it starts with the marker), and any other
 *  message as it is. Unlike launchRefusalText it never cuts a message that
 *  only contains the marker further in, such as a node-pty error quoting a
 *  directory whose name holds it. */
export function refusalSentenceOrMessage(message: string): string {
  return message.startsWith(`${MANAGED_LAUNCH_REFUSAL}: `) ? launchRefusalText(message) : message
}
