import { useEffect, useState } from 'react'
import { SSH_THROUGH_HELPER } from '../../shared/remote-machines'

/**
 * Whether main says this SSH tab runs through the session helper on its
 * machine (2.1.3-beta.17 A2): main's SSH flow state for the tab is
 * SSH_THROUGH_HELPER from its start until the tab is closed or started again.
 * Read as the SSH flow overlay reads it: main's push, and one catch-up ask for
 * a state pushed before this mounted (a push that lands first wins). False
 * while not asked (`enabled` false), unknown, or with no such bridge.
 *
 * 2.1.3-beta.18 release smoke: the session header reads it, because such a tab
 * then reported no account, so its loading pills never had anything to wait
 * for. 2.1.3-beta.19 section 3 (aicc_planning#434): such a tab names the
 * account its start read on its machine, or main says why there is none, and
 * the header reads this to say so.
 */
export function useThroughHelper(sessionId: string, enabled: boolean): boolean {
  // Keyed by the session it was read for, so a header that moves to another
  // tab never shows the last tab's answer for a frame.
  const [read, setRead] = useState<{ id: string; through: boolean } | null>(null)
  useEffect(() => {
    const ssh = window.electronAPI?.ssh
    if (!enabled || typeof ssh?.onFlowState !== 'function') return
    let cancelled = false
    let pushed = false
    const off = ssh.onFlowState(sessionId, (msg) => {
      pushed = true
      setRead({ id: sessionId, through: msg?.state === SSH_THROUGH_HELPER })
    })
    if (typeof ssh.getState === 'function') {
      ssh.getState(sessionId)
        .then((cur) => { if (!cancelled && !pushed) setRead({ id: sessionId, through: cur?.state === SSH_THROUGH_HELPER }) })
        .catch(() => { /* not known: not through the helper */ })
    }
    return () => {
      cancelled = true
      try { off() } catch { /* already gone */ }
    }
  }, [sessionId, enabled])
  return enabled && read?.id === sessionId && read.through
}
