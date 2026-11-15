/**
 * Release-note warnings in the generated notes.
 *
 * A changelog entry may carry `warnings`: plain sentences a user should read
 * before relying on that release (what changes for them, a known risk, how to
 * go back). The generator puts them FIRST in the release's block, under a
 * heading of their own, in CHANGELOG.md and in the GitHub release notes
 * (`--notes`).
 *
 * These cases run on SYNTHETIC entries on purpose. The real changelog carries
 * a warning only when a release adds one, so a test against the real file
 * would pass either way and prove nothing.
 *
 * The "without warnings" cases pin the output as it was before warnings
 * existed. CI's "Changelog in sync" check compares CHANGELOG.md byte for byte,
 * so a release with no warnings has to render exactly as it did.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const GENERATOR = '../../../scripts/gen-changelog.js'

interface Entry {
  version: string
  date: string
  highlights?: string
  warnings?: unknown
  changes: { type: string; description: string }[]
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderChangelog, renderNotes, sliceArrayLiteral, runCli, EXIT_BAD_WARNINGS } = require(GENERATOR) as {
  renderChangelog: (entries: Entry[]) => string
  renderNotes: (entries: Entry[], version: string) => string
  sliceArrayLiteral: (src: string, anchorText: string) => string
  runCli: (run: () => void) => number
  EXIT_BAD_WARNINGS: number
}

const PLAIN: Entry = {
  version: '9.9.8',
  date: '2026-01-02',
  highlights: 'A small release.',
  changes: [
    { type: 'fix', description: 'A fixed thing.' },
    { type: 'feature', description: 'A new thing.' },
  ],
}

const WARNED: Entry = {
  version: '9.9.9',
  date: '2026-01-03',
  highlights: 'A bigger release.',
  warnings: [
    'Sessions restart once after this update.',
    'To go back, install 9.9.8 again; your settings are kept.',
  ],
  changes: [{ type: 'improvement', description: 'A changed thing.' }],
}

const REPO = 'https://github.com/nubbymong/ai-code-conductor'

// The whole file for one release with no warnings, as the generator wrote it
// before warnings existed.
const PLAIN_FILE = [
  '# Changelog',
  '',
  'All notable changes to AI Code Conductor (formerly Claude Command Center) are documented here.',
  '',
  'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),',
  'and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).',
  '',
  '> **Generated file — do not edit by hand.** The source of truth is',
  '> `src/renderer/changelog.ts`. After editing that file, run `npm run changelog`',
  '> (CI enforces that this file is in sync via `npm run changelog:check`).',
  '',
  '## [9.9.8] - 2026-01-02',
  '',
  '> A small release.',
  '',
  '### Added',
  '- A new thing.',
  '',
  '### Fixed',
  '- A fixed thing.',
  '',
  `[9.9.8]: ${REPO}/releases/tag/v9.9.8`,
  '',
].join('\n')

/** One release's block of the file: from its `## [version]` line up to the
 *  next release, or up to the link list at the foot. */
function blockOf(file: string, version: string): string {
  const start = file.indexOf(`## [${version}]`)
  expect(start, `no block for ${version}`).toBeGreaterThanOrEqual(0)
  const nextRelease = file.indexOf('\n## [', start + 1)
  const links = file.indexOf(`\n[${version}]: `, start)
  const ends = [nextRelease, links].filter((i) => i > start)
  return file.slice(start, Math.min(...ends))
}

describe('CHANGELOG.md: a release with warnings', () => {
  it('puts the warnings first in the release block, under their own heading', () => {
    expect(blockOf(renderChangelog([WARNED, PLAIN]), '9.9.9')).toBe(
      [
        '## [9.9.9] - 2026-01-03',
        '',
        '### Warnings',
        '- Sessions restart once after this update.',
        '- To go back, install 9.9.8 again; your settings are kept.',
        '',
        '> A bigger release.',
        '',
        '### Changed',
        '- A changed thing.',
        '',
      ].join('\n'),
    )
  })

  it('marks only the release that carries them', () => {
    const file = renderChangelog([WARNED, PLAIN])
    expect(file.match(/^### Warnings$/gm) ?? []).toHaveLength(1)
    expect(blockOf(file, '9.9.8')).not.toContain('Warnings')
  })

  it('writes each warning as one list item, with line breaks and runs of spaces folded', () => {
    const file = renderChangelog([{ ...PLAIN, warnings: ['  The first\n  line.  ', 'The\tsecond.'] }])
    expect(blockOf(file, '9.9.8')).toContain('### Warnings\n- The first line.\n- The second.\n\n> A small release.')
  })

  it('comes first even when the release has no highlights line', () => {
    const { highlights: _dropped, ...bare } = WARNED
    expect(blockOf(renderChangelog([bare]), '9.9.9')).toBe(
      [
        '## [9.9.9] - 2026-01-03',
        '',
        '### Warnings',
        '- Sessions restart once after this update.',
        '- To go back, install 9.9.8 again; your settings are kept.',
        '',
        '### Changed',
        '- A changed thing.',
        '',
      ].join('\n'),
    )
  })
})

describe('CHANGELOG.md: a release without warnings renders exactly as before', () => {
  it('no warnings field', () => {
    expect(renderChangelog([PLAIN])).toBe(PLAIN_FILE)
  })

  it.each([
    ['an empty list', []],
    ['only blank strings', ['', '   ', '\n']],
  ])('%s', (_name, warnings) => {
    expect(renderChangelog([{ ...PLAIN, warnings }])).toBe(PLAIN_FILE)
  })
})

describe('a malformed warnings value is refused, not dropped', () => {
  // A warning that silently fails to print is worse than a failed build: the
  // generator names the release, and CI's changelog check fails with it.
  it.each([
    ['a bare string', 'Read this first.'],
    ['a list with something that is not a string', ['Read this first.', 7]],
    ['null', null],
  ])('%s', (_name, warnings) => {
    expect(() => renderChangelog([{ ...PLAIN, warnings }])).toThrow(/9\.9\.8.*warnings/)
    expect(() => renderNotes([{ ...PLAIN, warnings }], '9.9.8')).toThrow(/9\.9\.8.*warnings/)
  })
})

describe('a malformed warnings value ends the run with an exit code of its own', () => {
  // The release workflow lets the notes step fall back to a short release body
  // when the generator fails. That fallback must not swallow this one failure:
  // the release would go out with its warnings missing. So it has a code no
  // other failure uses, and the workflow stops on that code alone.
  afterEach(() => vi.restoreAllMocks())

  it('the run ends with that code, and says which release on stderr', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(runCli(() => { renderNotes([{ ...PLAIN, warnings: 'Read this first.' }], '9.9.8') })).toBe(EXIT_BAD_WARNINGS)
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toMatch(/9\.9\.8.*warnings/)
    error.mockClear()
    expect(runCli(() => { renderChangelog([{ ...PLAIN, warnings: ['Read this first.', 7] }]) })).toBe(EXIT_BAD_WARNINGS)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('is not 0, 1 or 2, the codes the generator already ends with', () => {
    expect([0, 1, 2]).not.toContain(EXIT_BAD_WARNINGS)
  })

  it('a run that works ends with 0 and prints no error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(runCli(() => { renderNotes([WARNED, PLAIN], '9.9.9') })).toBe(0)
    expect(error).not.toHaveBeenCalled()
  })

  it('every other failure surfaces as it always did', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => runCli(() => { sliceArrayLiteral('const other = 1', 'changelog: ChangelogEntry[] =') })).toThrow(/Could not find/)
    expect(() => runCli(() => { throw new TypeError('not this one') })).toThrow(TypeError)
    expect(error).not.toHaveBeenCalled()
  })
})

describe('the release workflow notes step', () => {
  it('stops on that exit code alone, so every other outcome falls back as before', () => {
    const workflow = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/release.yml'), 'utf-8')
    const calls = workflow.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes('gen-changelog.js --notes'))
    expect(calls).toEqual([`node scripts/gen-changelog.js --notes "$VERSION" > RELEASE_NOTES.md || [ "$?" -ne ${EXIT_BAD_WARNINGS} ]`])
  })
})

describe('GitHub release notes (--notes)', () => {
  it('puts the warnings first, ahead of the highlights line', () => {
    expect(renderNotes([WARNED, PLAIN], '9.9.9')).toBe(
      [
        '### Warnings',
        '- Sessions restart once after this update.',
        '- To go back, install 9.9.8 again; your settings are kept.',
        '',
        'A bigger release.',
        '',
        '### Changed',
        '- A changed thing.',
        '',
        `**Full changelog:** ${REPO}/blob/v9.9.9/CHANGELOG.md`,
        '',
      ].join('\n'),
    )
  })

  it('gives only the asked release its own warnings', () => {
    expect(renderNotes([WARNED, PLAIN], '9.9.8')).not.toContain('Warnings')
  })

  it('renders a release without warnings exactly as before', () => {
    const before = [
      'A small release.',
      '',
      '### Added',
      '- A new thing.',
      '',
      '### Fixed',
      '- A fixed thing.',
      '',
      `**Full changelog:** ${REPO}/blob/v9.9.8/CHANGELOG.md`,
      '',
    ].join('\n')
    expect(renderNotes([PLAIN], '9.9.8')).toBe(before)
    expect(renderNotes([{ ...PLAIN, warnings: [] }], '9.9.8')).toBe(before)
    expect(renderNotes([{ ...PLAIN, warnings: [' '] }], '9.9.8')).toBe(before)
  })

  it('is still empty for a version with no entry', () => {
    expect(renderNotes([WARNED, PLAIN], '1.0.0')).toBe('')
  })
})

describe('loading the generator for its pure functions', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not write CHANGELOG.md', () => {
    // The file used to run its command-line entry point on load, so every test
    // that imported it rewrote the real CHANGELOG.md as a side effect.
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const id = require.resolve(GENERATOR)
    delete require.cache[id]
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const again = require(GENERATOR) as { renderChangelog: unknown }
    expect(typeof again.renderChangelog).toBe('function')
    expect(write).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})
