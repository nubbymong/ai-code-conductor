import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { initModelRegistry, getRegistry, onRegistryReload } from '../model-registry-service'
import { getAccountsService } from '../provider-accounts'
import { followInstalledCodexModels } from '../installed-codex-models'

export function registerRegistryHandlers(resourcesDir: string): void {
  initModelRegistry(resourcesDir)
  onRegistryReload((reg) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send(IPC.REGISTRY_UPDATE, reg) } catch { /* window destroyed */ }
    }
  })
  ipcMain.handle(IPC.REGISTRY_GET, () => getRegistry())
  // aicc_planning#362: the Codex models are the installed Codex's own list
  // once it is read, read again whenever what the app finds of Codex changes
  // (installed-codex-models.ts). The accounts service is up by now
  // (index.ts makes it first); none (its start failed): the registry alone.
  followInstalledCodexModels(getAccountsService())
}
