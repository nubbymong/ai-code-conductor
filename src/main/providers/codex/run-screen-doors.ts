// The Codex package's door members (2.1.3-beta.18 section 4,
// aicc_planning#432; ADR-030 component rows 3 and 14): how each door of the
// session input module types into a Codex session. The module tested for
// Codex at each of its doors and called the submit primitive or the image
// rule itself; it now asks the session's own provider, and these map each
// door to that same Codex call (session-screen.ts: submitCodexText,
// submitCodexImage) with the door's own waits, exactly as the module handed
// them before: nothing typed, its order or its timing changed. They are
// built over the run screen's own primitives (`base`), which index.ts hands
// in, so a test can hand fakes of them.
import type { RunScreenImageResult, RunScreenTyping, SessionRunScreen } from '../types'
import type { PromptButtonResult, SubmitTextResult } from '../../../shared/types'
import { codexPromptKeeps } from '../../../shared/codex-screen'
import { logInfo } from '../../debug-logger'

/** The run screen's own primitives the door members type through: whether
 *  main reads the session's screen, the submit primitive, and the image rule. */
export type CodexScreenPrimitives = Required<Pick<SessionRunScreen, 'has' | 'submit'>> & Pick<SessionRunScreen, 'submitImage'>

/** The door members, over `base`. */
export function codexDoorMembers(base: CodexScreenPrimitives): Required<Pick<SessionRunScreen, 'retry' | 'prompt' | 'marker' | 'image' | 'ask'>> {
  return {
    /** The Watchdog's retry: the submit primitive, which types it only at
     *  Codex's ready, empty composer (ready on two reads 300 ms apart), its
     *  Enter only once the text is confirmed on screen, a text not confirmed
     *  taken back with Ctrl+U, and only into the run whose screen it read.
     *  Its wait counts from the door's call (`readyBy`), and `stillWanted`,
     *  the Watchdog's "its incident is still the one it was sent for", goes
     *  with it (PR #746 review). The answer says whether it was delivered. */
    retry(sessionId: string, text: string, opts: { readyWaitMs: number; readyBy: number; stillWanted?: () => boolean }): Promise<SubmitTextResult> {
      // The primitive answers a session whose screen it does not read itself.
      return base.submit(sessionId, text, { readyWaitMs: opts.readyWaitMs, readyBy: opts.readyBy, ...(opts.stillWanted ? { stillWanted: opts.stillWanted } : {}) })
    },
    /** A prompt button's Send (#333): the submit primitive, as canvas notes
     *  and Ask Conductor use it, waiting for the ready, empty composer; its
     *  answer is the answer. A text over the door's `maxCodePoints` is not
     *  handed to it: nothing is typed, and the answer is not sent
     *  (`refused-text`). A text it refuses before typing (a control
     *  character, a line break, a character Codex's composer drops) is typed
     *  with no Enter, as a press always left it on Codex, for the user to
     *  check and send, and the answer says so. */
    async prompt(sessionId: string, text: string, opts: { readyWaitMs: number; maxCodePoints: number; enterDelayMs: number }, typing: RunScreenTyping): Promise<PromptButtonResult> {
      if ([...text].length > opts.maxCodePoints) return { outcome: 'not-sent', reason: 'refused-text' }
      // The primitive answers a session whose screen it does not read itself.
      const result = await base.submit(sessionId, text, { readyWaitMs: opts.readyWaitMs })
      if (result.delivered) return { outcome: 'sent' }
      if (result.reason !== 'refused-text') return { outcome: 'not-sent', reason: result.reason }
      if (!typing.live()) return { outcome: 'not-sent', reason: 'session-gone' }
      const data = `${typing.leave}${text}`
      typing.write(data)
      await typing.settled(data, opts.enterDelayMs)
      return { outcome: 'typed', reason: 'refused-text' }
    },
    /** An Agent Canvas marker (WP2 PR 4, P4.1): the submit primitive, which
     *  types it only at Codex's ready, empty composer, waiting within the
     *  marker queue's own fallback bound while a turn runs or a prompt is up,
     *  and submits it once it is confirmed on screen: Codex never submits
     *  one write of a line and its Enter (PB3). */
    marker(sessionId: string, line: string, opts: { readyWaitMs: number }): Promise<SubmitTextResult> {
      // The primitive answers a session whose screen it does not read itself (review A-8).
      return base.submit(sessionId, line, { readyWaitMs: opts.readyWaitMs })
    },
    /** A saved image (2.1.3-beta.17 C6, aicc_planning#415): Codex's image
     *  rule, which waits for the ready, empty composer, pastes the path,
     *  reads Codex's image placeholder, then has the submit primitive type
     *  the sentence, confirm it and press Enter (session-screen.ts,
     *  pasteImageIntoCodexComposer, says how). A session whose screen main
     *  does not read is not asked (`no-screen`). */
    async image(sessionId: string, imagePath: string, sentence: string, opts: { readyWaitMs: number }): Promise<RunScreenImageResult> {
      if (!base.submitImage || !base.has(sessionId)) return { pasted: false, reason: 'no-screen', left: false }
      return base.submitImage(sessionId, imagePath, sentence, { readyWaitMs: opts.readyWaitMs })
    },
    /** Ask Conductor's question (WP2 PR 4, P4.3, row 53): the characters
     *  Codex's prompt would drop are removed first and `removed` told how
     *  many (section 10 question 6, default A), then the submit primitive,
     *  never the raw question and Enter (Codex submits no such write, PB3).
     *  A question with nothing left, or a session whose screen main does not
     *  read, is not delivered. The log names the question by its length
     *  only. Never rejects. */
    async ask(sessionId: string, question: string, opts: { readyWaitMs: number; removed: (count: number) => void }): Promise<SubmitTextResult> {
      let result: SubmitTextResult
      try {
        if (!base.has(sessionId)) {
          result = { delivered: false, reason: 'session-gone' }
        } else {
          const { text, removed } = codexPromptKeeps(question)
          if (removed > 0) opts.removed(removed)
          result = text.trim() ? await base.submit(sessionId, text, { readyWaitMs: opts.readyWaitMs }) : { delivered: false, reason: 'refused-text' }
        }
      } catch {
        result = { delivered: false, reason: 'session-gone' }
      }
      logInfo(`[codex-ask] ${sessionId}: a question of ${[...question].length} characters ${result.delivered ? 'typed into Codex\'s prompt' : `not delivered (${result.reason})`}`)
      return result
    },
  }
}
