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
