/**
 * How a blocking prompt (an approval, an `ask_user` question, a plan review) ended,
 * in words for the person reading the transcript.
 *
 * The loop answers the model in the model's terms ("Denied by the user. They said:
 * …", "[The user stopped the agent without answering.]", "The user REJECTED this
 * plan. Do not make any changes…"). Those strings are instructions to the model.
 * Shown verbatim they read as something the user said, under an "Answered" label or
 * a "Denied by the user" line, when the user had only pressed Stop. The constants
 * live here so the loop that writes them and the clients that recognize them can't
 * drift apart.
 */

/** The `ask_user` result when the user stopped the run before answering. */
export const QUESTION_STOPPED_ANSWER = '[The user stopped the agent without answering.]'

/** The `ask_user` result when the user submitted an empty answer. */
export const QUESTION_EMPTY_ANSWER = '[The user did not provide an answer.]'

/** The denial note on an approval that was still open when the user stopped the run. */
export const APPROVAL_INTERRUPTED_NOTE = 'The user interrupted the run before answering this prompt.'

/** A short user-facing line for a prompt the run was stopped in front of, or null. */
export function stoppedPromptText(output: string | undefined): string | null {
  if (!output) return null
  if (output === QUESTION_STOPPED_ANSWER) return 'Not answered: the run was stopped.'
  if (output.endsWith(APPROVAL_INTERRUPTED_NOTE)) return 'Not run: the run was stopped before it was approved.'
  return null
}

/** Whether an `ask_user` result means the question went unanswered. */
export function isUnansweredQuestion(answer: string | undefined): boolean {
  return answer === QUESTION_STOPPED_ANSWER || answer === QUESTION_EMPTY_ANSWER
}

/** The outcome of a plan review, read from the `present_plan` tool result. */
export type PlanOutcome = 'accepted' | 'rejected' | 'superseded'

/** Derive a plan's outcome from the `present_plan` tool-result text. */
export function planOutcome(output: string | undefined): PlanOutcome {
  if (output?.startsWith('The user ACCEPTED')) return 'accepted'
  if (output?.startsWith('The user REJECTED')) return 'rejected'
  // No result, or a "wants changes" result: the plan is no longer actionable.
  return 'superseded'
}

/** The plan outcome as a short label for a transcript line. */
export const PLAN_OUTCOME_LABEL: Record<PlanOutcome, string> = {
  accepted: 'Plan accepted',
  rejected: 'Plan rejected',
  superseded: 'Changes requested'
}
