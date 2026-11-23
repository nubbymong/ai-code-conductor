// aicc_planning#394: beta.15 M1 recorded what the console built into Windows sent a
// plain terminal (PowerShell, both helper switches off) on the published beta.14,
// Windows 11 build 22621, while its window changed size. Each recording is the tail
// of one run: the console's own output of 10,000 lines of `long N ` and 250 `y`
// from line 9971 on (the lines before it are written by the test, as the same text),
// then each resize the tab's terminal took and the console's paint after it,
// byte for byte. Runs of y are written <yN> (N of them); the prompt is the
// recorded one's length with another path in it, so the paint's cursor column
// still lands after it. Source: M1's out/vmout-hold1/<name>-stream.stream.txt,
// -stream.stream.json and -sizes.sizes.json; off2-grow kept only its paints, so
// its print is off1-grow's (the same command at the same size).
//
// The held terminal restores (RECORDED_RESTORES) are beta.14 C8's VM line, below.
//
// Not a test file: tests/unit/renderer/console-repaint-after-resize.test.ts reads it.
export interface RecordedResizeEvent { write?: string; resize?: string }
export interface RecordedResize {
  name: string
  /** The terminal's size while the lines were printed. */
  start: string
  /** The first line the recording holds. */
  firstLine: number
  events: RecordedResizeEvent[]
}

/** Expands the <yN> runs. */
export function expandRuns(s: string): string {
  return s.replace(/<y(\d+)>/g, (_m, n: string) => 'y'.repeat(Number(n)))
}

export const RECORDED_RESIZES: RecordedResize[] = [
  {
    name: "off1-grow",
    start: "103x27",
    firstLine: 9971,
    // 19844 chunks recorded; the tail from line 9971 on.
    events: [
      { write: "long 9971 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9972 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9973 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9974 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9975 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9976 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9977 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9978 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9979 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9980 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9981 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9982 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9983 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9984 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9985 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9986 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9987 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9988 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9989 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9990 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9991 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9992 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9993 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9994 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9995 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9996 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9997 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9998 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9999 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 10000 <y92>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y56>\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[1C" }, // chunks #19781..#19841
      { resize: "140x27" }, // resized at 2026-11-23T00:57:58.091Z
      { write: "\u001b[?25l\u001b[H<y157>\u001b[K\r\nlong 9993 <y250>\u001b[K\r\nlong 9994 <y250>\u001b[K\r\nlong 9995 <y250>\u001b[K\r\nlong 9996 <y250>\u001b[K\r\nlong 9997 <y250>\u001b[K\r\nlong 9998 <y250>\u001b[K\r\nlong 9999 <y250>\u001b[K\r\nlong 10000 <y250>\u001b[K\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[19;40H\u001b[?25h" }, // chunks #19842
      { resize: "140x28" }, // resized at 2026-11-23T00:57:58.484Z
      { write: "\u001b[?25l\u001b[H<y157>\u001b[K\r\nlong 9993 <y250>\u001b[K\r\nlong 9994 <y250>\u001b[K\r\nlong 9995 <y250>\u001b[K\r\nlong 9996 <y250>\u001b[K\r\nlong 9997 <y250>\u001b[K\r\nlong 9998 <y250>\u001b[K\r\nlong 9999 <y250>\u001b[K\r\nlong 10000 <y250>\u001b[K\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[19;40H\u001b[?25h" }, // chunks #19843
    ],
  },
  {
    name: "off2-grow",
    start: "103x27",
    firstLine: 9971,
    // 2 chunks recorded; the tail from line 9971 on.
    events: [
      { write: "long 9971 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9972 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9973 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9974 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9975 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9976 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9977 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9978 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9979 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9980 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9981 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9982 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9983 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9984 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9985 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9986 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9987 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9988 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9989 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9990 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9991 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9992 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9993 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9994 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9995 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9996 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9997 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9998 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9999 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 10000 <y92>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y56>\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[1C" }, // the print: off1-grow's chunks #19781..#19841
      { resize: "140x24" }, // resized at 2026-11-23T00:59:56.699Z
      { write: "\u001b[?25l\u001b[H<y157>\u001b[K\r\nlong 9993 <y250>\u001b[K\r\nlong 9994 <y250>\u001b[K\r\nlong 9995 <y250>\u001b[K\r\nlong 9996 <y250>\u001b[K\r\nlong 9997 <y250>\u001b[K\r\nlong 9998 <y250>\u001b[K\r\nlong 9999 <y250>\u001b[K\r\nlong 10000 <y250>\u001b[K\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[19;40H\u001b[?25h" }, // chunks #0
      { resize: "140x28" }, // resized at 2026-11-23T00:59:57.109Z
      { write: "\u001b[?25l\u001b[H<y157>\u001b[K\r\nlong 9993 <y250>\u001b[K\r\nlong 9994 <y250>\u001b[K\r\nlong 9995 <y250>\u001b[K\r\nlong 9996 <y250>\u001b[K\r\nlong 9997 <y250>\u001b[K\r\nlong 9998 <y250>\u001b[K\r\nlong 9999 <y250>\u001b[K\r\nlong 10000 <y250>\u001b[K\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[19;40H\u001b[?25h" }, // chunks #1
    ],
  },
  {
    name: "off1-shrink",
    start: "103x27",
    firstLine: 9971,
    // 19823 chunks recorded; the tail from line 9971 on.
    events: [
      { write: "long 9971 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9972 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9973 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9974 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9975 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9976 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9977 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9978 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9979 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9980 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9981 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9982 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9983 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9984 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9985 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9986 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9987 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9988 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9989 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9990 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9991 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9992 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9993 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9994 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9995 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9996 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9997 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9998 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 9999 <y93>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y55>\r\nlong 10000 <y92>\r\n\u001b[26;103H<y104>\r\n\u001b[26;103H<y56>\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[1C" }, // chunks #19759..#19820
      { resize: "140x28" }, // resized at 2026-11-23T00:58:42.945Z
      { write: "\u001b[?25l\u001b[H<y157>\u001b[K\r\nlong 9993 <y250>\u001b[K\r\nlong 9994 <y250>\u001b[K\r\nlong 9995 <y250>\u001b[K\r\nlong 9996 <y250>\u001b[K\r\nlong 9997 <y250>\u001b[K\r\nlong 9998 <y250>\u001b[K\r\nlong 9999 <y250>\u001b[K\r\nlong 10000 <y250>\u001b[K\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[19;40H\u001b[?25h" }, // chunks #19821
      { resize: "140x24" }, // resized at 2026-11-23T00:58:43.344Z
      { write: "\u001b[?25l\u001b[H<y157>\u001b[K\r\nlong 9993 <y250>\u001b[K\r\nlong 9994 <y250>\u001b[K\r\nlong 9995 <y250>\u001b[K\r\nlong 9996 <y250>\u001b[K\r\nlong 9997 <y250>\u001b[K\r\nlong 9998 <y250>\u001b[K\r\nlong 9999 <y250>\u001b[K\r\nlong 10000 <y250>\u001b[K\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[19;40H\u001b[?25h" }, // chunks #19822
    ],
  },
  {
    name: "off1-max",
    start: "140x28",
    firstLine: 9971,
    // 19625 chunks recorded; the tail from line 9971 on.
    events: [
      { write: "long 9971 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9972 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9973 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9974 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9975 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9976 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9977 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9978 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9979 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9980 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9981 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9982 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9983 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9984 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9985 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9986 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9987 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9988 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9989 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9990 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9991 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9992 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9993 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9994 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9995 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9996 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9997 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9998 <y130>\r\n\u001b[27;140H<y121>\r\nlong 9999 <y130>\r\n\u001b[27;140H<y121>\r\nlong 10000 <y129>\r\n\u001b[27;140H<y122>\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[1C" }, // chunks #19564..#19623
      { resize: "103x27" }, // resized at 2026-11-23T00:58:21.068Z
      { write: "\u001b[?25l\u001b[H<y157>\u001b[K\r\nlong 9993 <y250>\u001b[K\r\nlong 9994 <y250>\u001b[K\r\nlong 9995 <y250>\u001b[K\r\nlong 9996 <y250>\u001b[K\r\nlong 9997 <y250>\u001b[K\r\nlong 9998 <y250>\u001b[K\r\nlong 9999 <y250>\u001b[K\r\nlong 10000 <y250>\u001b[K\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[K\u001b[1C\u001b[?25h" }, // chunks #19624
    ],
  },
]

/**
 * How the console built into Windows wrote one `long N ` line of 250 `y` at
 * `cols` by `rows` in these recordings: the first row, then each later row as
 * CR LF, a cursor position on the last column of the row above, that column's
 * character again and the row, so the terminal wraps on to it. `clear` is the
 * console's ESC[3J in the two restores below, at the line's start or after its
 * first row.
 */
export function consoleLine(n: number, cols: number, rows: number, clear?: 'start' | 'second row'): string {
  const text = `long ${n} ${'y'.repeat(250)}`
  let s = (clear === 'start' ? '\x1b[3J' : '') + text.slice(0, cols)
  for (let at = cols; at < text.length; at += cols) {
    s += '\r\n' + (clear === 'second row' && at === cols ? '\x1b[3J' : '') + `\x1b[${rows - 1};${cols}H` + text[at - 1] + text.slice(at, at + cols)
  }
  return s + '\r\n'
}

/**
 * beta.14 C8's VM line (aicc_planning#392, an unsigned build of 441823db,
 * plain terminals through the session helper on, 22 Nov): a held terminal
 * restored after the window changed size. Its replay, written at the holder's
 * size, is the app's notice and the console's own output of the lines the
 * helper still held; consoleLine writes it again byte for byte (the test
 * checks its length against the recording's). Then the tab is fitted to its
 * own size and the console paints its screen at it: `paint`, as recorded.
 * Source: beta.14's vmC8/out/vmout/u1-keep.stream.* (up, 1 of 3, the other two
 * the same bytes) and d1-09-stream.stream.* (down).
 */
export interface RecordedRestore {
  name: string
  /** The holder's size (the replay's) and the tab's. */
  holder: string
  tab: string
  /** The replay: `head`, lines `firstLine` to 10000, `tail`. */
  head: string
  firstLine: number
  clear: { line: number; at: 'start' | 'second row' }
  tail: string
  /** The replay's length in the recording. */
  length: number
  paint: string
}

export const RECORDED_RESTORES: RecordedRestore[] = [
  {
    name: 'u1-keep',
    holder: '103x27',
    tab: '140x28',
    head: '\u0018\u001b[0m\u001b[26;1H[Earlier output of this terminal is no longer held, so it is not shown.]\r\n',
    firstLine: 6678,
    clear: { line: 6686, at: 'second row' },
    tail: 'PS C:\\fixture\\long-lines\\work\\resizes>\u001b[1C',
    length: 950511,
    paint: "\u001b[?25l\u001b[H<y157>\u001b[K\r\nlong 9993 <y250>\u001b[K\r\nlong 9994 <y250>\u001b[K\r\nlong 9995 <y250>\u001b[K\r\nlong 9996 <y250>\u001b[K\r\nlong 9997 <y250>\u001b[K\r\nlong 9998 <y250>\u001b[K\r\nlong 9999 <y250>\u001b[K\r\nlong 10000 <y250>\u001b[K\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[19;40H\u001b[?25h",
  },
  {
    name: 'd1-09',
    holder: '140x28',
    tab: '103x27',
    head: '\u0018\u001b[0m\u001b[27;1H[Earlier output of this terminal is no longer held, so it is not shown.]\r\n',
    firstLine: 7509,
    clear: { line: 7522, at: 'start' },
    tail: 'PS C:\\fixture\\long-lines\\work\\resizes>\u001b[1C',
    length: 682941,
    paint: "\u001b[?25l\u001b[H<y157>\u001b[K\r\nlong 9993 <y250>\u001b[K\r\nlong 9994 <y250>\u001b[K\r\nlong 9995 <y250>\u001b[K\r\nlong 9996 <y250>\u001b[K\r\nlong 9997 <y250>\u001b[K\r\nlong 9998 <y250>\u001b[K\r\nlong 9999 <y250>\u001b[K\r\nlong 10000 <y250>\u001b[K\r\nPS C:\\fixture\\long-lines\\work\\resizes>\u001b[K\u001b[1C\u001b[?25h",
  },
]

/** A restore's replay, as the holder sent it. */
export function restoreReplay(r: RecordedRestore): string {
  const [cols, rows] = r.holder.split('x').map(Number)
  let s = r.head
  for (let n = r.firstLine; n <= 10000; n++) s += consoleLine(n, cols, rows, n === r.clear.line ? r.clear.at : undefined)
  return s + r.tail
}
