import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { ServiceRegistry } from '../services/service-registry'

/** The diagnostics IPC. Both channels are answered by the one service registry
 *  (src/main/services/service-registry.ts): the snapshot is every row it
 *  lists, and a restart goes to whatever owns that row. With hooks off in
 *  Settings the hooks row is still there, and reads stopped. */
export function registerServiceHealthHandlers(registry: Pick<ServiceRegistry, 'snapshot' | 'restart'>): void {
  ipcMain.handle(IPC.SERVICE_HEALTH_GET, async () => registry.snapshot())
  ipcMain.handle(IPC.SERVICE_RESTART, async (_e, serviceId: string) => registry.restart(serviceId))
}
