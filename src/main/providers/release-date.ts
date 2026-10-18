/**
 * A listing's creation time as a `YYYY-MM-DD` date: OpenAI-style hosts report `created`
 * as unix seconds, Anthropic reports `created_at` as an ISO string. Anything else, or a
 * value before 2015 (placeholder zeros some proxies send), is undefined. Shared by the
 * OpenAI-style and Anthropic listings.
 */
export function releaseDateFrom(v: unknown): string | undefined {
  const ms = typeof v === 'number' ? v * 1000 : typeof v === 'string' ? Date.parse(v) : NaN
  if (!Number.isFinite(ms) || ms < Date.UTC(2015, 0, 1)) return undefined
  return new Date(ms).toISOString().slice(0, 10)
}
