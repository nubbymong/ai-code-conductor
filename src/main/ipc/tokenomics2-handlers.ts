/**
 * tokenomics2-handlers.ts — Tokenomics v2 read-surface IPC.
 *
 * Every channel is Zod-validated HERE (invalid args reject BEFORE the supervisor
 * is touched) then routed through getTokenomicsSupervisor().query(kind, args) —
 * the forked tokenomics worker. This file NEVER imports the DB or worker directly;
 * it only reaches the worker through the supervisor's promise-based query()
 * (15 s timeout, can't hang).
 *
 * The kinds map onto the worker's handleQuery() switch (tokenomics-worker.ts):
 *   summary, sessions, session-detail, index-status, accounts (usage track MP9).
 *
 * TOKENOMICS2_INDEX_PROGRESS / TOKENOMICS2_INDEX_COMPLETE are PUSHes: at
 * registration we subscribe to the supervisor's progress/complete fan-outs and
 * forward each event to the renderer's webContents so the tokenomics page can
 * live-update without polling.
 *
 * Tokenomics is an optional service (2.1.3-beta.4). Switched off in Settings
 * there is no supervisor, and every handler here answers that plainly instead
 * of failing: no figures, an empty list, a status that says `off`. The pushes
 * are attached to each supervisor as it starts, so one started later (the
 * switch turned on while the app runs) is forwarded like the first. The
 * accounts Settings leaves out are added to every query here, never taken
 * from the page.
 *
 * No default export (project convention).
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { getTokenomicsSupervisor, isTokenomicsOff, onTokenomicsStart, tokenomicsExcludedAccounts } from '../tokenomics/tokenomics-service'
import { tkAccountKeyOk } from '../tokenomics/tk-types'
import { providerIdSchema } from './provider-id-schema'

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const filterSchema = z.object({
  configId: z.string().min(1).max(200).nullable().optional(),   // undefined=all, null=External
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  model: z.string().min(1).max(200).optional(),
  // Usage track MP9: one provider's, or one account's, usage. An account key
  // is '' (not recorded) or `<provider>:<id>`, nothing else. The provider is
  // one of the app's provider ids (provider-id-schema.ts: Claude Code and
  // Codex today).
  provider: providerIdSchema.optional(),
  accountKey: z.string().max(140).refine((k) => tkAccountKeyOk(k)).optional(),
}).strict()

const sessionsSchema = filterSchema.extend({
  search: z.string().max(200).optional(),
  cursor: z.object({ lastTs: z.number().int(), sessionId: z.string() }).strict().nullable().optional(),
  limit: z.number().int().positive().max(200).optional(),
}).strict()

const detailSchema = z.object({ sessionId: z.string().min(1).max(200) }).strict()

/** MP9: the accounts query takes nothing, or (2.1.3-beta.4) `includeExcluded`
 *  for the list Settings offers to leave out: the accounts already left out
 *  have to be on it to be put back. */
const accountsSchema = z.object({ includeExcluded: z.boolean().optional() }).strict()

// ---------------------------------------------------------------------------
// Fallback when supervisor is not yet running
// ---------------------------------------------------------------------------

const DEFAULT_STATUS = {
  firstIndexComplete: false,
  indexing: false,
  filesDone: 0,
  filesTotal: 0,
  eventsTotal: 0,
  lastIndexAt: null,
}

// ---------------------------------------------------------------------------
// Supervisor query helper
// ---------------------------------------------------------------------------

/** Route through the supervisor only. Rejects fast when it is absent so the
 *  renderer never hangs. The accounts Settings leaves out ride with the
 *  query (2.1.3-beta.4); `includeExcluded` asks for them too. */
async function q(kind: string, args: Record<string, unknown>, includeExcluded = false): Promise<unknown[]> {
  const sup = getTokenomicsSupervisor()
  if (!sup) throw new Error('tokenomics service not running')
  const excluded = includeExcluded ? [] : tokenomicsExcludedAccounts()
  return sup.query(kind, excluded.length > 0 ? { ...args, excludeAccountKeys: excluded } : args)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTokenomics2Handlers(getWindow: () => BrowserWindow | null): void {
  // Each handler checks its arguments first, then answers "off" when
  // Tokenomics is switched off (2.1.3-beta.4): nothing is asked of a worker
  // that does not exist, and nothing fails.
  ipcMain.handle(IPC.TOKENOMICS2_SUMMARY, async (_e, a: unknown) => {
    const filter = filterSchema.parse(a ?? {})
    if (isTokenomicsOff()) return null
    return (await q('summary', filter))[0] ?? null
  })

  ipcMain.handle(IPC.TOKENOMICS2_SESSIONS, async (_e, a: unknown) => {
    const query = sessionsSchema.parse(a ?? {})
    if (isTokenomicsOff()) return { rows: [], nextCursor: null }
    return (await q('sessions', query))[0] ?? { rows: [], nextCursor: null }
  })

  ipcMain.handle(IPC.TOKENOMICS2_SESSION_DETAIL, async (_e, a: unknown) => {
    const detail = detailSchema.parse(a)
    if (isTokenomicsOff()) return null
    return (await q('session-detail', detail))[0] ?? null
  })

  // Usage track MP9: every provider and account the stored usage has.
  ipcMain.handle(IPC.TOKENOMICS2_ACCOUNTS, async (_e, a: unknown) => {
    const { includeExcluded } = accountsSchema.parse(a ?? {})
    if (isTokenomicsOff()) return []
    return (await q('accounts', {}, includeExcluded === true))[0] ?? []
  })

  // 2.1.3-beta.4: the page's Rescan. Every transcript is read again from its
  // first byte; what is stored stays. Takes nothing.
  ipcMain.handle(IPC.TOKENOMICS2_RESCAN, async () => {
    if (isTokenomicsOff()) return { ok: false, reason: 'off' }
    const sup = getTokenomicsSupervisor()
    // No supervisor, or one whose worker will not come back this run: said
    // plainly, so the page does not wait for a re-read that cannot start.
    if (!sup || !sup.rescan()) return { ok: false, reason: 'not-running' }
    return { ok: true }
  })

  ipcMain.handle(IPC.TOKENOMICS2_INDEX_STATUS, async () => {
    if (isTokenomicsOff()) return { ...DEFAULT_STATUS, off: true }
    const sup = getTokenomicsSupervisor()
    if (!sup) return DEFAULT_STATUS
    try {
      const rows = await sup.query('index-status', {})
      return rows[0] ?? { ...DEFAULT_STATUS, indexing: true }
    } catch {
      // Worker query rejected. Prefer the supervisor's own status: it carries a
      // fatal `error` (and indexing:false) when the worker hit an uncorrelated
      // fault like a failed DB open, so the page leaves its spinner. If there's
      // no fatal error, the worker is just not ready yet -> still indexing.
      return sup.getIndexStatus()
    }
  })

  // PUSH: forward the supervisor's index progress/complete events to the renderer
  // so the tokenomics page can live-update. Guarded against a destroyed window
  // (mirrors the emitToWindow pattern in index.ts). Attached to the supervisor
  // running now and to each one started later (2.1.3-beta.4): with Tokenomics
  // switched off there is none yet, and switching it on starts one.
  const send = (channel: string, payload: unknown): void => {
    const w = getWindow()
    if (w && !w.isDestroyed()) {
      try { w.webContents.send(channel, payload) } catch { /* window gone */ }
    }
  }
  onTokenomicsStart((sup) => {
    sup.onIndexProgress((p) => send(IPC.TOKENOMICS2_INDEX_PROGRESS, p))
    sup.onIndexComplete((c) => send(IPC.TOKENOMICS2_INDEX_COMPLETE, c))
    // PUSH a refreshed status on an uncorrelated worker fault (e.g. failed DB open)
    // so the renderer can stop showing 'indexing' the moment the fault occurs
    // rather than only on its next manual status fetch. Reuses the existing
    // INDEX_STATUS channel (request/reply + push share one shape).
    sup.onIndexError((s) => send(IPC.TOKENOMICS2_INDEX_STATUS, s))
    // The same push each time a worker comes up (2.1.3-beta.4), with what
    // the index already holds: a page open while Tokenomics is switched on
    // shows what was recorded before, without waiting for a whole pass.
    sup.onIndexReady((s) => send(IPC.TOKENOMICS2_INDEX_STATUS, s))
  })
}
