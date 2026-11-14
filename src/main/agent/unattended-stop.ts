/**
 * An unattended run (headless, or an ACP session launched with `--unattended`) has
 * nobody to read its reply and answer. A model that ends its turn on "Next I'll
 * write the solver" or "Should I bridge the hook, or stop here?" has stopped with
 * the work undone, and on an attended run that is a fine place to hand back; here
 * it ends the run. This spots that shape in the final message, so the loop can
 * send the turn back with a note, a bounded number of times.
 *
 * The check is deliberately cheap and a little eager: a false positive costs one
 * extra turn in which the model says it is done, while a miss ends the run early.
 */

/** Most times one turn is sent back for ending on undone work. */
export const MAX_UNATTENDED_STOP_CONTINUATIONS = 2

/** How much of the end of the reply is read: the closing paragraph or two. */
const TAIL_CHARS = 700

const UNFINISHED_PATTERNS: RegExp[] = [
  // Announcing work still to do.
  /\bnext,?\s+(?:i(?:'|’)ll|i\s+will|i\s+need\s+to|i\s+can)\b/i,
  /\bnext\s+steps?\s*(?::|is|are|would\s+be)/i,
  /\bi(?:'|’)ll\s+(?:now|next|then)\b/i,
  /\bi\s+(?:still\s+)?(?:need|have)\s+to\s+(?:write|add|implement|run|finish|fix|build|create|verify|check)\b/i,
  /\b(?:remaining|still\s+to\s+do|not\s+(?:yet\s+)?(?:done|implemented|written))\s*:/i,
  // Handing a decision back to someone who isn't there.
  /\b(?:let\s+me\s+know|tell\s+me|would\s+you\s+like|do\s+you\s+want|want\s+me\s+to|should\s+i|shall\s+i|if\s+you(?:'|’)d\s+like|if\s+you\s+want\s+me)\b/i,
  /\b(?:option|choice)\s+[1-3a-c]\b/i
]

/** Whether a final reply ends on work announced but not done, or a question to the user. */
export function endsOnUndoneWork(reply: string): boolean {
  const tail = reply.trim().slice(-TAIL_CHARS)
  if (!tail) return false
  if (/\?\s*(?:[*_`)\]]+\s*)?$/.test(tail)) return true
  return UNFINISHED_PATTERNS.some((p) => p.test(tail))
}

/** The note that sends the turn back. */
export const UNATTENDED_STOP_NOTE =
  'Nobody is attending this run: no one will read that message or reply before the run ends, so ending your turn now ends the task. ' +
  'If work remains (a step you announced, a question you asked, options you offered), make the call yourself and do it now. ' +
  'End your turn only when the task is done, or when nothing more can be done; then say what you did, how you checked it, and what is left.'
