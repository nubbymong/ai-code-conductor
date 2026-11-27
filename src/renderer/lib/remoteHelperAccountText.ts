// src/renderer/lib/remoteHelperAccountText.ts
/**
 * What a tab through the session helper on another machine says when it
 * cannot name its account, or show its per-model weekly bars and extra usage
 * (2.1.3-beta.19 section 3, aicc_planning#434), by main's fixed reason
 * (StatuslineData.remoteAccountNotShown, .remoteUsageNotShown). Plain words;
 * never an empty or zero bar.
 */
import type { RemoteAccountNotShown, RemoteUsageNotShown } from '../../shared/types'

/** The header's account pill when the tab's start named no account. */
export const REMOTE_ACCOUNT_NOT_SHOWN_LABEL = 'Account not available'

export const REMOTE_ACCOUNT_NOT_SHOWN_TITLE: Readonly<Record<RemoteAccountNotShown, string>> = {
  'no-account': 'This tab runs through the session helper on its machine. Claude Code there names no account in its ~/.claude.json (for example, it is not signed in, or it signed in with a token), so none is shown.',
  'not-read': 'This tab runs through the session helper on its machine. The helper there did not answer the account read, so no account is shown. Press Check on the Machines page.',
}

/** The strip's note in place of the per-model weekly bars and extra usage:
 *  one short label (2.1.3-beta.19 text smoke #36: a long one did not fit at
 *  1280 px), its reason in the title. */
export const REMOTE_USAGE_NOT_SHOWN_TEXT: Readonly<Record<RemoteUsageNotShown, { label: string; title: string }>> = {
  'own-sign-in': {
    label: 'Model limits: not available',
    title: 'Not available: this machine uses its own sign-in. The weekly limits by model and the extra usage are read on this computer, which does not hold the account this tab runs as.',
  },
  'no-reading': {
    label: 'Model limits: not available',
    title: 'Not available: this computer holds the account this tab runs as, and has no current usage reading for it.',
  },
}
