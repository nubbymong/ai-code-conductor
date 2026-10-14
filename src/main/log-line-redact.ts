// The text a stream's reads put in the app's log, redacted on whole lines.
//
// A program writes its output in whole lines, but one pipe or terminal read
// can end inside a line, so a credential can arrive split across two reads,
// and a redactor run on each read alone matches neither half. This keeps the
// unfinished last line of each read back and redacts it joined to the next
// read, so the log gets whole lines, each redacted as one text.
//
// A line break is "\n" or "\r". An unfinished line is held up to
// LOG_LINE_CARRY_MAX characters; past that it is redacted and logged as it
// stands, so memory stays bounded, and only a credential split exactly where
// that happens can still be missed (credentials are far shorter than that).

/** The longest unfinished line held back for the next read. */
export const LOG_LINE_CARRY_MAX = 8 * 1024

export interface LineRedactor {
  /** One read: the whole lines it completes (with the unfinished line held
   *  from earlier reads in front), redacted; or, once the unfinished line is
   *  past the bound, everything held so far, redacted; '' when it completes
   *  none and the bound is not passed. */
  push(chunk: string): string
  /** The stream ended: the unfinished line still held, redacted ('' if none). */
  flush(): string
}

export function createLineRedactor(redact: (text: string) => string, carryMax: number = LOG_LINE_CARRY_MAX): LineRedactor {
  let carry = ''
  return {
    push(chunk: string): string {
      const text = carry + chunk
      const end = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1
      const rest = text.slice(end)
      if (rest.length > carryMax) {
        carry = ''
        return text ? redact(text) : ''
      }
      carry = rest
      return end > 0 ? redact(text.slice(0, end)) : ''
    },
    flush(): string {
      const rest = carry
      carry = ''
      return rest ? redact(rest) : ''
    },
  }
}
