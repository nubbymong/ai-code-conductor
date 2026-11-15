/**
 * The Screen Recording check Snap makes on macOS before it captures.
 *
 * macOS lets a program capture the screen only once the user has allowed it in
 * System Settings, Privacy and Security, Screen Recording. Snap used to start
 * the capture without looking, so with the permission off it ran a capture the
 * system does not allow. This asks first: when the permission is not granted,
 * the user is told in a sentence and offered System Settings, and nothing is
 * captured. Everything the check touches is a parameter, so it tests with a
 * fake permission state on any OS.
 *
 * What this does NOT claim: that a missing permission is what made Snap close
 * the app on a Mac. That cause is not known; the guard is a defence that holds
 * whatever the cause turns out to be.
 */
import { logWarn } from './debug-logger'

/** The Screen Recording pane of System Settings. */
export const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

/** What Snap says when the permission is not granted. */
export const SCREEN_RECORDING_NEEDED_MESSAGE =
  'Snap needs permission to record your screen, and this app does not have it yet. Open System Settings, Privacy and Security, Screen Recording, switch on AI Code Conductor, then quit and reopen the app and press Snap again.'

/** What Snap says when an administrator's policy blocks the permission. */
export const SCREEN_RECORDING_RESTRICTED_MESSAGE =
  'Snap cannot record your screen because a policy on this Mac blocks it. Ask whoever manages this Mac to allow Screen Recording for AI Code Conductor.'

export interface ScreenPermissionDeps {
  platform: NodeJS.Platform
  /** The system's answer for the screen: 'granted', 'denied', 'not-determined', 'restricted' or 'unknown'. */
  status: () => string
  /** Shows `message` and asks whether to open System Settings; true when the user chose to. When
   *  `canOpen` is false there is nothing to open and the message is shown with an OK only. */
  ask: (message: string, canOpen: boolean) => Promise<boolean>
  /** Opens the Screen Recording pane. */
  open: (url: string) => Promise<void> | void
}

/**
 * Whether Snap may start a capture. True off macOS (the permission is the
 * system's there and cannot be asked ahead), and on macOS when the system says
 * it is granted, or cannot say (a failed read must not stop a capture that may
 * well work; the capture itself is guarded). Otherwise the user is told and the
 * answer is false. Never throws: a dialog that fails to show is logged and
 * still answers false.
 */
export async function screenCaptureAllowed(deps: ScreenPermissionDeps): Promise<boolean> {
  if (deps.platform !== 'darwin') return true
  let status: string
  try {
    status = deps.status()
  } catch (err) {
    logWarn(`[screenshot] the Screen Recording permission could not be read (${err instanceof Error ? err.name : 'error'}); capturing anyway`)
    return true
  }
  if (status === 'granted') return true
  const restricted = status === 'restricted'
  try {
    const openIt = await deps.ask(restricted ? SCREEN_RECORDING_RESTRICTED_MESSAGE : SCREEN_RECORDING_NEEDED_MESSAGE, !restricted)
    if (openIt && !restricted) await deps.open(SCREEN_RECORDING_SETTINGS_URL)
  } catch (err) {
    logWarn(`[screenshot] the Screen Recording message could not be shown (${err instanceof Error ? err.name : 'error'})`)
  }
  return false
}
