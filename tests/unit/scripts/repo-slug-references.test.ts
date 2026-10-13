// The repository is nubbymong/ai-code-conductor since 2026-10-12. Old links
// redirect, but a write call to the old name (gh api with a file body, as the
// advisory filing script makes) does not follow the redirect, and a clone or
// a badge under the old name reads as stale. These files name the repository
// for a person or a script to use, so each must name it by its new name.
// What stays on the old name on purpose (the updater's default repository in
// this release, test fixtures that parse a slug, dated CONTEXT.d fragments)
// is not read here.
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../../..')
// Line endings settled, so a checkout with CRLF reads the same as one with LF.
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n')
const OLD = 'nubbymong/claude-command-center'
const NEW = 'nubbymong/ai-code-conductor'

describe('the repository is named by its new name wherever a person or a script uses it', () => {
  it('the scripts that call or print the repository name it by its new name', () => {
    expect(read('scripts/file-advisory.mjs')).toContain(`const REPO = '${NEW}'`)
    expect(read('scripts/file-advisory.mjs')).toContain("name: 'ai-code-conductor'")
    expect(read('scripts/gen-changelog.js')).toContain(`const REPO_URL = 'https://github.com/${NEW}'`)
    for (const rel of ['scripts/file-advisory.mjs', 'scripts/gen-changelog.js', 'scripts/release.js', 'scripts/promote.js']) {
      expect(read(rel), rel).not.toContain(OLD)
    }
    expect(read('scripts/release.js')).toContain(`https://github.com/${NEW}/actions/runs/`)
    expect(read('scripts/promote.js')).toContain(`repos/${NEW}/pulls/`)
  })

  it('the generated CHANGELOG.md links every release tag under the new name', () => {
    const md = read('CHANGELOG.md')
    expect(md).not.toContain(OLD)
    expect(md).toContain(`https://github.com/${NEW}/releases/tag/`)
  })

  it('the README, contributing guide, privacy policy, issue template and LoopReady skill use the new name', () => {
    for (const rel of ['README.md', 'CONTRIBUTING.md', 'PRIVACY.md', '.github/ISSUE_TEMPLATE/config.yml', '.claude/skills/LoopReady/SKILL.md']) {
      expect(read(rel), rel).not.toContain(OLD)
    }
    for (const rel of ['README.md', 'CONTRIBUTING.md']) {
      expect(read(rel), rel).toContain(`git clone https://github.com/${NEW}.git\ncd ai-code-conductor\n`)
    }
    expect(read('README.md')).toContain(`img.shields.io/github/v/release/${NEW}?`)
  })

  it('the embargo runbook names new advisory forks by the new name, and says older forks keep the old one', () => {
    // Whitespace settled, so a reflow of the paragraph does not fail the pin.
    const doc = read('docs/security-embargo-runbook.md')
    const prose = doc.replace(/\s+/g, ' ')
    expect(doc).toContain(`FORK=https://github.com/${NEW}-ghsa-xxxx-xxxx-xxxx.git`)
    expect(doc).toContain(`gh pr create --repo ${NEW}-ghsa-xxxx-xxxx-xxxx`)
    expect(prose).toContain('the fork of an advisory opened before the rename keeps its `claude-command-center-ghsa-xxxx-xxxx-xxxx` name.')
  })

  it('the dev launcher cleans up a dev build run from a clone folder of either name', () => {
    expect(read('scripts/ccc.cmd')).toContain("$_.ExecutablePath -match 'claude-command-center|ai-code-conductor'")
  })
})
