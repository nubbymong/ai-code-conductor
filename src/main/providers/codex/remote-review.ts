// 2.1.3-beta.21 (nubbymong/aicc_planning#446): a Codex review on another
// machine, the one a remote session runs on (core's ProviderRemoteReview).
// Pure: it starts nothing and reads no file. Core runs Codex there through
// the session helper's one-shot run mode, on that machine's own sign-in
// (owner default Q10), and names no flag of it; this says what Codex's argv
// is there and how its output, its version and its model list read, with the
// same rules as a review on this computer:
//
// - the argv is ADR-031's, the review constant and the two allow-listed
//   values (cli-runner.ts codexReviewArgs), the same bytes as here;
// - the output is read by the same reader as here (review.ts
//   createCodexExecEventReader);
// - the version by cli-contract.ts, and the oldest one this app runs;
// - the model list by the read installed-codex-models.ts makes here (the
//   runner's `models` constant, in a fresh, empty Codex home), and its parse
//   (model-catalogue.ts).
import type { ProviderRemoteReview } from '../core'
import { codexCommandLine, codexReviewArgs } from './cli-runner'
import { CODEX_MIN_SUPPORTED_VERSION, classifyCodexVersion, parseCodexVersion } from './cli-contract'
import { parseCodexModelCatalogue } from './model-catalogue'
import { createCodexExecEventReader } from './review'

/** The words of the model list read: the runner's own `models` constant. */
function modelListWords(): readonly string[] {
  const cmd = codexCommandLine('/codex', 'models', 'linux', {})
  if ('refused' in cmd) throw new Error(`the Codex models read has no argv: ${cmd.refused}`)
  return Object.freeze([...cmd.args])
}

export const codexRemoteReview: ProviderRemoteReview = Object.freeze({
  program: 'codex',
  minVersion: CODEX_MIN_SUPPORTED_VERSION,
  parseVersion: (line: string) => parseCodexVersion(line),
  tooOld: (version: string) => classifyCodexVersion(version) === 'too-old',
  args: (choice: { model?: string; effort?: string }) => codexReviewArgs(choice),
  readOutput: (stdout: string) => {
    const reader = createCodexExecEventReader()
    reader.push(stdout)
    return reader.end()
  },
  modelListRead: Object.freeze({ words: modelListWords(), configVariable: 'CODEX_HOME' }),
  parseModelList: (stdout: string) => parseCodexModelCatalogue(stdout),
})
