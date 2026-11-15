/// <reference types="vite/client" />
/**
 * 2.1.3-beta.4: the Tokenomics switch and the accounts left out apply while
 * the app runs because main reads the saved settings again each time they
 * are saved (tokenomics-service applyTokenomicsSettings, tested in
 * tests/unit/tokenomics/tokenomics-optional-service.test.ts). This pins what
 * reaches it: the settings-saved hook in main's start-up calls it, in its own
 * try, and the service is started before its IPC handlers are registered.
 * Without the call the switch and the list would only apply at the next
 * start, and nothing else would say so.
 */
import { describe, it, expect } from 'vitest'
import indexSource from '../../../src/main/index.ts?raw'

/** The source with its comments removed, so a commented-out line fails. */
const code = indexSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n')

describe('the Tokenomics settings reach the running service (2.1.3-beta.4)', () => {
  it('main applies them each time the settings are saved, in its own try', () => {
    const settingsAt = code.indexOf('onSettingsSaved:')
    expect(settingsAt).toBeGreaterThan(-1)
    const configsAt = code.indexOf('onConfigsSaved:', settingsAt)
    expect(configsAt).toBeGreaterThan(settingsAt)
    const settingsBody = code.slice(settingsAt, configsAt)
    expect(settingsBody).toMatch(/try \{ applyTokenomicsSettings\(\) \} catch \(err\) \{ logError\(/)
    // Once: the saved configs do not hold the switch.
    expect(code.split('applyTokenomicsSettings()').length).toBe(2)
  })

  it('main takes it from the service, and starts the service before its handlers are registered', () => {
    expect(code).toMatch(/import \{[^}]*\bapplyTokenomicsSettings\b[^}]*\} from '\.\/tokenomics\/tokenomics-service'/)
    const initAt = code.indexOf('try { initTokenomics({ emit: emitWithMerge }) } catch (err) { logError(')
    expect(initAt).toBeGreaterThan(-1)
    const handlersAt = code.indexOf('registerTokenomics2Handlers(getWindow)')
    expect(handlersAt).toBeGreaterThan(initAt)
    // The hook is set up before either: a save can come at any time after.
    expect(code.indexOf('onSettingsSaved:')).toBeLessThan(initAt)
  })
})
