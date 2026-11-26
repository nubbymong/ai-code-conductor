/**
 * The Session Watchdog of a tab through the session helper on another machine
 * (2.1.3-beta.19 fix round; pre-existing since beta.18). A usual SSH tab arms
 * its Watchdog at the claude-running latch inside its SSH flow
 * (pty-manager.ts setFlowState); a tab through the helper leaves the SSH
 * branch before that flow exists, so it had none. The remote helper module
 * (remote-helper/index.ts) arms it at the helper's own "the CLI runs" signal,
 * the tab's first attach to its holder, and feeds it what the tab is sent;
 * this is the Watchdog side it is given (ipc/remote-machines-handlers.ts).
 *
 * Armed as an SSH tab (`ssh: true`): the pane is drawn by a remote host, so
 * the send gate needs Claude Code's own chrome on screen before it types,
 * exactly as for a usual SSH tab. Its retry goes through the host's send
 * (session-input submitRetry), which types into the tab's terminal by the
 * Claude Code rule for a tab through the helper. Teardown is the PTY
 * manager's, as for every tab (cleanupSessionResources).
 */
import type { RemoteWatchdogDeps } from '../remote-helper'
import { getWatchdogManager } from './watchdog-manager'

export const remoteHelperWatchdog: RemoteWatchdogDeps = {
  arm: (sessionId, tab) => {
    getWatchdogManager()?.startWatchdog(sessionId, { provider: tab.provider, ssh: true, shellOnly: tab.shellOnly, ask: tab.ask, cols: tab.cols, rows: tab.rows })
  },
  feed: (sessionId, data) => {
    getWatchdogManager()?.feedData(sessionId, data)
  },
}
