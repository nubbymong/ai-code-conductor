import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'

/**
 * CI and the release build test the app on the Node the app ships
 * (aicc_planning#418, plan 2.1.3-beta.18 section 7.2). Until then ci.yml set
 * Node 20 in ten jobs and release.yml in seven, while Electron 44.11.3 carries
 * Node 24.22.2: Node 20 and Node 24 delete an open file differently on
 * Windows, so a green run on Node 20 said little about the app's own runtime
 * (CI run 45341253799).
 *
 * Every actions/setup-node step in the two workflows is read here, and each
 * must ask for the Node major of the Electron major in package.json. A new
 * Electron major fails the pairing test until its Node is added to the table
 * and the workflows follow it. One step keeps another Node, named below with
 * its reason; an exception that is no longer true fails too.
 *
 * Not checked here: the other workflows (pr-title.yml, issue-disposition.yml,
 * close-in-beta-on-promotion.yml), which run the repository's own scripts and
 * no test of the app; and whether a job passes on that Node (CI shows it).
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')

type Step = { uses?: string; with?: Record<string, unknown> }
type Job = { steps?: Step[] }
type Workflow = { jobs: Record<string, Job> }

const WORKFLOWS = ['ci.yml', 'release.yml'] as const

/** The Node major each Electron major ships, from Electron's release notes. */
const NODE_OF_ELECTRON: Record<number, string> = { 44: '24' }

/** setup-node steps that keep another Node, by "<workflow> <job>", each with its reason. */
const OTHER_NODE: Record<string, { node: string; reason: string }> = {
  'ci.yml probe-p19': {
    node: '22',
    reason:
      "Probe P19 runs the published agent CLIs, not the app's code, and keeps the Node its own comment names: Claude Code's package asks for Node 22 or later.",
  },
}

/** The jobs that run the app's tests, the build or the installer: each must be among those read. */
const TEST_AND_BUILD_JOBS = [
  'ci.yml test',
  'ci.yml test-windows-part',
  'ci.yml test-windows-build',
  'ci.yml release-windows-installer',
  'release.yml build-windows',
  'release.yml build-macos',
  'release.yml build-linux',
]

type Found = { where: string; node: unknown }
const found: Found[] = WORKFLOWS.flatMap((file) => {
  const wf = yaml.load(read(`.github/workflows/${file}`)) as Workflow
  return Object.entries(wf.jobs).flatMap(([id, job]) =>
    (job.steps ?? [])
      .filter((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node@'))
      .map((s) => ({ where: `${file} ${id}`, node: s.with?.['node-version'] })),
  )
})

const electronMajor = (): number => {
  const pkg = JSON.parse(read('package.json')) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> }
  const v = pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? ''
  const m = /^\D*(\d+)\./.exec(v)
  expect(m, `package.json names no Electron version ("${v}")`).not.toBeNull()
  return Number((m as RegExpExecArray)[1])
}

describe('CI runs on the Node the app ships (aicc_planning#418)', () => {
  it('knows the Node of the Electron major in package.json', () => {
    const major = electronMajor()
    expect(
      NODE_OF_ELECTRON[major],
      `Electron ${major} is not in this test's table: add the Node major it ships, and set ci.yml's and release.yml's node-version lines to it`,
    ).toBeDefined()
  })

  it('reads a setup-node step in every job that runs the tests, the build or the installer', () => {
    const where = new Set(found.map((f) => f.where))
    expect(TEST_AND_BUILD_JOBS.filter((j) => !where.has(j))).toEqual([])
  })

  it("every setup-node step in ci.yml and release.yml asks for Electron's Node, except the one named with its reason", () => {
    const want = NODE_OF_ELECTRON[electronMajor()]
    const wrong = found
      .filter((f) => !(f.where in OTHER_NODE))
      .filter((f) => String(f.node) !== want)
      .map((f) => `${f.where}: node-version ${JSON.stringify(f.node)}, want '${want}'`)
    expect(wrong).toEqual([])
  })

  it('each exception is still a setup-node step and still asks for its own Node', () => {
    for (const [where, { node, reason }] of Object.entries(OTHER_NODE)) {
      expect(reason.length, `${where} has no reason`).toBeGreaterThan(0)
      const steps = found.filter((f) => f.where === where)
      expect(steps.length, `${where} has no setup-node step: remove it from OTHER_NODE`).toBe(1)
      expect(String(steps[0].node), `${where}: its Node changed; update OTHER_NODE or remove the exception`).toBe(node)
    }
  })
})
