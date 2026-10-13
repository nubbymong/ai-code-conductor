// @vitest-environment jsdom
/**
 * aicc_planning#88: the SSH connection card's subtitle read "Another machine,
 * plain session", and users took "plain" to mean no AI (the Terminal only card
 * just above calls itself a plain terminal with no AI). What actually
 * separates SSH from SSH Persistent is what happens when the link drops, so
 * the subtitle now says that, in the same shape as the SSH Persistent card's.
 * The guided tour's saved-config card and the sidebar-marks showcase page used
 * the same "plain" for SSH and are covered in their own tests.
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
  legacyVersion: {
    fetchVersions: vi.fn().mockResolvedValue([]),
    isInstalled: vi.fn().mockResolvedValue(false),
    install: vi.fn().mockResolvedValue({ ok: true }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
  },
  dialog: { openFolder: vi.fn().mockResolvedValue(null) },
  credentials: { save: vi.fn(), delete: vi.fn() },
}
;(window as any).electronPlatform = 'win32'

import SessionDialog from '../../../src/renderer/components/SessionDialog'

const base = {
  id: 'c1',
  label: 'App Dev',
  workingDirectory: 'C:\\proj',
  color: '',
  sessionType: 'local',
  provider: 'claude',
}

describe('SessionDialog - SSH connection card text (aicc_planning#88)', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const render = (initial: Record<string, unknown>) => {
    act(() => { root.render(React.createElement(SessionDialog, { initial, onConfirm: vi.fn(), onCancel: vi.fn() } as any)) })
  }
  /** The text of the card that holds the Connection radio with this value. */
  const cardText = (value: string) =>
    container.querySelector(`[role="radiogroup"][aria-label="Connection"] input[value="${value}"]`)!
      .closest('label')!.textContent

  it.each([
    ['a Claude Code config', 'claude'],
    ['a Terminal only config', 'terminal'],
  ])('on %s the SSH card says the session ends on disconnect', (_label, provider) => {
    render({ ...base, provider })
    expect(cardText('ssh')).toBe('SSHAnother machine, ends on disconnect')
  })

  it('no connection card calls a session "plain" (that word belongs to Terminal only)', () => {
    render(base)
    const group = container.querySelector('[role="radiogroup"][aria-label="Connection"]')!
    expect(group.textContent).not.toMatch(/\bplain\b/i)
  })

  it('the SSH Persistent card keeps its matching disconnect wording', () => {
    render(base)
    expect(cardText('ssh-persistent')).toBe('SSH PersistentSurvives disconnects, reattaches')
  })
})
