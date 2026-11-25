// 2.1.3-beta.18 section 4 (aicc_planning#432; ADR-030 component rows 3 and
// 14): the session input module's doors type a session through the run screen
// its provider's REAL package offers (SessionProvider.runScreen), and a
// provider with no member for a door takes nothing there. The door tests
// register stand-ins built from the packages' parts (CLAUDE_RUN_SCREEN, or
// codexDoorMembers over a fake), so none of them would see a package that
// stopped offering its members: every prompt button, broadcast, canvas
// marker, Watchdog retry and Alt+V image into that provider's sessions would
// then be not taken and type nothing, with every door test still green. This
// holds the real packages to their door members:
//  - Claude Code: retry, prompt, marker and image; no ask (Ask Conductor runs
//    on Codex) and no submit (main reads no Claude Code screen).
//  - Codex: retry, prompt, marker, image and ask.
// (session-input-ssh.test.ts types a retry through the real Claude Code
// package, registered, into an SSH session.)
//
// Mutants this must catch: the Claude Code package's
// `readonly runScreen = CLAUDE_RUN_SCREEN` deleted; the Codex package's
// `...codexDoorMembers(CODEX_SCREEN_PRIMITIVES)` spread dropped. Red under
// each (shown on b3a0d2f4), green on the code.
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
}))

const { ClaudeProvider } = await import('../../../src/main/providers/claude')
const { CodexProvider } = await import('../../../src/main/providers/codex')

/** The door members a run screen offers, as functions, in a fixed order. */
const DOORS = ['retry', 'prompt', 'marker', 'image', 'ask'] as const
function doorsOf(screen: unknown): string[] {
  const s = (screen ?? {}) as Record<string, unknown>
  return DOORS.filter((door) => typeof s[door] === 'function')
}

describe('the real packages offer the doors\' members', () => {
  it('Claude Code: retry, prompt, marker and image; no ask and no submit', () => {
    const screen = new ClaudeProvider().runScreen
    expect(screen).toBeDefined()
    expect(doorsOf(screen)).toEqual(['retry', 'prompt', 'marker', 'image'])
    expect(screen?.ask).toBeUndefined()
    expect(screen?.submit).toBeUndefined()
  })

  it('Codex: retry, prompt, marker, image and ask', () => {
    const screen = new CodexProvider().runScreen
    expect(screen).toBeDefined()
    expect(doorsOf(screen)).toEqual(['retry', 'prompt', 'marker', 'image', 'ask'])
  })
})
