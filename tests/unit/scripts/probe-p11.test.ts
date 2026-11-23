import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'module'
import { join, resolve } from 'path'
import { createHash } from 'crypto'

// imageTransfer.ts is read for today's typed form only; its writer is not run.
vi.mock('../../../src/renderer/components/terminal/tmuxWheelScroll', () => ({ writeSessionInput: vi.fn() }))
const { composeLocalPathPrompt } = await import('../../../src/renderer/utils/imageTransfer')

/**
 * The parts of probe P11 (helper/probes/p11-probe.cjs and its stand-in model,
 * p11-model-stand-in.cjs; ADR-030, plan 2.1.3-beta.16 section X1) that decide
 * something without a real program: how the stand-in finds an image in a
 * Claude Code or Codex request and names the picture, what each form types,
 * each run's outcome, each form's verdict over the runs (the decision lines in
 * the probe's header, each shown able to fail) and what the verdicts mean for
 * X1.2. The probe itself is a measurement, run on the Windows test machine,
 * not here.
 *
 * Not checked here: the CLIs themselves, the screens the probe answers on its
 * way to a prompt, the stand-in as a running server, and the process clean-up
 * (p19-record.cjs's code, tested in probe-p19-record.test.ts).
 */

const PROBES = resolve(__dirname, '../../../helper/probes')
const req = createRequire(join(PROBES, 'p11-probe.cjs'))
type Img = { way?: string; kind?: string; width?: number | null; height?: number | null; sha256?: string; bytes?: number; unreadable?: string }
type Look = { rows: string[]; placeholder: boolean; fileNameShown: boolean }
type Reading = {
  turn: { images: Img[]; pathInText?: boolean } | null
  looks?: Record<string, Look>
  bracketedPaste?: boolean | null
  enters?: number
  why?: string | null
}
type Form = { id: string; how: string; folder: string; verdict: boolean; quoted?: boolean; runs?: number }
const P = req('./p11-probe.cjs') as {
  FORMS: Form[]
  PICTURE: Buffer
  PICTURE_INFO: Required<Img>
  appPictureName: (d: Date) => string
  writesFor: (form: Form, picturePath: string, sentence: string) => Array<{ what: string; data: string; afterMs: number; look: string }>
  samePicture: (img: Img | null) => string | null
  outcomeOf: (r: Reading) => string
  formVerdict: (form: Form, readings: Reading[], runs: number) => { verdict: string; outcomes: string[]; summary: string }
  forX12: (claude: Record<string, { verdict: string }> | undefined) => string
  sanitizer: (pairs: Array<[string, string]>) => (v: unknown) => unknown
}
const S = req('./p11-model-stand-in.cjs') as {
  classify: (path: string, body: unknown) => { api: string; kind: string; run: string | null; images: Img[]; text: string | null } | null
  pictureInfo: (buf: Buffer) => Img
  urlPicture: (url: string) => Img
}

const form = (id: string): Form => P.FORMS.find((f) => f.id === id) as Form
const b64 = P.PICTURE.toString('base64')
const three = <T>(x: T): T[] => [x, x, x]
const attached: Reading = { turn: { images: [{ ...P.PICTURE_INFO }] } }
const notAttached: Reading = { turn: { images: [] } }
const noTurn: Reading = { turn: null, why: 'no turn reached the stand-in within 20 s of either Enter' }

describe('P11: the probe picture and how the stand-in names a picture', () => {
  it('the embedded picture is the 96 by 64 JPEG the header names, by its SHA-256', () => {
    expect(P.PICTURE_INFO).toMatchObject({ kind: 'jpeg', width: 96, height: 64, bytes: P.PICTURE.length })
    expect(createHash('sha256').update(P.PICTURE).digest('hex')).toBe('96cd0bda2e11e97a24180b9f967a3dbecb46f3bb8579c19e234497a44657bef6')
    expect(P.PICTURE_INFO.sha256).toBe('96cd0bda2e11e97a24180b9f967a3dbecb46f3bb8579c19e234497a44657bef6')
  })
  it('reads a PNG and a GIF header for the size, and names anything else unknown with no size', () => {
    const png = Buffer.alloc(33)
    png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(96, 16); png.writeUInt32BE(64, 20)
    expect(S.pictureInfo(png)).toMatchObject({ kind: 'png', width: 96, height: 64 })
    const gif = Buffer.from('GIF89a\u0060\u0000\u0040\u0000', 'latin1')
    expect(S.pictureInfo(gif)).toMatchObject({ kind: 'gif', width: 96, height: 64 })
    expect(S.pictureInfo(Buffer.from('not a picture'))).toMatchObject({ kind: 'unknown', width: null, height: null })
  })
  it('a data URL is decoded; a web address is named as one, never fetched', () => {
    expect(S.urlPicture(`data:image/jpeg;base64,${b64}`)).toMatchObject({ way: 'data url', mediaType: 'image/jpeg', sha256: P.PICTURE_INFO.sha256, width: 96 })
    expect(S.urlPicture('https://example.invalid/x.jpg')).toEqual({ way: 'url' })
  })
})

describe('P11: which request is the turn, and the images it carries', () => {
  const text = 'p11 probe claude-paste-2: please view the image.'
  const anthropic = (extra: Record<string, unknown>) => ({ stream: true, tools: [{ name: 'Read' }], ...extra })
  it('Claude Code: a streamed request with tools whose user text names a run is the turn, with its image blocks', () => {
    const c = S.classify('/v1/messages', anthropic({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text }] }] }))
    expect(c).toMatchObject({ api: 'anthropic', kind: 'turn', run: 'claude-paste-2' })
    expect(c!.images).toHaveLength(1)
    expect(P.samePicture(c!.images[0])).toBe('the same bytes')
  })
  it('Claude Code: no stream, no tools or no run named is not the turn; text alone carries no image', () => {
    expect(S.classify('/v1/messages', { stream: false, tools: [{}], messages: [{ role: 'user', content: text }] })!.kind).toBe('ok')
    expect(S.classify('/v1/messages', { stream: true, tools: [], messages: [{ role: 'user', content: text }] })!.kind).toBe('ok')
    expect(S.classify('/v1/messages', anthropic({ messages: [{ role: 'user', content: 'hello' }] }))!.kind).toBe('ok')
    expect(S.classify('/v1/messages', anthropic({ messages: [{ role: 'user', content: `${text} C:\\x\\shot.jpg` }] }))!.images).toEqual([])
  })
  it('Claude Code: an image inside a tool result counts; one given by URL is named by its way', () => {
    const c = S.classify('/v1/messages', anthropic({ messages: [{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'url', url: 'https://x.invalid' } }] }, { type: 'text', text }] }] }))
    expect(c!.images).toEqual([{ way: 'url' }])
  })
  it('Codex: a request with tools whose user item names a run is the turn, its input_image read from the data URL', () => {
    const c = S.classify('/v1/responses', { tools: [{ name: 'shell' }], input: [{ role: 'user', content: [{ type: 'input_text', text: '<environment_context/>' }] }, { role: 'user', content: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${b64}` }, { type: 'input_text', text: 'p11 probe codex-typed-1: please view the image.' }] }] })
    expect(c).toMatchObject({ api: 'responses', kind: 'turn', run: 'codex-typed-1' })
    expect(c!.images[0]).toMatchObject({ way: 'data url', sha256: P.PICTURE_INFO.sha256 })
    expect(S.classify('/v1/responses', { tools: [], input: [{ role: 'user', content: 'p11 probe codex-typed-1: x' }] })!.kind).toBe('ok')
  })
  it('an assistant message is not read for images or the run', () => {
    const c = S.classify('/v1/messages', anthropic({ messages: [{ role: 'assistant', content: [{ type: 'image', source: { type: 'base64', data: b64 } }, { type: 'text', text }] }] }))
    expect(c).toMatchObject({ kind: 'ok', run: null, images: [] })
  })
})

describe('P11: what each form types', () => {
  const path = 'C:\\T\\p11-x\\claude-paste-1\\localappdata\\AI Code Conductor\\resources\\screenshots\\screenshot-2026-11-23-221500.jpg'
  const sentence = 'p11 probe claude-paste-1: please view the image.'
  it('names the picture as Snap names one', () => {
    expect(P.appPictureName(new Date('2026-11-23T22:15:00.123Z'))).toBe('screenshot-2026-11-23-221500.jpg')
  })
  it('paste: the path in bracketed paste markers, then a space and the sentence, each its own write', () => {
    expect(P.writesFor(form('paste'), path, sentence).map((w) => w.data)).toEqual([`\u001b[200~${path}\u001b[201~`, ` ${sentence}`])
    expect(P.writesFor(form('paste-quoted'), path, sentence)[0].data).toBe(`\u001b[200~"${path}"\u001b[201~`)
  })
  it("typed: one write that is today's local prompt (imageTransfer.ts composeLocalPathPrompt), with no Enter in it", () => {
    const w = P.writesFor(form('typed'), path, sentence)
    expect(w).toHaveLength(1)
    expect(w[0].data).toBe(composeLocalPathPrompt(path, sentence))
    expect(w[0].data).not.toMatch(/[\r\n\u001b]/)
  })
  it('the verdict forms are paste and typed; the plain and quoted paths are recorded once each', () => {
    expect(P.FORMS.filter((f) => f.verdict).map((f) => f.id)).toEqual(['paste', 'typed'])
    expect(P.FORMS.filter((f) => !f.verdict).map((f) => [f.id, f.runs])).toEqual([['paste-plain', 1], ['paste-quoted', 1]])
  })
})

describe('P11: each run and each form (the decision lines)', () => {
  it('a run attaches when the turn carries the picture, by its bytes or, encoded again, by its size', () => {
    expect(P.outcomeOf(attached)).toBe('attached')
    expect(P.outcomeOf({ turn: { images: [{ kind: 'png', width: 96, height: 64, sha256: 'ff' }] } })).toBe('attached')
    expect(P.samePicture({ kind: 'png', width: 96, height: 64, sha256: 'ff' })).toBe('its size (png)')
  })
  it('a turn with no image is not; with only another picture is other image; no turn is no turn', () => {
    expect(P.outcomeOf(notAttached)).toBe('not')
    expect(P.outcomeOf({ turn: { images: [{ kind: 'jpeg', width: 1920, height: 1080, sha256: 'aa' }] } })).toBe('other image')
    expect(P.outcomeOf({ turn: { images: [{ way: 'url' }] } })).toBe('other image')
    expect(P.outcomeOf(noTurn)).toBe('no turn')
  })
  it('ATTACHES only in 3 of 3: one run without the picture makes it NO VERDICT', () => {
    expect(P.formVerdict(form('paste'), three(attached), 3).verdict).toBe('ATTACHES')
    expect(P.formVerdict(form('paste'), [attached, attached, notAttached], 3).verdict).toBe('NO VERDICT')
    expect(P.formVerdict(form('paste'), [attached, attached, noTurn], 3).verdict).toBe('NO VERDICT')
  })
  it('NOT only in 3 of 3: one run that attached makes it NO VERDICT', () => {
    expect(P.formVerdict(form('typed'), three(notAttached), 3).verdict).toBe('NOT')
    expect(P.formVerdict(form('typed'), [notAttached, attached, notAttached], 3).verdict).toBe('NO VERDICT')
    expect(P.formVerdict(form('typed'), three({ turn: { images: [{ way: 'url' }] } }), 3).verdict).toBe('NO VERDICT')
  })
  it('CANNOT MEASURE only when no run reached a turn; it names why', () => {
    const v = P.formVerdict(form('paste'), three(noTurn), 3)
    expect(v.verdict).toBe('CANNOT MEASURE')
    expect(v.summary).toContain('why no turn: no turn reached the stand-in within 20 s of either Enter')
    expect(P.formVerdict(form('paste'), [noTurn, noTurn, notAttached], 3).verdict).toBe('NO VERDICT')
  })
  it('any count but 3 is a CHECK RUN; a recorded form gives no verdict', () => {
    expect(P.formVerdict(form('paste'), [attached], 1).verdict).toBe('CHECK RUN (attaches in 1 runs)')
    expect(P.formVerdict(form('paste'), [attached, attached], 3).verdict).toMatch(/^CHECK RUN/)
    expect(P.formVerdict(form('paste-plain'), [attached], 3).verdict).toBe('RECORDED')
  })
  it('the summary counts bracketed paste, the placeholder, the file name in the text and a second Enter', () => {
    const look = (placeholder: boolean): Look => ({ rows: [], placeholder, fileNameShown: !placeholder })
    const r = (bp: boolean, ph: boolean, inText: boolean, enters = 1): Reading => ({ turn: { images: [{ ...P.PICTURE_INFO }], pathInText: inText }, bracketedPaste: bp, looks: { afterPaste: look(ph), beforeEnter: look(ph) }, enters })
    const s = P.formVerdict(form('paste'), [r(true, true, false), r(true, true, false), r(false, false, true, 2)], 3).summary
    expect(s).toContain('bracketed paste asked for by the CLI in 2 of 3')
    expect(s).toContain('a placeholder after the paste in 2 of 3')
    expect(s).toContain("the file name in the turn's text in 1 of 3")
    expect(s).toContain('matched by the same bytes')
    expect(s).toContain('a second Enter in 1')
  })
})

describe('P11: what the verdicts mean for X1.2', () => {
  it('builds only when Claude Code attaches the paste and not the typed form', () => {
    expect(P.forX12({ paste: { verdict: 'ATTACHES' }, typed: { verdict: 'NOT' } })).toMatch(/^BUILD - /)
  })
  it('no build when the typed form already attaches, or the paste does not, or either has no verdict', () => {
    expect(P.forX12({ paste: { verdict: 'ATTACHES' }, typed: { verdict: 'ATTACHES' } })).toMatch(/^NO BUILD - Claude Code already attaches/)
    expect(P.forX12({ paste: { verdict: 'NOT' }, typed: { verdict: 'NOT' } })).toMatch(/^NO BUILD - Claude Code paste NOT, typed NOT/)
    expect(P.forX12({ paste: { verdict: 'ATTACHES' }, typed: { verdict: 'NO VERDICT' } })).toMatch(/^NO BUILD/)
    expect(P.forX12({ paste: { verdict: 'CHECK RUN (attaches in 1 runs)' }, typed: { verdict: 'NOT' } })).toMatch(/^NO BUILD/)
    expect(P.forX12(undefined)).toMatch(/^NO BUILD - Claude Code paste not run, typed not run/)
  })
})

describe('P11: the record', () => {
  it('writes the temporary folder as a placeholder, in a path and in JSON-escaped text', () => {
    const clean = P.sanitizer([['C:\\Users\\U\\AppData\\Local\\Temp\\p11-ab12', '<temp>']])
    const out = clean({ picturePath: 'C:\\Users\\U\\AppData\\Local\\Temp\\p11-ab12\\claude-paste-1\\x.jpg', text: 'see C:\\\\Users\\\\U\\\\AppData\\\\Local\\\\Temp\\\\p11-ab12\\\\y' }) as Record<string, string>
    expect(out.picturePath).toBe('<temp>\\claude-paste-1\\x.jpg')
    expect(out.text).not.toContain('p11-ab12')
  })
})
