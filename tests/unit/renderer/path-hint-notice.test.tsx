// @vitest-environment jsdom
/**
 * What every surface says when a check did not find a tool its publisher's
 * installer put in its own folder (PathHintNotice; ADR-024), as reworded in
 * the 2.1.1 closeout:
 *
 *  - F5 (aicc_planning#194): on macOS and Linux the copied text is a command to run
 *    once, which adds the folder to the shell file the login shell reads. The
 *    old bare export line changed only the terminal it was pasted into, so
 *    the tool stayed "cannot be found". The words say so, and that an
 *    installer may name ~/.zshrc or ~/.bashrc, which the app does not read.
 *    Provider-neutral: the same notice serves every tool.
 *  - F6 (aicc_planning#190): a restart advised because a
 *    Windows PATH entry names a variable this app does not have says exactly
 *    that, as a condition, and never claims the tool was seen there. It is
 *    a note (pathHintIsNote): a surface keeps its
 *    own "not found" words and shows it beside them.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const addToPath = vi.fn(async () => ({ ok: true }))
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, providerAccounts: { addToPath } }
const writeText = vi.fn(async () => undefined)
Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true })

const { PathHintNotice, pathHintText, pathHintIsNote } = await import('../../../src/renderer/onboarding/PathHintNotice')

const BS = String.fromCharCode(92)
const DS = '$'
const ZSH_COMMAND = "printf '" + BS + 'nexport PATH="$HOME/.local/bin:$PATH"' + BS + "n' >> \"" + DS + '{ZDOTDIR:-$HOME}/.zprofile"'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  writeText.mockClear()
  addToPath.mockClear()
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})
const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

describe('PathHintNotice: the run-once command on macOS and Linux', () => {
  it('says to run the command once, names the file it adds the folder to, and Copy copies exactly the command', async () => {
    const hint = { kind: 'shell-profile' as const, folder: '~/.local/bin', file: '~/.zprofile', line: ZSH_COMMAND }
    await act(async () => { root.render(React.createElement(PathHintNotice, { hint, toolName: 'Claude Code', providerId: 'claude', testIdPrefix: 't' })) })
    expect(byTest('t-path-hint-text')!.textContent).toBe(
      'Claude Code is installed in ~/.local/bin, but the PATH your login shell builds does not include that folder, so this app cannot find it. Run this once in a terminal. It adds the folder to ~/.zprofile, which the app reads through your login shell; then press Check again. An installer may name ~/.zshrc or ~/.bashrc instead, which the app does not read.',
    )
    expect(byTest('t-path-line')!.textContent).toBe(ZSH_COMMAND)
    await act(async () => { byTest('t-path-copy')!.click() })
    expect(writeText).toHaveBeenCalledWith(ZSH_COMMAND)
    expect(addToPath).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Add this line')
  })

  it('names no publisher, so it reads true for any tool, and fish gets its own file', () => {
    const text = pathHintText({ kind: 'shell-profile', folder: '~/.local/bin', file: '~/.config/fish/fish_variables', line: 'fish_add_path $HOME/.local/bin' }, 'Some Tool')
    expect(text).toContain('It adds the folder to ~/.config/fish/fish_variables, which the app reads through your login shell')
    expect(text).not.toContain('Anthropic')
    expect(text).not.toContain('OpenAI')
  })
})

describe('PathHintNotice: a restart, and why', () => {
  it('a Windows PATH entry naming a variable this app does not have: a note worded as a condition, never that the tool was seen', async () => {
    await act(async () => { root.render(React.createElement(PathHintNotice, { hint: { kind: 'restart', unresolved: true }, toolName: 'Claude Code', providerId: 'claude', testIdPrefix: 't' })) })
    const text = byTest('t-path-restart')!.textContent!
    expect(text).toBe(
      "Your PATH in Windows also names a folder through a variable set after this app started (such as nvm-windows' NVM_SYMLINK), which the app cannot look in until it starts again. If you installed Claude Code there, quit AI Code Conductor and start it again.",
    )
    expect(text).not.toContain('Claude Code is in a folder')
    expect(text).not.toMatch(/not installed|not found/)
    // Reads the same for every tool, and names no tool's publisher.
    expect(pathHintText({ kind: 'restart', unresolved: true }, 'Some Tool')).toContain('If you installed Some Tool there, quit AI Code Conductor')
  })

  it('only that restart is a note a surface shows beside its own words; every other hint takes their place', () => {
    expect(pathHintIsNote({ kind: 'restart', unresolved: true })).toBe(true)
    expect(pathHintIsNote({ kind: 'restart' })).toBe(false)
    expect(pathHintIsNote({ kind: 'add-to-path', folder: 'x' })).toBe(false)
    expect(pathHintIsNote({ kind: 'shell-profile', folder: 'x', file: 'y', line: 'z' })).toBe(false)
    expect(pathHintIsNote(undefined)).toBe(false)
  })

  it('the tool seen in a folder the registry PATH names: the wording is unchanged', () => {
    expect(pathHintText({ kind: 'restart' }, 'Claude Code')).toBe(
      'Claude Code is in a folder that your PATH in Windows names, but this app could not pick that folder up while it runs. Quit AI Code Conductor and start it again so it starts with that PATH.',
    )
  })
})
