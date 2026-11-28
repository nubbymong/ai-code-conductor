// The path route's test switch (ADR-032; plan 2.1.3-beta.21 phase 2, Q5).
// The 2.1.3-beta.20 route that typed or pasted a picture's file path stays
// for this beta only, so the C2 proof can run it beside the clipboard route
// in one job. It is reachable only when the app is not packaged (every e2e
// run starts out/main/index.js, tests/e2e/helpers/electron-app.ts) and
// CCC_E2E_PATH_ROUTE=1 is set. The installed beta ignores the variable. Its
// one reader is this function: the paste module, Snap's hand-off and
// pty:submitPrompt's image branch all ask it. Deleted in 2.1.3-beta.22.
import { app } from 'electron'

/** Whether the path route is on: never in a packaged app. */
export function pathRouteOn(isPackaged?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  let packaged: boolean
  try {
    packaged = isPackaged ?? app.isPackaged
  } catch {
    // No app to ask: read as packaged, so the route stays off.
    packaged = true
  }
  return packaged === false && env.CCC_E2E_PATH_ROUTE === '1'
}
