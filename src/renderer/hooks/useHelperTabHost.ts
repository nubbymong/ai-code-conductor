import { useEffect, useMemo } from 'react'
import type { Session } from '../stores/sessionStore'
import { useHostAccountsStore } from '../stores/hostAccountsStore'
import { useThroughHelper } from './useThroughHelper'
import { isHelperTab } from '../utils/sessionLaunch'
import { machineLabel, sessionMachine } from '../utils/hostAccounts'
import type { SwitchHostSource } from '../utils/switchAccountItems'

/**
 * 2.1.3-beta.20 section 5 (frame 3): what the Switch Account surfaces (the
 * sidebar's right-click menu, the status strip's account pill) need of a tab
 * through the session helper: that it is one (`viaHelper`, isHelperTab), and
 * its machine with that machine's last read (`host`), which marks each
 * account's sign-in there. A helper tab reads the machines' last reads once
 * it is shown (no exec; main reads a machine at each launch on it anyway).
 */
export function useHelperTabHost(session: Session | null | undefined): { viaHelper: boolean; host: SwitchHostSource | undefined } {
  const throughHelper = useThroughHelper(session?.id ?? '', session?.sessionType === 'ssh' && !!session?.sshConfig)
  const viaHelper = isHelperTab(session, throughHelper)
  const machines = useHostAccountsStore((s) => s.machines)
  const byDid = useHostAccountsStore((s) => s.byDid)
  useEffect(() => {
    if (viaHelper) void useHostAccountsStore.getState().load()
  }, [viaHelper])
  const host = useMemo<SwitchHostSource | undefined>(() => {
    if (!viaHelper) return undefined
    const m = sessionMachine(session, machines)
    return m ? { machineName: machineLabel(m), accounts: byDid[m.did] } : undefined
  }, [viaHelper, session, machines, byDid])
  return { viaHelper, host }
}
