import type { ToolCall } from '@shared/agent'
import { maxOutputTokensFor } from '@shared/model-facts'

/**
 * What the agent loops do when a reply stops at the model's output limit. Shared by the
 * main loop and the subagent loop so both recover the same way:
 *
 *  - A tool call the limit cut off is answered with {@link incompleteCallResult} instead of
 *    being run, so the history stays valid and the model is told to split the work.
 *  - A text reply the limit cut off is continued with {@link continuationNote}, a bounded
 *    number of times in a row ({@link MAX_OUTPUT_CONTINUATIONS}).
 *  - Either way, later requests in the run ask for the model's full output ceiling
 *    ({@link raisedOutputCap}), so the redo or the continuation has more room than the
 *    reply that was cut.
 */

/** Automatic continuations of a cut-off text reply, in a row, before the run gives up. */
export const MAX_OUTPUT_CONTINUATIONS = 3

/**
 * The tool result for a call the adapter marked `incomplete`. Nothing ran. When the reply
 * stopped at its output limit (`outputLimited`) the arguments were cut off, so the model is
 * told to split the work; otherwise the JSON was malformed and it should just resend it.
 */
export function incompleteCallResult(call: Pick<ToolCall, 'name'>, outputLimited: boolean): string {
  if (outputLimited) {
    return (
      `Not run: your reply reached the output limit while the arguments for ${call.name} were still ` +
      'being written, so they arrived incomplete and nothing was executed. Do the work in smaller ' +
      'pieces: change an existing file with edit_file or apply_patch instead of rewriting it whole, ' +
      'and write a large new file in parts (create it with the first part, then add the rest with ' +
      'edits) instead of in one call.'
    )
  }
  return (
    `Not run: the arguments for ${call.name} were not valid JSON, so nothing was executed. ` +
    'Call the tool again with a complete JSON object of arguments.'
  )
}

/**
 * The system note that asks the model to pick up a reply the output limit cut off.
 * `hadText` is false when the reply produced no visible text at all (it spent the limit
 * reasoning), where "continue where you stopped" has nothing to point at.
 */
export function continuationNote(hadText: boolean): string {
  return hadText
    ? 'Your previous reply was cut off at the output limit. Continue exactly where it stopped, ' +
        'mid-sentence or mid-code-block if that is where the cut fell. Do not repeat or recap ' +
        'anything you already wrote, and do not apologize.'
    : 'Your previous reply reached the output limit before it produced any answer. Answer now, ' +
        'and keep your reasoning brief.'
}

/** The user-facing notice for an automatic continuation. */
export function continuationNotice(attempt: number): string {
  return `The reply reached the model's output limit, so Houston asked it to continue (${attempt}/${MAX_OUTPUT_CONTINUATIONS}).`
}

/**
 * The user-facing notice for tool calls the output limit cut off. The names are the
 * model's, and the terminal clients print notices as they are, so anything outside the
 * characters a tool name uses is dropped: a name can't carry an escape sequence through.
 */
export function incompleteCallsNotice(calls: Pick<ToolCall, 'name'>[]): string {
  const names = [...new Set(calls.map((c) => c.name.replace(/[^\w.:-]/g, '') || 'tool'))]
  const what = names.length === 1 ? `a ${names[0]} call` : `calls to ${names.join(', ')}`
  return `The reply reached the model's output limit while writing ${what}, so it was not run. Houston asked the model to split the work into smaller steps.`
}

/**
 * The request cap for a turn after the run has hit the output limit: the model's full
 * ceiling, where it's known. Empty otherwise, which leaves the adapter's default: for a
 * model without a tabled ceiling there's no safe larger number to ask for, and the OpenAI
 * and Gemini adapters send no cap at all, so their replies already run to the model's
 * maximum. Recomputed per request so a fallback hop asks for the new model's ceiling.
 */
export function raisedOutputCap(model: string): { maxTokens?: number } {
  const ceiling = maxOutputTokensFor(model)
  return ceiling ? { maxTokens: ceiling } : {}
}
