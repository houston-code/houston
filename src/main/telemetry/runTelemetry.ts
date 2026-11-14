import { SpanKind, SpanStatusCode, context, trace, type Attributes, type Meter, type Span, type Tracer } from '@opentelemetry/api'
import type { AgentEvent } from '@shared/agent'

/**
 * One agent run's OpenTelemetry: a run span (`invoke_agent houston`) with a child span
 * per model request (`chat <model>`) and per tool call (`execute_tool <tool>`), plus
 * metrics for tokens, cost, tool calls, run durations and errors. Attribute names
 * follow the OpenTelemetry GenAI semantic conventions (`gen_ai.*`); Houston's own
 * metrics are named `houston.*`.
 *
 * WHAT IS EXPORTED. Names, ids, counts, durations, and error classes. Prompt text, tool
 * arguments and results, and error messages (which can quote either) only when the user
 * turned `includeContent` on. Every
 * string attribute goes through `redact`, the run's secret scrubber, first.
 *
 * Fed from the loop's event stream (`onEvent`), plus `requestStart` at each provider
 * call, since no event marks a request's start.
 */

/** Longest content attribute exported when content is on. */
export const MAX_CONTENT_CHARS = 4_000

export interface RunTelemetryOptions {
  tracer: Tracer
  meter: Meter
  redact: (s: string) => string
  includeContent: boolean
  runId: string
  conversationId?: string
  providerId: string
  model: string
  /** The prompt that started the run; exported only with includeContent. */
  prompt?: string
  now?: () => number
}

export interface RunTelemetry {
  onEvent(e: AgentEvent): void
  /** A provider request is starting (the previous one, if still open, ends). */
  requestStart(model: string, providerId?: string): void
  /** The run is over; ends anything still open. Idempotent. */
  end(): void
}

interface Instruments {
  tokens: ReturnType<Meter['createHistogram']>
  opDuration: ReturnType<Meter['createHistogram']>
  cost: ReturnType<Meter['createCounter']>
  toolCalls: ReturnType<Meter['createCounter']>
  runDuration: ReturnType<Meter['createHistogram']>
  errors: ReturnType<Meter['createCounter']>
}

const instrumentsByMeter = new WeakMap<Meter, Instruments>()

function instruments(meter: Meter): Instruments {
  let i = instrumentsByMeter.get(meter)
  if (!i) {
    i = {
      tokens: meter.createHistogram('gen_ai.client.token.usage', {
        unit: '{token}',
        description: 'Tokens used per model request'
      }),
      opDuration: meter.createHistogram('gen_ai.client.operation.duration', {
        unit: 's',
        description: 'Duration of a model request'
      }),
      cost: meter.createCounter('houston.cost', { unit: 'USD', description: 'Estimated model cost' }),
      toolCalls: meter.createCounter('houston.tool.calls', { unit: '{call}', description: 'Tool calls run' }),
      runDuration: meter.createHistogram('houston.run.duration', { unit: 's', description: 'Agent run duration' }),
      errors: meter.createCounter('houston.run.errors', { unit: '{error}', description: 'Agent runs that ended in an error' })
    }
    instrumentsByMeter.set(meter, i)
  }
  return i
}

export function startRunTelemetry(opts: RunTelemetryOptions): RunTelemetry {
  const now = opts.now ?? Date.now
  const ins = instruments(opts.meter)
  const s = (v: string): string => {
    try {
      return opts.redact(v)
    } catch {
      return '[redaction failed]'
    }
  }
  const content = (v: string): string => s(v.length > MAX_CONTENT_CHARS ? `${v.slice(0, MAX_CONTENT_CHARS)}…` : v)
  const started = now()
  const base: Attributes = {
    'gen_ai.provider.name': s(opts.providerId),
    'gen_ai.agent.name': 'houston',
    ...(opts.conversationId ? { 'gen_ai.conversation.id': s(opts.conversationId) } : {})
  }
  const runSpan: Span = opts.tracer.startSpan('invoke_agent houston', {
    kind: SpanKind.INTERNAL,
    startTime: started,
    attributes: {
      ...base,
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.request.model': s(opts.model),
      'houston.run.id': s(opts.runId),
      ...(opts.includeContent && opts.prompt ? { 'houston.prompt': content(opts.prompt) } : {})
    }
  })
  const parent = trace.setSpan(context.active(), runSpan)

  let request: { span: Span; model: string; providerId: string; at: number } | undefined
  const tools = new Map<string, { span: Span; name: string }>()
  let ended = false
  let failed: string | undefined

  const endRequest = (): void => {
    if (!request) return
    ins.opDuration.record((now() - request.at) / 1000, {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': request.providerId,
      'gen_ai.request.model': request.model
    })
    request.span.end(now())
    request = undefined
  }

  return {
    requestStart(model, providerId = opts.providerId) {
      if (ended) return
      endRequest()
      const at = now()
      const m = s(model)
      const p = s(providerId)
      request = {
        model: m,
        providerId: p,
        at,
        span: opts.tracer.startSpan(
          `chat ${m}`,
          {
            kind: SpanKind.CLIENT,
            startTime: at,
            attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': p, 'gen_ai.request.model': m }
          },
          parent
        )
      }
    },

    onEvent(e) {
      if (ended) return
      switch (e.type) {
        case 'usage': {
          const model = s(e.model ?? request?.model ?? opts.model)
          const attrs = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': request?.providerId ?? s(opts.providerId), 'gen_ai.request.model': model }
          ins.tokens.record(e.inputTokens, { ...attrs, 'gen_ai.token.type': 'input' })
          ins.tokens.record(e.outputTokens, { ...attrs, 'gen_ai.token.type': 'output' })
          if (e.cost > 0) ins.cost.add(e.cost, attrs)
          if (request) {
            request.span.setAttributes({
              'gen_ai.response.model': model,
              'gen_ai.usage.input_tokens': e.inputTokens,
              'gen_ai.usage.output_tokens': e.outputTokens,
              ...(e.cacheReadTokens ? { 'gen_ai.usage.cache_read.input_tokens': e.cacheReadTokens } : {}),
              ...(e.cacheWriteTokens ? { 'gen_ai.usage.cache_creation.input_tokens': e.cacheWriteTokens } : {}),
              'houston.cost': e.cost
            })
            endRequest()
          }
          return
        }
        case 'retry':
          if (request) {
            request.span.setStatus({ code: SpanStatusCode.ERROR, ...(opts.includeContent ? { message: content(e.message) } : {}) })
            request.span.setAttribute('error.type', 'retry')
            endRequest()
          }
          return
        case 'tool_start': {
          const name = s(e.name)
          const span = opts.tracer.startSpan(
            `execute_tool ${name}`,
            {
              kind: SpanKind.INTERNAL,
              startTime: now(),
              attributes: {
                'gen_ai.operation.name': 'execute_tool',
                'gen_ai.tool.name': name,
                'gen_ai.tool.call.id': s(e.callId),
                ...(e.kind ? { 'houston.tool.kind': e.kind } : {}),
                ...(opts.includeContent ? { 'gen_ai.tool.call.arguments': content(JSON.stringify(e.args ?? {})) } : {})
              }
            },
            parent
          )
          tools.get(e.callId)?.span.end(now())
          tools.set(e.callId, { span, name })
          return
        }
        case 'tool_result': {
          const open = tools.get(e.callId)
          const name = open?.name ?? s(e.name)
          ins.toolCalls.add(1, { 'gen_ai.tool.name': name, 'houston.tool.ok': e.ok })
          if (open) {
            if (!e.ok) open.span.setStatus({ code: SpanStatusCode.ERROR })
            if (opts.includeContent) open.span.setAttribute('gen_ai.tool.call.result', content(e.output))
            open.span.end(now())
            tools.delete(e.callId)
          }
          return
        }
        case 'error':
          failed = e.cause ?? 'error'
          runSpan.setStatus({ code: SpanStatusCode.ERROR, ...(opts.includeContent ? { message: content(e.message) } : {}) })
          runSpan.setAttribute('error.type', s(failed))
          return
        case 'done':
          runSpan.setAttribute('houston.stop_reason', e.stopReason)
          return
        default:
          return
      }
    },

    end() {
      if (ended) return
      ended = true
      endRequest()
      for (const { span } of tools.values()) span.end(now())
      tools.clear()
      const seconds = (now() - started) / 1000
      ins.runDuration.record(seconds, { ...base, outcome: failed ? 'error' : 'ok' })
      if (failed) ins.errors.add(1, { ...base, 'error.type': s(failed) })
      runSpan.end(now())
    }
  }
}
