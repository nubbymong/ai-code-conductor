// Performance harness: where it may run and what it may touch (scripts/perf, see README.md).
//
// The harness starts the installed app, clicks in its window and evaluates
// code in its main process, so it runs only on the Windows test VM, only when
// asked to there, and only against the app launch.js started on a README
// staging root. The decisions are pure functions (the unit suite runs them
// with stand-ins: tests/unit/scripts/perf-guard.test.ts); machineModel is the
// one that asks Windows.
'use strict'

const path = require('path')
const { execFileSync } = require('child_process')

/** The opt-in the harness needs on the VM: CCC_PERF_TEST_VM=1. */
const OPT_IN = 'CCC_PERF_TEST_VM'

/**
 * Why the harness may not run here, or null when it may: Windows, the opt-in
 * set to 1, and a Hyper-V guest (Win32_ComputerSystem reports the model
 * "Virtual Machine" by Microsoft). A desktop that sets the opt-in by mistake
 * is still refused by its model.
 */
function testVmRefusal({ platform, env, model, manufacturer }) {
  if (platform !== 'win32') return 'the harness runs only on the Windows test VM'
  if (!env || env[OPT_IN] !== '1') return `${OPT_IN}=1 is not set: the harness runs only on the Windows test VM, and only when asked to there`
  if (String(model || '').trim() !== 'Virtual Machine' || !/^Microsoft\b/i.test(String(manufacturer || '').trim())) {
    return `this machine (model "${model || '?'}", made by "${manufacturer || '?'}") is not a Hyper-V virtual machine: the harness runs only on the Windows test VM`
  }
  return null
}

/** This machine's model and manufacturer (Win32_ComputerSystem); empty when they cannot be read. */
function machineModel(exec = execFileSync) {
  try {
    const out = String(exec('powershell.exe', ['-NoProfile', '-Command', '$c = Get-CimInstance Win32_ComputerSystem; $c.Model + "|" + $c.Manufacturer'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })).trim()
    const i = out.lastIndexOf('|')
    return i < 0 ? {} : { model: out.slice(0, i), manufacturer: out.slice(i + 1) }
  } catch {
    return {}
  }
}

/**
 * Before attaching: the recorded app is still the process launch.js started
 * (pid, executable, start time) and holds its debug port (the stage's own
 * checkLaunchedApp), and it also holds each of `ports` (main's inspector).
 * S is scripts/readme-shots/stage/stage-root.js; deps as its checkLaunchedApp
 * takes them. Throws S.StageRefusal; returns the record.
 */
function checkStagedApp(S, rec, ports = [], deps = {}) {
  S.checkLaunchedApp(rec, deps)
  for (const p of ports) {
    if (p === rec.port) continue
    const owner = S.portOwnerPid(p, deps.platform || process.platform, deps.exec)
    if (owner !== rec.pid) {
      const by = owner === null ? 'nothing' : owner === undefined ? 'an unknown process (the port check failed)' : `pid ${owner}`
      throw new S.StageRefusal(`port ${p} is not held by the app launch.js started (pid ${rec.pid}; held by ${by})`)
    }
  }
  return rec
}

/**
 * The results folder: `given` when there is one (absolute, inside the staging
 * root, no link on its way down from the root, as the README staging's own
 * output folder), else <root>/perf-out/<stamp>. S as above. Throws
 * S.StageRefusal.
 */
function resultsDir(S, stage, given, stamp) {
  if (!given) return path.join(stage.ROOT, 'perf-out', stamp)
  if (!path.isAbsolute(given)) throw new S.StageRefusal(`--out must be an absolute path, not ${given}`)
  const p = path.resolve(given)
  if (!S.inside(p, stage.ROOT)) throw new S.StageRefusal(`--out (${p}) is not inside the staging root ${stage.ROOT}`)
  if (!S.noLinkBelow(stage.ROOT, p)) throw new S.StageRefusal(`--out (${p}) has a link on its path`)
  return p
}

module.exports = { OPT_IN, testVmRefusal, machineModel, checkStagedApp, resultsDir }
