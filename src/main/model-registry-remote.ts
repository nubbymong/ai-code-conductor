// Model definitions as data (2.1.3-beta.1): the one read of the model file,
// made once at start-up, in the background.
//
// The file lives on its own branch of the app's repository, so a new model
// needs an edit there and no release. The read is deliberately narrow:
// https only, the one host and, on it, the app's own repository (a redirect
// is followed only within that, a few times at most, each hop checked here
// and never by the transport), at most 256 KB whatever the reply says about
// its length, an answer within 5 s, no credentials, and never a throw. What
// comes back is only text: it is used only after model-registry-data.ts has
// checked it.
import { MODEL_DATA_FORMAT } from './model-registry-data'

/** The app's own repository on the host. The host serves every repository's
 *  files, so a redirect must stay under this path, not only on the host. */
export const MODEL_DATA_REPO_PATH = '/nubbymong/ai-code-conductor/'

/** Where the model file is read from: the `model-data` branch, which holds
 *  only model files. To add a model, edit model-registry.v1.json on that
 *  branch. The format is in the name: a later format is published as its own
 *  file beside this one, so a version that reads this format is never locked
 *  out of new models by a change it cannot read. */
export const MODEL_DATA_URL = `https://raw.githubusercontent.com${MODEL_DATA_REPO_PATH}model-data/model-registry.v${MODEL_DATA_FORMAT}.json`
export const MODEL_DATA_TIMEOUT_MS = 5000
export const MODEL_DATA_MAX_BYTES = 256 * 1024
const MAX_REDIRECTS = 3

/** The part of `fetch` the read uses (the test's stand-in implements it). */
export type ModelDataFetch = (
  url: string,
  init: { redirect: 'manual'; credentials: 'omit'; cache: 'no-store'; signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>

export type ModelDataRead = { ok: true; text: string } | { ok: false; reason: string }

const fail = (reason: string): ModelDataRead => ({ ok: false, reason })

/** Why a fetch threw, as a word from a fixed alphabet: an error code when it
 *  has one, never the error's own text (it can name a proxy or a path). */
function unreachable(err: unknown): ModelDataRead {
  const cause = (err as { cause?: { code?: unknown }; code?: unknown } | null)
  const code = [cause?.cause?.code, cause?.code].find((c) => typeof c === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(c))
  return fail(code ? `could not be reached (${code as string})` : 'could not be reached')
}

/** The body as text, read no further than the cap. */
async function readCapped(res: Response): Promise<ModelDataRead> {
  const said = Number(res.headers.get('content-length'))
  if (Number.isFinite(said) && said > MODEL_DATA_MAX_BYTES) {
    try { await res.body?.cancel() } catch { /* nothing to stop */ }
    return fail('larger than 256 KB')
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body?.getReader()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MODEL_DATA_MAX_BYTES) {
        try { await reader.cancel() } catch { /* nothing to stop */ }
        return fail('larger than 256 KB')
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return fail('not UTF-8 text')
  }
}

async function read(fetchImpl: ModelDataFetch, start: URL, signal: AbortSignal): Promise<ModelDataRead> {
  let url = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(url.href, {
      redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
      headers: { accept: 'application/json', 'user-agent': 'ai-code-conductor' },
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      try { await res.body?.cancel() } catch { /* nothing to stop */ }
      if (!location) return fail('a redirect with no address')
      let next: URL
      try { next = new URL(location, url) } catch { return fail('a redirect with no address') }
      // The same origin exactly: scheme, host and port, and no sign-in part.
      if (next.origin !== start.origin || next.username || next.password) return fail('redirected to another host')
      // And inside the app's own repository. `next.pathname` is the path as
      // it will be asked for: any `..` in it is already resolved.
      if (!next.pathname.startsWith(MODEL_DATA_REPO_PATH)) return fail('redirected out of the app\'s repository')
      url = next
      continue
    }
    if (res.status !== 200) {
      try { await res.body?.cancel() } catch { /* nothing to stop */ }
      return fail(`HTTP ${res.status}`)
    }
    return readCapped(res)
  }
  return fail('too many redirects')
}

/**
 * The model file's text, or why it could not be read. Never throws, and
 * settles within the time limit even when the transport ignores the stop
 * signal. `fetchImpl` defaults to the main process's own fetch.
 */
export async function fetchModelDataText(
  fetchImpl: ModelDataFetch = (url, init) => fetch(url, init),
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<ModelDataRead> {
  const timeoutMs = opts.timeoutMs ?? MODEL_DATA_TIMEOUT_MS
  let start: URL
  try { start = new URL(opts.url ?? MODEL_DATA_URL) } catch { return fail('the address is not https') }
  if (start.protocol !== 'https:') return fail('the address is not https')
  const stop = new AbortController()
  const late = fail(`no answer within ${timeoutMs / 1000} s`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ModelDataRead>((resolve) => {
    timer = setTimeout(() => { stop.abort(); resolve(late) }, timeoutMs)
  })
  try {
    return await Promise.race([
      // A stop asked for by the time limit is the time limit's answer.
      (async () => read(fetchImpl, start, stop.signal))().catch((err) => (stop.signal.aborted ? late : unreachable(err))),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}
