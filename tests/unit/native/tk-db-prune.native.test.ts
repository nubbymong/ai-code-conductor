import { describe, it, expect } from 'vitest'
import { openTkDb } from '../../../src/main/tokenomics/tk-db'
import type { TkEvent } from '../../../src/main/tokenomics/tk-types'

// 2.1.3-beta.5 (aicc_planning#306, item 2): the two methods the worker drops
// the progress rows of gone transcripts with. Only progress rows go; a stored
// usage event is never touched.

function ev(p: Partial<TkEvent> & { configId?: string | null }): any {
  return {
    dedupKey: 'c:m:r', sessionId: 's1', provider: 'claude', model: 'claude-opus-4-8', priceModel: 'claude-opus-4-8',
    ts: Date.parse('2026-06-01T10:00:00Z'), cwd: 'F:/proj', inTok: 10, outTok: 20, cacheReadTok: 5, cacheCreateTok: 3, configId: 'a', ...p,
  }
}
const cursor = (p: string) => ({ path: p, size: 10, mtime: 1, lastOffset: 10, lastIngestedAt: 1, scannedTo: 10 })

describe('tk-db file progress rows: listing and deleting', () => {
  it('lists every path with a row, and deletes only the paths it is given', () => {
    const db = openTkDb(':memory:')
    for (const p of ['/p/a.jsonl', '/p/b.jsonl', '/p/c.jsonl']) db.setFileCursor(cursor(p))
    expect(db.listFilePaths().sort()).toEqual(['/p/a.jsonl', '/p/b.jsonl', '/p/c.jsonl'])
    expect(db.deleteFileRows(['/p/a.jsonl', '/p/c.jsonl'])).toBe(2)
    expect(db.listFilePaths()).toEqual(['/p/b.jsonl'])
    expect(db.getFileCursor('/p/a.jsonl')).toBeNull()
    expect(db.getFileCursor('/p/b.jsonl')).not.toBeNull()
  })

  it('a path with no row is not counted, and an empty list deletes nothing', () => {
    const db = openTkDb(':memory:')
    db.setFileCursor(cursor('/p/a.jsonl'))
    expect(db.deleteFileRows(['/p/none.jsonl'])).toBe(0)
    expect(db.deleteFileRows([])).toBe(0)
    expect(db.listFilePaths()).toEqual(['/p/a.jsonl'])
  })

  it('never touches a stored usage event or the rollups', () => {
    const db = openTkDb(':memory:')
    db.upsertConfigs([{ configId: 'a', label: 'App', workingDirectory: 'F:/proj' }])
    db.insertEventsWithCursor([ev({ dedupKey: 'c:1:1' }), ev({ dedupKey: 'c:2:2' })], cursor('/p/a.jsonl') as any)
    const before = {
      events: db.eventCount(),
      daily: db.raw.prepare('SELECT SUM(inTok) AS n FROM tk_daily').get(),
      sessions: db.raw.prepare('SELECT COUNT(*) AS n FROM tk_sessions').get(),
    }
    expect(db.deleteFileRows(['/p/a.jsonl'])).toBe(1)
    expect(db.listFilePaths()).toEqual([])
    expect(db.eventCount()).toBe(before.events)
    expect(db.raw.prepare('SELECT SUM(inTok) AS n FROM tk_daily').get()).toEqual(before.daily)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM tk_sessions').get()).toEqual(before.sessions)
  })
})
