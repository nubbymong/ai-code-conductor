import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'
import type { SnapEngine } from '../../shared/snap-engine'

export interface MagicButtonSettings {
  screenshotColor: string
  autoDeleteDays: number | null
  /** Snap on Windows: the user's own choice, saved only when made (no
   *  default here: src/shared/snap-engine.ts holds it, so a later default
   *  reaches everyone who never chose). Main reads it at each press. */
  snapEngineWindows?: SnapEngine
}

interface MagicButtonState {
  settings: MagicButtonSettings
  isLoaded: boolean
  hydrate: (settings: MagicButtonSettings) => void
  updateSettings: (updates: Partial<MagicButtonSettings>) => void
}

export const MAGIC_BUTTON_DEFAULTS: MagicButtonSettings = {
  screenshotColor: '#00FFFF',
  autoDeleteDays: null
}

export const useMagicButtonStore = create<MagicButtonState>((set) => ({
  settings: { ...MAGIC_BUTTON_DEFAULTS },
  isLoaded: false,

  hydrate: (settings) => set({ settings: { ...MAGIC_BUTTON_DEFAULTS, ...settings }, isLoaded: true }),

  updateSettings: (updates) =>
    set((state) => {
      const settings = { ...state.settings, ...updates }
      saveConfigNow('magicButtons', settings)
      return { settings }
    })
}))
