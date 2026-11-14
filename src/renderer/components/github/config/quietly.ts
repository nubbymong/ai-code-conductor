/**
 * For a control on the GitHub settings page that starts a save and has
 * nothing more to do with how it ends.
 *
 * Every save here goes through the GitHub store, and a save that did not go
 * through has already left its reason in the store's `saveError`, which the
 * page shows in one line (GitHubConfigTab). So the rejection is taken here and
 * not left unhandled; the control needs no handler of its own.
 */
export function quietly(save: unknown): void {
  void Promise.resolve(save).catch(() => {})
}
