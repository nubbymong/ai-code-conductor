// fake-mode.js: the performance harness's switch for the fake Claude CLI
// (scripts/perf/gen-sessions.cjs writes `mode`, idle or busy, into the
// fake-stage.json beside fake-claude.js; seed.js copies this file there too).
// fake-claude.js requires it only when that file holds a mode, so the README
// pipeline never loads it.
'use strict'

const fs = require('fs')

/**
 * A reader of the mode in `file`: each call returns 'idle' or 'busy'. It
 * reads the file again only when its modification time or size changed, and
 * keeps the mode it last read when the file cannot be read or parsed (a write
 * caught half way), trying again on the next call. `initial` is the mode the
 * CLI started with. fsx (for the unit suite) stands in for fs.
 */
function modeReader(file, initial = 'busy', fsx = fs) {
  let mode = initial === 'idle' ? 'idle' : 'busy'
  let stamp = null
  return () => {
    let st
    try { st = fsx.statSync(file) } catch { return mode }
    const now = `${st.mtimeMs}:${st.size}`
    if (now === stamp) return mode
    try {
      const m = JSON.parse(fsx.readFileSync(file, 'utf8')).mode
      if (m === 'idle' || m === 'busy') mode = m
      stamp = now
    } catch { /* half written: keep the last mode, read again next time */ }
    return mode
  }
}

module.exports = { modeReader }
