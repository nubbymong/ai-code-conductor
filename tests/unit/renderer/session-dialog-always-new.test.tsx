// @vitest-environment jsdom
/**
 * aicc_planning#117: the session dialog's "Always start a new conversation"
 * checkbox, driven through the REAL dialog. Off by default (nothing written),
 * saved as `alwaysNewConversation: true` when ticked, reopened from what is
 * stored, and offered only for a local agent session.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({ groups: [], addGroup: vi.fn(), sections: [], addSection: vi.fn() }),
}))

;(window as any).electronAPI = {
  debug: { isEnabled: vi.fn().mockResolvedValue(false) },
  dialog: { openFolder: vi.fn().mockResolvedValue(null) },
  credentials: { save: vi.fn(), delete: vi.fn() },
  legacyVersion: {
    fetchVersions: vi.fn().mockResolvedValue([]),
    isInstalled: vi.fn().mockResolvedValue(false),
    install: vi.fn().mockResolvedValue({ ok: true }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
  },
}
;(window as any).electronPlatform = 'win32'

import SessionDialog from '../../../src/renderer/components/SessionDialog'
import { useProviderAccountsStore } from '../../../src/renderer/stores/providerAccountsStore'
import { snapshot } from './accounts-snapshot-harness'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useProviderAccountsStore.setState({ snapshot: snapshot({ externalDefaults: [{ providerId: 'codex', home: '~/.codex' }] }), loaded: true })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: true, codexAnswered: true } })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(props: Record<string, unknown> = {}) {
  const onConfirm = vi.fn()
  act(() => { root.render(React.createElement(SessionDialog, { onConfirm, onCancel: vi.fn(), ...props } as any)) })
  return onConfirm
}
function card(group: string, title: string): HTMLInputElement {
  const g = container.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!
  const lab = Array.from(g.querySelectorAll('label')).find((l) => l.querySelector('span')?.textContent === title)!
  return lab.querySelector('input[type="radio"]') as HTMLInputElement
}
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
function newLocalConfig(): ReturnType<typeof vi.fn> {
  const onConfirm = render()
  act(() => { card('Provider', 'Claude Code').click() })
  act(() => { card('Connection', 'Local').click() })
  const wd = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder === 'C:\\path\\to\\project') as HTMLInputElement
  setInput(wd, 'C:\\proj')
  const label = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder === 'e.g. App Dev') as HTMLInputElement
  setInput(label, 'worker')
  return onConfirm
}
const submit = () => act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
const saved = (onConfirm: ReturnType<typeof vi.fn>) => onConfirm.mock.calls[0][0]
const box = () => container.querySelector('[data-testid="always-new-conversation"]') as HTMLInputElement | null

describe('"Always start a new conversation" (aicc_planning#117)', () => {
  it('is off by default and writes nothing', () => {
    const onConfirm = newLocalConfig()
    expect(box()!.checked).toBe(false)
    submit()
    expect(saved(onConfirm).alwaysNewConversation).toBeUndefined()
  })

  it('ticked, it saves alwaysNewConversation: true', () => {
    const onConfirm = newLocalConfig()
    act(() => { box()!.click() })
    submit()
    expect(saved(onConfirm).alwaysNewConversation).toBe(true)
  })

  it('an edit reopens what is stored and keeps it', () => {
    const onConfirm = render({ initial: { id: 'c1', provider: 'claude', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj', color: '', alwaysNewConversation: true } })
    expect(box()!.checked).toBe(true)
    submit()
    expect(saved(onConfirm).alwaysNewConversation).toBe(true)
  })

  it('is not offered for an SSH session', () => {
    render()
    act(() => { card('Provider', 'Claude Code').click() })
    act(() => { card('Connection', 'SSH').click() })
    expect(box()).toBeNull()
  })
})
