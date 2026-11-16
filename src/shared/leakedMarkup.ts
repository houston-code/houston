/**
 * A string value that STARTS or ENDS with fragments of the model's own tool-call
 * syntax rather than the value itself. Two shapes have been seen in real sessions:
 *
 *  - an ask_user option `<parameter name="label">AI image generation`, where the
 *    model began writing XML-style parameters inside a JSON array. It was shown to
 *    the user verbatim as an answer choice.
 *  - a multi_edit `edits` array of bare strings whose first item was
 *    `[{"old_string">  const { login } = useAuth();`, i.e. a JSON object with its
 *    `":` replaced by `">`. It failed later with a misleading "old_string must not
 *    be empty".
 *
 * Anchored to the start/end of the value so file content that merely MENTIONS such
 * markup mid-text (docs, tests, a parser) still passes; only a value that is itself
 * garbled is caught. Shared by the argument validator, which refuses such a call, and
 * the scorecard's failure signals, which count one that ran anyway.
 */
const LEAKED_MARKUP_START = /^\s*(?:<\/?(?:parameter|invoke|function_calls)\b|\[?\s*\{\s*"[A-Za-z_]\w*"\s*>)/
const LEAKED_MARKUP_END = /<\/(?:parameter|invoke|function_calls)>\s*$/

/** Max nesting walked when scanning argument values, so a pathological payload stays cheap. */
const MAX_SCAN_DEPTH = 6

/**
 * The top-level argument key whose value (or any string nested inside it) carries
 * leaked tool-call markup, or null when none does.
 */
export function findLeakedMarkup(args: Record<string, unknown>): string | null {
  const garbled = (v: unknown, depth: number): boolean => {
    if (typeof v === 'string') return LEAKED_MARKUP_START.test(v) || LEAKED_MARKUP_END.test(v)
    if (depth >= MAX_SCAN_DEPTH || v === null || typeof v !== 'object') return false
    const values = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)
    return values.some((x) => garbled(x, depth + 1))
  }
  for (const [key, v] of Object.entries(args)) {
    if (garbled(v, 0)) return key
  }
  return null
}
