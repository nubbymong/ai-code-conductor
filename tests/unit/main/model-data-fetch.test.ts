/**
 * Model definitions as data (2.1.3-beta.1): the one read of the model file
 * at start-up. https only, the one host, no redirect to another host, at
 * most 256 KB, an answer within 5 s, and never a throw.
 *
 * The fetch is a stand-in in every case: no request leaves this suite.
 */
import { describe, it, expect } from 'vitest'
import { MODEL_DATA_FORMAT } from '../../../src/main/model-registry-data'
import { fetchModelDataText, MODEL_DATA_URL, MODEL_DATA_MAX_BYTES, MODEL_DATA_TIMEOUT_MS, type ModelDataFetch } from '../../../src/main/model-registry-remote'

type Init = Parameters<ModelDataFetch>[1]
const calls: Array<{ url: string; init: Init }> = []
/** A stand-in fetch that answers each address from `answers`, in turn. */
function stub(...answers: Array<Response | ((url: string, init: Init) => Promise<Response> | Response)>): ModelDataFetch {
  calls.length = 0
  let n = 0
  return async (url, init) => {
    calls.push({ url, init })
    const a = answers[Math.min(n++, answers.length - 1)]
    return typeof a === 'function' ? a(url, init) : a
  }
}
const ok = (body: string | Uint8Array, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers })
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })

describe('the address', () => {
  it('is the model-data branch of the app\'s own repository, over https', () => {
    // The format is in the file's name (review finding): a later format is
    // published beside this one, so a version that reads format 1 keeps
    // getting new models from the format 1 file for as long as it is kept.
    expect(MODEL_DATA_FORMAT).toBe(1)
    expect(MODEL_DATA_URL).toBe('https://raw.githubusercontent.com/nubbymong/ai-code-conductor/model-data/model-registry.v1.json')
    expect(MODEL_DATA_MAX_BYTES).toBe(256 * 1024)
    expect(MODEL_DATA_TIMEOUT_MS).toBe(5000)
  })
})

describe('the read', () => {
  it('a 200 gives the text; the request follows no redirect by itself and sends no credentials', async () => {
    const r = await fetchModelDataText(stub(ok('{"formatVersion":1}')))
    expect(r).toEqual({ ok: true, text: '{"formatVersion":1}' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(MODEL_DATA_URL)
    expect(calls[0].init.redirect).toBe('manual')
    expect(calls[0].init.credentials).toBe('omit')
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('an address that is not https is never asked for', async () => {
    const r = await fetchModelDataText(stub(ok('{}')), { url: 'http://raw.githubusercontent.com/x.json' })
    expect(r).toEqual({ ok: false, reason: 'the address is not https' })
    expect(calls).toHaveLength(0)
  })

  it('a redirect to another host is refused, and that host is never asked', async () => {
    const r = await fetchModelDataText(stub(redirect('https://example.com/model-registry.json'), ok('{}')))
    expect(r).toEqual({ ok: false, reason: 'redirected to another host' })
    expect(calls).toHaveLength(1)
  })

  it('a redirect to the same host by another name, port or scheme is refused too', async () => {
    for (const to of ['https://raw.githubusercontent.com.example.com/x', 'https://raw.githubusercontent.com:8443/x', 'http://raw.githubusercontent.com/x', 'https://user@example.com/x', '//example.com/x']) {
      const r = await fetchModelDataText(stub(redirect(to), ok('{}')))
      expect(r.ok, to).toBe(false)
      expect(calls, to).toHaveLength(1)
    }
  })

  it('a redirect within the same host is followed, a few times at most', async () => {
    const r = await fetchModelDataText(stub(redirect('/nubbymong/ai-code-conductor/refs/heads/model-data/model-registry.v1.json', 301), ok('{"a":1}')))
    expect(r).toEqual({ ok: true, text: '{"a":1}' })
    expect(calls.map((c) => c.url)).toEqual([MODEL_DATA_URL, 'https://raw.githubusercontent.com/nubbymong/ai-code-conductor/refs/heads/model-data/model-registry.v1.json'])
    const loop = await fetchModelDataText(stub(() => redirect('/nubbymong/ai-code-conductor/again')))
    expect(loop).toEqual({ ok: false, reason: 'too many redirects' })
    expect(calls).toHaveLength(4)
  })

  // Review finding: the host serves every repository's files, so a redirect
  // checked by host alone could lead to a file in any of them.
  it('a redirect within the same host but out of the app\'s own repository is refused, and never asked for', async () => {
    for (const to of [
      '/other/path',
      '/someone-else/ai-code-conductor/model-data/model-registry.v1.json',
      '/nubbymong/another-repo/model-data/model-registry.v1.json',
      '/nubbymong/ai-code-conductor-fork/model-data/model-registry.v1.json',
      '/nubbymong/ai-code-conductor/../another-repo/x.json',
      '/nubbymong/ai-code-conductor/%2e%2e/another-repo/x.json',
      '/NUBBYMONG/ai-code-conductor/model-data/model-registry.v1.json',
      '/nubbymong/ai-code-conductor',
      '/',
    ]) {
      const r = await fetchModelDataText(stub(redirect(to), ok('{}')))
      expect(r, to).toEqual({ ok: false, reason: 'redirected out of the app\'s repository' })
      expect(calls, to).toHaveLength(1)
    }
  })

  it('a redirect with nowhere to go is refused', async () => {
    expect(await fetchModelDataText(stub(new Response(null, { status: 302 })))).toEqual({ ok: false, reason: 'a redirect with no address' })
  })

  it('any other status is refused, with its number', async () => {
    expect(await fetchModelDataText(stub(new Response('not found', { status: 404 })))).toEqual({ ok: false, reason: 'HTTP 404' })
    expect(await fetchModelDataText(stub(new Response('busy', { status: 503 })))).toEqual({ ok: false, reason: 'HTTP 503' })
    expect(await fetchModelDataText(stub(new Response(null, { status: 204 })))).toEqual({ ok: false, reason: 'HTTP 204' })
  })

  it('a file said to be larger than 256 KB is refused before it is read', async () => {
    let read = false
    // Nothing is queued ahead of a read, so `read` is true only if the body was asked for.
    const body = new ReadableStream<Uint8Array>({ pull(c) { read = true; c.enqueue(new Uint8Array(10)); c.close() } }, { highWaterMark: 0 })
    const r = await fetchModelDataText(stub(new Response(body, { status: 200, headers: { 'content-length': String(MODEL_DATA_MAX_BYTES + 1) } })))
    expect(r).toEqual({ ok: false, reason: 'larger than 256 KB' })
    expect(read).toBe(false)
  })

  it('a file that turns out larger than 256 KB is refused, whatever it said, and the rest is not read', async () => {
    let sent = 0
    const chunk = new Uint8Array(64 * 1024).fill(0x20)
    const body = new ReadableStream<Uint8Array>({ pull(c) { sent++; c.enqueue(chunk) } }, { highWaterMark: 0 })
    const r = await fetchModelDataText(stub(new Response(body, { status: 200, headers: { 'content-length': '10' } })))
    expect(r).toEqual({ ok: false, reason: 'larger than 256 KB' })
    expect(sent).toBeLessThanOrEqual(6)
  })

  it('exactly 256 KB is read', async () => {
    const r = await fetchModelDataText(stub(ok(new Uint8Array(MODEL_DATA_MAX_BYTES).fill(0x20))))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toHaveLength(MODEL_DATA_MAX_BYTES)
  })

  it('bytes that are not UTF-8 text are refused', async () => {
    expect(await fetchModelDataText(stub(ok(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))))).toEqual({ ok: false, reason: 'not UTF-8 text' })
  })

  it('no answer in time is refused, and the request is told to stop', async () => {
    let stopped = false
    const never: ModelDataFetch = (_url, init) => new Promise<Response>(() => { init.signal.addEventListener('abort', () => { stopped = true }) })
    const started = Date.now()
    const r = await fetchModelDataText(never, { timeoutMs: 40 })
    expect(r).toEqual({ ok: false, reason: 'no answer within 0.04 s' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(stopped).toBe(true)
  })

  it('a body that stalls is cut off by the same time limit', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0x7b])) } })
    const r = await fetchModelDataText(stub(new Response(body, { status: 200 })), { timeoutMs: 40 })
    expect(r).toEqual({ ok: false, reason: 'no answer within 0.04 s' })
  })

  it('a fetch that throws is a reason, never a throw; the reason carries no text from the error', async () => {
    const offline: ModelDataFetch = async () => { throw Object.assign(new TypeError('fetch failed: secret-proxy-password'), { cause: { code: 'ENOTFOUND' } }) }
    expect(await fetchModelDataText(offline)).toEqual({ ok: false, reason: 'could not be reached (ENOTFOUND)' })
    const odd: ModelDataFetch = async () => { throw new Error('boom\nsecond line') }
    expect(await fetchModelDataText(odd)).toEqual({ ok: false, reason: 'could not be reached' })
    const sync: ModelDataFetch = () => { throw new Error('thrown at once') }
    expect(await fetchModelDataText(sync)).toEqual({ ok: false, reason: 'could not be reached' })
  })
})
