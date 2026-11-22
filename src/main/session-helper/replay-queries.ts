/**
 * A take-over's replay with the terminal queries in it taken out
 * (2.1.3-beta.13, plan section A3, aicc_planning#360; helper-pty.ts).
 *
 * A program asks its terminal things by writing a query into its output: what
 * kind of terminal it is (DA1, DA2, XTVERSION), where the cursor is (DSR 6n),
 * whether it is ready (DSR 5n), a mode's state (DECRQM), the keyboard mode
 * (CSI ? u), a colour (OSC 4, 10, 11 and 12 with `?`), a setting (DECRQSS),
 * the window's size (CSI 14, 16 and 18 t), or its answerback (ENQ). The
 * terminal answers into the program's input. A take-over's replay was shown
 * once already, by the app that ran before, and its tab answered those
 * queries then. Shown again, the tab would answer them again, and so would
 * main's own colour answer (terminal-query-responder.ts), to a program that
 * asked nothing: it reads the answer as typed text. So each complete query in
 * the replay is taken out, and nothing else changes: the screen, the modes and
 * the colours are as the whole replay leaves them.
 *
 * A query is what the tab's terminal (xterm.js 6.0.0) reads as one, read with
 * replay-tail.ts's parser (its states, and the hooks it tells), wherever it
 * stands:
 *  - a CSI: DA1 and DA2 (no parameter, or 0), DSR 5n and 6n with or without
 *    `?`, XTVERSION (CSI > q, no parameter or 0), DECRQM (CSI $ p and
 *    CSI ? $ p), the kitty keyboard query (CSI ? u), CSI 14, 16 and 18 t;
 *  - an OSC 4, 10, 11 or 12 ended by BEL, ST or ESC, its number read as the
 *    tab reads it (leading zeros too), with a part that is `?` where the tab
 *    reads one: OSC 4 in pairs (a number from 0 to 255, then `?`), OSC 10 to 12
 *    one part each for 10, 11 and 12, from its own number on. One that sets
 *    colours too keeps its sets: they go on, each as an OSC of its own (OSC 4's
 *    all in one);
 *  - DECRQSS: a DCS string with the intermediate `$` and the final `q`, ended
 *    by ST or ESC (CAN or SUB cancel it, and the tab answers nothing);
 *  - ENQ, wherever the tab carries it out.
 *
 * In each one's place goes a stand-in that does what its first character did
 * and nothing more. A query's ESC also ends whatever was being read before it
 * (an OSC string not yet ended, say), so a query that started with ESC becomes
 * ST alone (`ESC \`): it ends the same things, and the tab does nothing with
 * it but forget the character a repeat (CSI b) would repeat, as after the
 * query. One that started with an 8-bit introducer (U+009B, U+009D, U+0090),
 * which cuts short what it ends, becomes CAN, which does the same. ENQ
 * becomes NUL, which the tab carries out as it does ENQ (nothing) and never
 * answers. The C0 controls the tab carries out inside a query (a line feed in
 * a CSI) stay, after the stand-in. A string ended by ESC keeps that ESC and
 * what follows it (its `\`, or the next sequence), as the end of whatever it
 * ends.
 *
 * The text comes in pieces. A sequence a piece ends in the middle of is held
 * until it is whole while it may still be a query: a CSI, an ESC and what
 * follows it, an OSC whose number may still be 4, 10, 11 or 12, a DCS string
 * before its final byte or one that is DECRQSS. One that cannot be (an OSC 8
 * link, a DCS image, an APC string) is passed on as it comes, so nothing long
 * is held for nothing. `flush` gives back what is held, as it is: the replay
 * ended in the middle of a sequence, and the live output after it ends it, so
 * a query the program finished writing after the take-over is answered, once.
 *
 * Left as they are: the queries xterm.js 6.0.0 does not answer and the plan
 * does not name (DA3, XTGETTCAP, the other CSI t reports, the other DSR
 * reports).
 */
import { CSI, ESC, OSC, Reader, STRING } from './replay-tail'

/** In place of a query that started with ESC: ST alone. */
const ST = '\x1b\\'
/** In place of one that started with an 8-bit introducer. */
const CAN = '\x18'
/** In place of ENQ. */
const NUL = '\x00'
const ENQ = 0x05
const COLOUR_IDS = new Set([4, 10, 11, 12])

/** A CSI the tab may answer, by its prefix (0 for none), intermediates, parameters and final byte. */
function csiAsks(prefix: number, inter: string, params: readonly number[], final: number): boolean {
  const first = params[0] ?? 0
  // DECRQM, ANSI and DEC.
  if (inter === '$') return final === 0x70 && (prefix === 0 || prefix === 0x3f)
  if (inter !== '') return false
  switch (final) {
    case 0x63: return (prefix === 0 || prefix === 0x3e) && first === 0 // DA1, DA2
    case 0x6e: return (prefix === 0 || prefix === 0x3f) && (first === 5 || first === 6) // DSR
    case 0x71: return prefix === 0x3e && first === 0 // XTVERSION
    case 0x75: return prefix === 0x3f // the kitty keyboard query
    case 0x74: return prefix === 0 && (first === 14 || first === 16 || first === 18) // the window's size
  }
  return false
}

/**
 * The colours an OSC's text (its number, `;`, its data) asks for, as xterm.js 6.0.0 reads OSC 4, 10, 11 and 12
 * (InputHandler setOrReportIndexedColor and _setOrReportSpecialColor): null when it asks for none, else the
 * colour sets it carries as well, each an OSC's text.
 */
function colourAsks(text: string): string[] | null {
  const semi = text.indexOf(';')
  const id = semi > 0 && /^\d+$/.test(text.slice(0, semi)) ? Number(text.slice(0, semi)) : -1
  const parts = text.slice(semi + 1).split(';')
  const sets: string[] = []
  let asks = false
  if (id === 4) {
    // In pairs; a part left over at the end is read as nothing.
    for (let k = 0; k + 1 < parts.length; k += 2) {
      if (/^\d+$/.test(parts[k]) && Number(parts[k]) < 256 && parts[k + 1] === '?') asks = true
      else sets.push(`${parts[k]};${parts[k + 1]}`)
    }
    return asks ? (sets.length > 0 ? [`4;${sets.join(';')}`] : []) : null
  }
  if (id >= 10 && id <= 12) {
    // A part each for 10, 11 and 12, from its own number on; parts past 12 are read as nothing.
    for (let k = 0; k < parts.length && id + k <= 12; k++) {
      if (parts[k] === '?') asks = true
      else sets.push(`${id + k};${parts[k]}`)
    }
    return asks ? sets : null
  }
  return null
}

/** An OSC's text so far may still be 4, 10, 11 or 12. */
function mayBeColour(soFar: string): boolean {
  const semi = soFar.indexOf(';')
  const id = semi < 0 ? soFar : soFar.slice(0, semi)
  if (!/^\d*$/.test(id)) return false
  return semi < 0 ? Number(id) <= 12 : id !== '' && COLOUR_IDS.has(Number(id))
}

/** replay-tail.ts's parser, told where each sequence starts and ends: what to take out of the text it reads. */
class Queries extends Reader {
  /** What is read: the text held from before, then the new piece. */
  text = ''
  /** Where the sequence being read starts (its ESC or 8-bit introducer); -1 when none is, or it cannot be a query. */
  seq = -1
  /** The C0 controls the tab carries out inside that sequence (ENQ as NUL): kept when it is taken out. */
  private inner = ''
  /** The DCS string being read is DECRQSS. */
  private decrqss = false
  /** What goes in place of each query read: from, to (not included), and its stand-in. In order. */
  edits: Array<[number, number, string]> = []
  /** Queries taken out. */
  count = 0

  constructor() {
    // The width counts rows, which nothing here reads.
    super(80)
  }

  /** Where to hold the text from: the start of a sequence not ended yet that may still be a query, else its end. One that cannot be one is let go of. */
  holdFrom(): number {
    const seq = this.seq
    if (seq >= 0) {
      if (this.state === ESC || this.state === CSI) return seq
      if (this.state === OSC && mayBeColour(this.oscText(seq, this.text.length))) return seq
      if (this.state === STRING && this.dcs && (!this.hooked || this.decrqss)) return seq
    }
    this.seq = -1
    return this.text.length
  }

  protected began(i: number): void {
    this.seq = i
    this.inner = ''
    this.decrqss = false
  }

  protected execute(c: number, i: number, ground: boolean): void {
    super.execute(c, i, ground)
    if (c === ENQ) this.put(i, i + 1, NUL)
    if (!ground && this.seq >= 0) this.inner += c === ENQ ? NUL : String.fromCharCode(c)
  }

  protected escape(final: number, i: number): void {
    super.escape(final, i)
    this.seq = -1
  }

  protected csiEnd(final: number, i: number): void {
    const seq = this.seq
    this.seq = -1
    if (seq >= 0 && csiAsks(this.prefix, this.inter, this.params, final)) this.take(seq, i + 1, '')
  }

  protected hook(final: number): void {
    this.decrqss = this.prefix === 0 && this.inter === '$' && final === 0x71
  }

  protected stringEnd(i: number, done: boolean): void {
    const seq = this.seq
    this.seq = -1
    if (seq < 0 || !done) return
    // Ended by ESC: that ESC stays, as the end of whatever it ends, and so does what follows it.
    const byEsc = this.text.charCodeAt(i) === 0x1b
    const to = byEsc ? i : i + 1
    if (this.state === OSC) {
      const sets = colourAsks(this.oscText(seq, i))?.map((s) => `\x1b]${s}`)
      if (sets) this.take(seq, to, sets.join(ST) + (sets.length > 0 && !byEsc ? ST : ''))
    } else if (this.decrqss) this.take(seq, to, '')
  }

  /** The query from `seq` to `to` (not included) goes: its stand-in, the C0 controls carried out in it, then `rest`. */
  private take(seq: number, to: number, rest: string): void {
    this.put(seq, to, (this.text.charCodeAt(seq) === 0x1b ? ST : CAN) + this.inner + rest)
  }

  private put(from: number, to: number, text: string): void {
    // An edit inside this one (an ENQ in the query) is part of it now.
    while (this.edits.length > 0 && this.edits[this.edits.length - 1][0] >= from) this.edits.pop()
    this.edits.push([from, to, text])
    this.count++
  }

  /** An OSC's text as the tab reads it: from after its introducer (ESC, the C0 controls carried out after it, `]`; or U+009D) to `end`, without the C0 controls the tab drops inside it. */
  private oscText(seq: number, end: number): string {
    let k = seq + 1
    if (this.text.charCodeAt(seq) === 0x1b) {
      while (k < end && this.text.charCodeAt(k) !== 0x5d) k++
      k++
    }
    return this.text.slice(k, end).replace(/[\x00-\x1f]/g, '')
  }
}

/** Takes the terminal queries out of a replay that comes in pieces. */
export class ReplayQueryFilter {
  private reader = new Queries()
  private before = 0

  /** Queries taken out so far. */
  get dropped(): number {
    return this.before + this.reader.count
  }

  /** The next piece in; out, the text so far that is sure, each query in it taken out. */
  write(piece: string): string {
    const r = this.reader
    const held = r.text.length
    r.text += piece
    r.read(r.text, r.text.length, held)
    return this.give(r.holdFrom())
  }

  /** What is held, as it is (an ENQ in it as NUL), and reading starts again from nothing: the replay ended, or goes on after a gap. */
  flush(): string {
    const out = this.give(this.reader.text.length)
    this.before += this.reader.count
    this.reader = new Queries()
    return out
  }

  /** The text up to `hold`, each query in it taken out; the rest is held. */
  private give(hold: number): string {
    const r = this.reader
    let out = ''
    let at = 0
    const later: Array<[number, number, string]> = []
    for (const [from, to, text] of r.edits) {
      if (from >= hold) { later.push([from - hold, to - hold, text]); continue }
      out += r.text.slice(at, from) + text
      at = to
    }
    out += r.text.slice(at, hold)
    r.edits = later
    r.text = r.text.slice(hold)
    if (r.seq >= 0) r.seq -= hold
    return out
  }
}
