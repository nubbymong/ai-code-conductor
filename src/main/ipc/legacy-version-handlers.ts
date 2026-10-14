import { ipcMain, BrowserWindow } from 'electron'
import {
  initLegacyVersionManager,
  fetchAvailableVersions,
  isVersionInstalled,
  installVersion,
  removeVersion,
  listInstalledVersions,
} from '../legacy-version-manager'
import { providerLaunchRefusal } from '../provider-launch-gate'

export function registerLegacyVersionHandlers(getWindow: () => BrowserWindow | null): void {
  initLegacyVersionManager(getWindow)

  ipcMain.handle('legacyVersion:fetchVersions', async () => {
    return fetchAvailableVersions()
  })

  ipcMain.handle('legacyVersion:isInstalled', async (_event, version: string) => {
    return isVersionInstalled(version)
  })

  // WP2: refused while Claude Code is switched off, as every Claude Code
  // launch is, in the answer's own shape (provider-launch-gate.ts). No launch
  // starts what this installs: a version pinned in an older release is not
  // used (2.1.1-beta.3), and no renderer code asks for an install.
  ipcMain.handle('legacyVersion:install', async (_event, version: string) => {
    const refused = providerLaunchRefusal('claude')
    if (refused) return { ok: false, error: refused.message }
    return installVersion(version)
  })

  ipcMain.handle('legacyVersion:remove', async (_event, version: string) => {
    return removeVersion(version)
  })

  ipcMain.handle('legacyVersion:listInstalled', async () => {
    return listInstalledVersions()
  })
}
