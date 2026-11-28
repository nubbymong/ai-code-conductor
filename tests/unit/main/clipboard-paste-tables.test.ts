// The provider tables for the clipboard image paste (ADR-032, row 14; plan
// 2.1.3-beta.21 phase 2, 2.1.2): each CLI's own paste key per OS, the
// formats its read takes, and whether it reads a copied file itself.
//  - Claude Code: ESC v on Windows, Ctrl+V on macOS and Linux, unless the
//    account's keybindings.json rebinds chat:imagePaste in its Chat context;
//    a chord goes through a fixed chord-to-bytes table, and a binding the
//    table cannot express, or a default taken away with nothing bound, gets
//    no key (the hint asks for Claude Code's own key). A file that is not a
//    keybindings file, or no file, is the default. Never a copied file.
//  - Codex: ESC v on Windows, Ctrl+V elsewhere; reads a copied file itself on
//    Windows and macOS.
//  - Each table is the registered provider's (SessionProvider.clipboardPaste).
// Red on 0c54a1c6: no such tables (the renderer's IMAGE_LINES held only the
// path route's line). Mutants this must catch: the keybindings file ignored
// (the binding pinned); a chord's raw text sent as bytes.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  claudeImagePasteKey, claudeChordBytes, readImagePasteBindings, claudeConfigDirOf, readClaudeKeybindingsText, CLAUDE_CLIPBOARD_PASTE, claudeDefaultImagePasteChord,
} from '../../../src/main/providers/claude/clipboard-paste'
import { codexImagePasteKey, CODEX_CLIPBOARD_PASTE } from '../../../src/main/providers/codex/clipboard-paste'

const ESC_V = '\u001bv'
const CTRL_V = '\u0016'
const file = (bindings: Record<string, string | null>, context = 'Chat') => JSON.stringify({ $schema: 'x', bindings: [{ context, bindings }] })

describe('Claude Code\'s key', () => {
  it('the default: Alt+V (ESC v) on Windows, Ctrl+V on macOS and Linux', () => {
    expect(claudeDefaultImagePasteChord('win32')).toBe('alt+v')
    expect(claudeImagePasteKey('win32', null)).toEqual({ bytes: ESC_V, chord: 'alt+v', from: 'default' })
    expect(claudeImagePasteKey('darwin', null)).toEqual({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' })
    expect(claudeImagePasteKey('linux', null)).toEqual({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' })
  })

  it('read from the account\'s keybindings, never pinned: a chord bound to chat:imagePaste is sent, by the chord table', () => {
    expect(claudeImagePasteKey('win32', file({ 'ctrl+y': 'chat:imagePaste' }))).toEqual({ bytes: '\u0019', chord: 'ctrl+y', from: 'keybindings' })
    expect(claudeImagePasteKey('linux', file({ 'alt+p': 'chat:imagePaste' }))).toEqual({ bytes: '\u001bp', chord: 'alt+p', from: 'keybindings' })
    expect(claudeImagePasteKey('win32', file({ 'opt+shift+i': 'chat:imagePaste' }))).toEqual({ bytes: '\u001bI', chord: 'opt+shift+i', from: 'keybindings' })
  })

  it('the default taken away with nothing bound: no key (unbound); moved to a chord the table cannot send: no key (unexpressible)', () => {
    expect(claudeImagePasteKey('win32', file({ 'alt+v': null }))).toEqual({ bytes: null, chord: null, why: 'unbound' })
    expect(claudeImagePasteKey('win32', file({ 'meta+v': 'chat:externalEditor' }))).toEqual({ bytes: null, chord: null, why: 'unbound' })
    expect(claudeImagePasteKey('win32', file({ 'alt+v': null, 'ctrl+k ctrl+v': 'chat:imagePaste' }))).toEqual({ bytes: null, chord: 'ctrl+k ctrl+v', why: 'unexpressible' })
    expect(claudeImagePasteKey('darwin', file({ 'cmd+i': 'chat:imagePaste' }))).toEqual({ bytes: null, chord: 'cmd+i', why: 'unexpressible' })
  })

  it('a binding in another context, another action, or a file that is not a keybindings file: the default', () => {
    expect(claudeImagePasteKey('win32', file({ 'alt+v': null }, 'Global'))).toMatchObject({ bytes: ESC_V, from: 'default' })
    expect(claudeImagePasteKey('win32', file({ 'ctrl+e': 'chat:externalEditor' }))).toMatchObject({ bytes: ESC_V, from: 'default' })
    for (const text of ['', 'not json', '{}', '{"bindings": {}}', '[]', 'null']) {
      expect(claudeImagePasteKey('win32', text), text).toMatchObject({ bytes: ESC_V, from: 'default' })
    }
  })

  it('the default rebound to the image paste again after a null is the image paste\'s', () => {
    expect(readImagePasteBindings(file({ 'alt+v': 'chat:imagePaste' }), 'alt+v')).toEqual({ bound: ['alt+v'], defaultRemoved: false })
    expect(readImagePasteBindings(file({ 'meta+v': null }), 'alt+v')).toEqual({ bound: [], defaultRemoved: true })
  })
})

describe('the fixed chord-to-bytes table', () => {
  it('a letter with Ctrl, Alt (or its aliases), Alt and Shift, or Ctrl and Alt', () => {
    expect(claudeChordBytes('ctrl+v')).toBe(CTRL_V)
    expect(claudeChordBytes('control+v')).toBe(CTRL_V)
    expect(claudeChordBytes('alt+v')).toBe(ESC_V)
    expect(claudeChordBytes('meta+v')).toBe(ESC_V)
    expect(claudeChordBytes('option+v')).toBe(ESC_V)
    expect(claudeChordBytes('Alt+Shift+V')).toBe('\u001bV')
    expect(claudeChordBytes('ctrl+alt+v')).toBe('\u001b\u0016')
  })

  it('nothing else: two keystrokes, cmd or super, Shift alone, a key that is not a letter, a repeated or unknown modifier', () => {
    for (const chord of ['ctrl+k ctrl+v', 'cmd+v', 'super+v', 'win+v', 'shift+v', 'v', 'ctrl+1', 'alt+enter', 'ctrl+[', 'ctrl+ctrl+v', 'ctl+v', 'ctrl+shift+v', '', '+', 'ctrl+']) {
      expect(claudeChordBytes(chord), chord).toBeNull()
    }
  })

  it('never a key that ends Claude Code or that a terminal reads as Enter, a new line, Tab or Backspace', () => {
    for (const k of ['c', 'd', 'm', 'j', 'i', 'h']) expect(claudeChordBytes(`ctrl+${k}`), k).toBeNull()
  })

  it('a chord is never sent as its own text', () => {
    for (const chord of ['alt+v', 'ctrl+v', 'ctrl+alt+v']) expect(claudeChordBytes(chord)).not.toContain('+')
  })
})

describe('the account\'s config folder and its keybindings file', () => {
  it('a launch\'s account folder, else CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(claudeConfigDirOf('C:\\acct\\one')).toBe('C:\\acct\\one')
    const before = process.env.CLAUDE_CONFIG_DIR
    try {
      process.env.CLAUDE_CONFIG_DIR = 'C:\\elsewhere'
      expect(claudeConfigDirOf(null)).toBe('C:\\elsewhere')
      delete process.env.CLAUDE_CONFIG_DIR
      expect(claudeConfigDirOf(null)).toMatch(/[\\/]\.claude$/)
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = before
    }
  })

  it('the rule reads that folder\'s keybindings.json: a rebound key there is the one sent; no file, a folder in its place, or a huge file, the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccc-kb-'))
    try {
      expect(CLAUDE_CLIPBOARD_PASTE.key({ platform: 'win32', accountDir: dir })).toMatchObject({ bytes: ESC_V, from: 'default' })
      writeFileSync(join(dir, 'keybindings.json'), file({ 'alt+v': null, 'ctrl+y': 'chat:imagePaste' }))
      expect(CLAUDE_CLIPBOARD_PASTE.key({ platform: 'win32', accountDir: dir })).toEqual({ bytes: '\u0019', chord: 'ctrl+y', from: 'keybindings' })
      writeFileSync(join(dir, 'keybindings.json'), 'x'.repeat(300 * 1024))
      expect(readClaudeKeybindingsText(dir)).toBeNull()
      rmSync(join(dir, 'keybindings.json'))
      mkdirSync(join(dir, 'keybindings.json'))
      expect(readClaudeKeybindingsText(dir)).toBeNull()
      expect(CLAUDE_CLIPBOARD_PASTE.key({ platform: 'linux', accountDir: dir })).toMatchObject({ bytes: CTRL_V, from: 'default' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the rest of each table, per OS and CLI', () => {
  it('Codex: ESC v on Windows, Ctrl+V on macOS and Linux', () => {
    expect(codexImagePasteKey('win32')).toEqual({ bytes: ESC_V, chord: 'alt+v', from: 'default' })
    expect(codexImagePasteKey('darwin')).toEqual({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' })
    expect(codexImagePasteKey('linux')).toEqual({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' })
    expect(CODEX_CLIPBOARD_PASTE.key({ platform: 'win32', accountDir: 'C:\\x' })).toEqual({ bytes: ESC_V, chord: 'alt+v', from: 'default' })
  })

  it('a copied file: Codex reads it itself on Windows and macOS; Claude Code never does', () => {
    expect(CODEX_CLIPBOARD_PASTE.readsCopiedFile('win32')).toBe(true)
    expect(CODEX_CLIPBOARD_PASTE.readsCopiedFile('darwin')).toBe(true)
    expect(CODEX_CLIPBOARD_PASTE.readsCopiedFile('linux')).toBe(false)
    for (const p of ['win32', 'darwin', 'linux'] as const) expect(CLAUDE_CLIPBOARD_PASTE.readsCopiedFile(p), p).toBe(false)
  })

  it('the formats each read takes', () => {
    expect(CLAUDE_CLIPBOARD_PASTE.formats('win32')).toEqual(['CF_DIB', 'PNG'])
    expect(CLAUDE_CLIPBOARD_PASTE.formats('darwin')).toEqual(['public.png'])
    expect(CLAUDE_CLIPBOARD_PASTE.formats('linux')).toEqual(['image/png'])
    expect(CODEX_CLIPBOARD_PASTE.formats('win32')).toEqual(['PNG', 'CF_DIB'])
    expect(CODEX_CLIPBOARD_PASTE.formats('darwin')).toEqual(['public.tiff', 'public.png'])
    expect(CODEX_CLIPBOARD_PASTE.formats('linux')).toEqual(['image/png'])
  })

  it('each registered provider offers its own table', async () => {
    const { ClaudeProvider } = await import('../../../src/main/providers/claude')
    const { CodexProvider } = await import('../../../src/main/providers/codex')
    expect(new ClaudeProvider().clipboardPaste).toBe(CLAUDE_CLIPBOARD_PASTE)
    expect(new CodexProvider().clipboardPaste).toBe(CODEX_CLIPBOARD_PASTE)
  })
})
