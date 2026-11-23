// @vitest-environment jsdom
/**
 * #399 (2.1.3-beta.16, plan section B4): the button dialog's "Send to every
 * open session" option. The owner: "Per-button option", and "Broadcasty
 * should onlly be for simple prompts": it is offered on a Global prompt with
 * no arguments, and any other button shows it off with one line saying why.
 * A save always writes the field (the store merges, so turning it off must
 * clear it), and a button that takes it forgets its remembered Ctrl+click
 * arguments, so it never carries any.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({ sections: [], addSection: vi.fn() }),
}))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))

const { default: CommandDialog } = await import('../../../src/renderer/components/CommandDialog')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const byTest = <T extends Element = HTMLElement>(id: string) => container.querySelector(`[data-testid="${id}"]`) as T | null
const toggle = () => byTest<HTMLInputElement>('command-broadcast-toggle')!
const hint = () => byTest('command-broadcast-hint')!.textContent

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function render(props: Record<string, unknown>) {
  const onConfirm = vi.fn()
  act(() => { root.render(React.createElement(CommandDialog, { onConfirm, onCancel: vi.fn(), ...props } as never)) })
  return { onConfirm }
}

const newPrompt = (props: Record<string, unknown> = {}) => {
  const r = render(props)
  act(() => { byTest('command-kind-prompt')!.click() })
  act(() => { type(byTest<HTMLInputElement>('command-label')!, 'Review'); type(byTest<HTMLTextAreaElement>('command-text')!, 'review the open diff') })
  return r
}
const save = () => act(() => { byTest('command-submit')!.click() })

const PROMPT = { id: 'b1', label: 'Review', prompt: 'review the open diff', scope: 'global', kind: 'prompt', target: 'claude' }

describe('"Send to every open session" in the button dialog (#399)', () => {
  it('a new Global prompt with no arguments can take it, and saving writes it', () => {
    const { onConfirm } = newPrompt()
    expect(toggle().disabled).toBe(false)
    expect(toggle().checked).toBe(false)
    expect(byTest('command-field-broadcast')!.textContent).toContain('Send to every open session')
    act(() => { toggle().click() })
    expect(toggle().checked).toBe(true)
    save()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].broadcast).toBe(true)
  })

  it('off by default: a save writes the field cleared, not left out', () => {
    const { onConfirm } = newPrompt()
    save()
    const data = onConfirm.mock.calls[0][0]
    expect('broadcast' in data).toBe(true)
    expect(data.broadcast).toBeUndefined()
  })

  it('a Session button cannot, and says why; making it Global offers it', () => {
    newPrompt({ configId: 'cfg' })
    expect(toggle().disabled).toBe(true)
    expect(hint()).toBe('Only a Global button can go to every open session.')
    act(() => { byTest('command-scope-global')!.click() })
    expect(toggle().disabled).toBe(false)
  })

  it('a prompt with an argument cannot (simple prompts only), and an edit that adds one clears the option on save', () => {
    const { onConfirm } = render({ initial: { ...PROMPT, broadcast: true } })
    expect(toggle().checked).toBe(true)
    act(() => { type(byTest<HTMLInputElement>('command-arg-input')!, '--verbose') })
    act(() => { (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Add' && !b.closest('[data-testid="command-add"]')) as HTMLButtonElement).click() })
    expect(toggle().disabled).toBe(true)
    expect(toggle().checked).toBe(false)
    expect(hint()).toBe('Only a prompt with no arguments can go to every open session.')
    save()
    expect(onConfirm.mock.calls[0][0].defaultArgs).toEqual(['--verbose'])
    expect(onConfirm.mock.calls[0][0].broadcast).toBeUndefined()
  })

  it('a button that takes it forgets its remembered Ctrl+click arguments', () => {
    const { onConfirm } = render({ initial: { ...PROMPT, broadcast: true, lastCustomArgs: ['--fast'] } })
    expect(toggle().checked).toBe(true)
    save()
    expect(onConfirm.mock.calls[0][0].broadcast).toBe(true)
    expect(onConfirm.mock.calls[0][0].lastCustomArgs).toBeUndefined()
  })

  it('turning it off on an edit clears it', () => {
    const { onConfirm } = render({ initial: { ...PROMPT, broadcast: true } })
    act(() => { toggle().click() })
    save()
    expect(onConfirm.mock.calls[0][0].broadcast).toBeUndefined()
  })

  it('a shell line cannot take it (one press would run a command in every terminal), and saving one clears it', () => {
    const { onConfirm } = render({ initial: { id: 's1', label: 'Tests', prompt: 'npm test', scope: 'global', kind: 'shell', target: 'partner', broadcast: true } })
    expect(toggle().disabled).toBe(true)
    expect(toggle().checked).toBe(false)
    expect(hint()).toBe('Only a prompt can go to every open session.')
    save()
    expect(onConfirm.mock.calls[0][0].broadcast).toBeUndefined()
  })

  it('a page button cannot take it either, and saving one clears it', () => {
    const { onConfirm } = render({ initial: { id: 'g1', label: 'Docs', prompt: '', scope: 'global', kind: 'page', pageUrl: 'https://docs.example.com/', broadcast: true } })
    expect(toggle().disabled).toBe(true)
    expect(hint()).toBe('Only a prompt can go to every open session.')
    save()
    expect(onConfirm.mock.calls[0][0].broadcast).toBeUndefined()
  })
})

describe('the dialog\'s preview draws the pill the bar will show (#399)', () => {
  const previewPill = () => byTest('command-preview')!.querySelector('[data-testid="command-broadcast-pill"]')

  it('only while the option is on', () => {
    newPrompt()
    expect(previewPill()).toBeNull()
    act(() => { toggle().click() })
    expect(previewPill()).not.toBeNull()
    expect(previewPill()!.getAttribute('aria-label')).toBe('Sends to every open session')
    act(() => { toggle().click() })
    expect(previewPill()).toBeNull()
  })

  it('not on a button that cannot take it, whatever its record says', () => {
    render({ initial: { ...PROMPT, broadcast: true, scope: 'config', configId: 'cfg' }, configId: 'cfg' })
    expect(previewPill()).toBeNull()
  })
})
