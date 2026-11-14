/**
 * W3C trace context for MCP requests. The MCP spec reserves the `_meta` keys
 * `traceparent`, `tracestate` and `baggage` for OpenTelemetry propagation, so a server
 * that traces can join the caller's trace.
 *
 * Houston has no tracer yet, so nothing is propagated today: this is the seam one plugs
 * into. {@link setTraceContextProvider} registers a function that returns the active
 * span's context (or nothing), and every MCP request then carries it. Values are
 * checked against the W3C formats first, so a provider can never put arbitrary text
 * on the wire.
 */

/** The active span's propagation fields, as W3C Trace Context and Baggage define them. */
export interface TraceContext {
  traceparent?: string
  tracestate?: string
  baggage?: string
}

type Provider = () => TraceContext | undefined

let provider: Provider = () => undefined

/** Register where the active span's context comes from (null: back to no tracing). */
export function setTraceContextProvider(fn: Provider | null): void {
  provider = fn ?? (() => undefined)
}

/** `version-traceid-parentid-flags`, lowercase hex; an all-zero trace or parent id is invalid. */
const TRACEPARENT = /^[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/
/** Header-safe text, within the W3C size limits. */
const SAFE_LIST = /^[\x20-\x7e]*$/

/** The active trace context, or nothing when there is no span or it is malformed. */
export function activeTraceContext(): TraceContext | undefined {
  let ctx: TraceContext | undefined
  try {
    ctx = provider()
  } catch {
    return undefined // a tracer's failure never fails a request
  }
  if (!ctx || typeof ctx.traceparent !== 'string' || !TRACEPARENT.test(ctx.traceparent) || ctx.traceparent.startsWith('ff')) {
    return undefined
  }
  const out: TraceContext = { traceparent: ctx.traceparent }
  if (typeof ctx.tracestate === 'string' && ctx.tracestate.length <= 512 && SAFE_LIST.test(ctx.tracestate)) {
    out.tracestate = ctx.tracestate
  }
  if (typeof ctx.baggage === 'string' && ctx.baggage.length <= 8192 && SAFE_LIST.test(ctx.baggage)) out.baggage = ctx.baggage
  return out
}

/**
 * `params` with the active trace context in `_meta`, keeping whatever `_meta` holds
 * already. Unchanged (the same object) when there is no active span.
 */
export function withTraceContext(params: unknown): unknown {
  const ctx = activeTraceContext()
  if (!ctx) return params
  const base = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
  const existing = base._meta && typeof base._meta === 'object' ? (base._meta as Record<string, unknown>) : {}
  return { ...base, _meta: { ...existing, ...ctx } }
}
