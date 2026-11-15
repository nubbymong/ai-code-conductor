// What the folder step of first-run setup is answered when it saves a folder
// (setup:setDataDir, setup:setResourcesDir).
//
//   true   the folder is saved.
//   false  it is not, for a reason of the folder's own (it could not be
//          created, or its path cannot be stored as written).
//   null   it is not, and the reason is not the folder at all
//          (SETTINGS_FILE_UNREADABLE, below).
//
// Only `true` is "saved". A save that was refused is never answered with a
// value that reads as true, so a caller that asks no more than "was it
// saved?" is never told yes by a refusal. A caller that says why reads the
// answer with FolderSaveAnswer.
//
// On macOS and Linux the app saves its folders in a settings file under the
// home folder (platform-config.json, src/main/platform-config-store.ts). A
// file that is there but cannot be read is left as it is and nothing is
// saved over it, so choosing another folder would not help: the step says
// which file it is and what to do. One copy of the answer and of the
// sentence, shared by main and the setup screen.

/** A folder was not saved because the settings file is there but did not
 *  read. Never answered on Windows, which saves its folders in the registry. */
export const SETTINGS_FILE_UNREADABLE = null

/** What a folder save answers: true (saved), false (not saved, the folder's
 *  own reason) or SETTINGS_FILE_UNREADABLE (not saved, the settings file). */
export type FolderSaveAnswer = boolean | typeof SETTINGS_FILE_UNREADABLE

/** What the folder step says for SETTINGS_FILE_UNREADABLE, after it has
 *  said which folder was not saved. */
export const SETTINGS_FILE_UNREADABLE_TEXT =
  'The settings file the app keeps in your home folder (.ai-code-conductor/platform-config.json, or the same file in .claude-conductor on an older install) is there but could not be read, so it was left as it is and nothing was saved. Repair that file or remove it, then press Continue again.'
