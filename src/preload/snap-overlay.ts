/**
 * The preload of Snap's own overlay page (src/main/snap/overlay.ts). Two calls
 * and nothing else: ask for this display's picture once, answer once.
 *
 * The window is sandboxed, so this preload must be ONE file: a sandboxed
 * preload can load 'electron' and nothing from disk. It therefore imports no
 * code from src/: a module the app's main preload also imports (such as
 * src/shared/ipc-channels.ts) would be split by the build into a shared chunk
 * that this preload could not load. The two channel names are spelled out
 * here; tests/unit/main/snap-overlay.test.ts holds them equal to IPC's
 * SNAP_OVERLAY_READY and SNAP_OVERLAY_ANSWER and this file to its one import.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { SnapOverlayInit, SnapOverlayMessage } from '../shared/snap-overlay'

contextBridge.exposeInMainWorld('snapOverlay', {
  ready: (): Promise<SnapOverlayInit> => ipcRenderer.invoke('snapOverlay:ready'),
  answer: (message: SnapOverlayMessage): void => ipcRenderer.send('snapOverlay:answer', message),
})
