/**
 * Parse a tool call's streamed argument JSON. An empty string is a call with no
 * arguments. Returns null when the text isn't a JSON object, which in practice means the
 * reply stopped mid-call: the adapter then marks the call `incomplete` instead of running
 * it with silently missing arguments.
 */
export function parseToolArguments(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
