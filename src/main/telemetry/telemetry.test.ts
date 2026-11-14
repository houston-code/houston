import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics'
import type { AgentEvent } from '@shared/agent'
import { resolveTelemetryConfig } from './config'
import { MAX_CONTENT_CHARS, startRunTelemetry } from './runTelemetry'
import { runTelemetryFor, shutdownTelemetry } from './index'

describe('resolveTelemetryConfig', () => {
  it('is off without an endpoint', () => {
    expect(resolveTelemetryConfig(undefined, {})).toBeNull()
    expect(resolveTelemetryConfig({ includeContent: true }, {})).toBeNull()
  })

  it('reads the setting, then the standard env var, as an OTLP/HTTP base', () => {
    expect(resolveTelemetryConfig({ otlpEndpoint: 'http://collector:4318/' }, {})).toEqual({
      tracesUrl: 'http://collector:4318/v1/traces',
      metricsUrl: 'http://collector:4318/v1/metrics',
      includeContent: false
    })
    expect(resolveTelemetryConfig(undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example' })).toMatchObject({
      tracesUrl: 'https://otel.example/v1/traces'
    })
    // The setting wins over the env var.
    expect(
      resolveTelemetryConfig({ otlpEndpoint: 'http://a:4318' }, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://b:4318' })?.tracesUrl
    ).toBe('http://a:4318/v1/traces')
  })

  it('takes per-signal env endpoints as full URLs, and exports only what is named', () => {
    expect(resolveTelemetryConfig(undefined, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://t:4318/x' })).toEqual({
      tracesUrl: 'http://t:4318/x',
      includeContent: false
    })
    expect(resolveTelemetryConfig(undefined, { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://m:4318/y' })).toEqual({
      metricsUrl: 'http://m:4318/y',
      includeContent: false
    })
  })

  it('turns content on only with the setting', () => {
    expect(resolveTelemetryConfig({ otlpEndpoint: 'http://a:4318', includeContent: true }, {})?.includeContent).toBe(true)
    expect(resolveTelemetryConfig({ otlpEndpoint: 'http://a:4318' }, { OTEL_INCLUDE_CONTENT: 'true' })?.includeContent).toBe(false)
  })

  it('ignores anything that is not an http(s) URL, and honors OTEL_SDK_DISABLED', () => {
    expect(resolveTelemetryConfig({ otlpEndpoint: 'file:///etc/passwd' }, {})).toBeNull()
    expect(resolveTelemetryConfig({ otlpEndpoint: 'not a url' }, {})).toBeNull()
    expect(resolveTelemetryConfig({ otlpEndpoint: 'http://a:4318' }, { OTEL_SDK_DISABLED: 'TRUE' })).toBeNull()
  })
})

const SECRET = 'sk-live-telemetry-secret-0123456789'
const redact = (s: string): string => s.replaceAll(SECRET, '[redacted:secret]')

function harness(includeContent: boolean) {
  const spans = new InMemorySpanExporter()
  const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] })
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 60_000 })
  const meterProvider = new MeterProvider({ readers: [reader] })
  let t = 1_000
  const tel = startRunTelemetry({
    tracer: tracerProvider.getTracer('test'),
    meter: meterProvider.getMeter('test'),
    redact,
    includeContent,
    runId: 'run-1',
    conversationId: 'conv-1',
    providerId: 'anthropic',
    model: 'claude-test',
    prompt: `deploy with ${SECRET}`,
    now: () => (t += 100)
  })
  const ev = (e: Record<string, unknown>): void => tel.onEvent({ runId: 'run-1', ...e } as AgentEvent)
  const metricNames = async (): Promise<Map<string, unknown[]>> => {
    await reader.forceFlush()
    const out = new Map<string, unknown[]>()
    for (const rm of metrics.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics) out.set(m.descriptor.name, m.dataPoints as unknown[])
    return out
  }
  const finished = async (): Promise<ReadableSpan[]> => {
    await tracerProvider.forceFlush()
    return spans.getFinishedSpans()
  }
  return { tel, ev, spans: finished, metricNames }
}

function playRun(ev: (e: Record<string, unknown>) => void, tel: ReturnType<typeof harness>['tel']): void {
  tel.requestStart('claude-test')
  ev({ type: 'usage', inputTokens: 120, outputTokens: 30, cost: 0.002, model: 'claude-test' })
  ev({ type: 'tool_start', callId: 'c1', name: 'run_shell', args: { command: `echo ${SECRET}` }, kind: 'shell' })
  ev({ type: 'tool_result', callId: 'c1', name: 'run_shell', ok: false, output: `token ${SECRET}` })
  tel.requestStart('claude-test')
  ev({ type: 'usage', inputTokens: 200, outputTokens: 10, cost: 0.001, model: 'claude-test' })
  ev({ type: 'done', stopReason: 'end_turn' })
  tel.end()
}

describe('startRunTelemetry', () => {
  it('exports a run span with model-request and tool-call children, named by the GenAI conventions', async () => {
    const { tel, ev, spans } = harness(false)
    playRun(ev, tel)
    const all = (await spans())
    const run = all.find((s) => s.name === 'invoke_agent houston')!
    expect(run.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-test',
      'gen_ai.conversation.id': 'conv-1',
      'houston.stop_reason': 'end_turn'
    })
    const chats = all.filter((s) => s.name === 'chat claude-test')
    expect(chats).toHaveLength(2)
    expect(chats[0].attributes).toMatchObject({ 'gen_ai.usage.input_tokens': 120, 'gen_ai.usage.output_tokens': 30 })
    const tool = all.find((s) => s.name === 'execute_tool run_shell')!
    expect(tool.attributes).toMatchObject({ 'gen_ai.tool.name': 'run_shell', 'gen_ai.tool.call.id': 'c1' })
    expect(tool.status.code).toBe(2) // ERROR: the call failed
    for (const child of [...chats, tool]) expect(child.parentSpanContext?.spanId).toBe(run.spanContext().spanId)
  })

  it('exports no prompt or tool content unless content is on', async () => {
    const { tel, ev, spans } = harness(false)
    playRun(ev, tel)
    const text = JSON.stringify((await spans()).map((s) => s.attributes))
    expect(text).not.toContain('deploy with')
    expect(text).not.toContain('echo')
    expect(text).not.toContain('redacted')
    expect(text).not.toContain(SECRET)
  })

  it('with content on, exports it redacted and capped', async () => {
    const { tel, ev, spans } = harness(true)
    playRun(ev, tel)
    const all = (await spans())
    const text = JSON.stringify(all.map((s) => s.attributes))
    expect(text).not.toContain(SECRET)
    expect(all.find((s) => s.name.startsWith('invoke_agent'))!.attributes['houston.prompt']).toBe('deploy with [redacted:secret]')
    const tool = all.find((s) => s.name === 'execute_tool run_shell')!
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBe('{"command":"echo [redacted:secret]"}')
    expect(tool.attributes['gen_ai.tool.call.result']).toBe('token [redacted:secret]')

    const big = harness(true)
    big.ev({ type: 'tool_start', callId: 'c2', name: 'read_file', args: {} })
    big.ev({ type: 'tool_result', callId: 'c2', name: 'read_file', ok: true, output: 'x'.repeat(MAX_CONTENT_CHARS * 2) })
    big.tel.end()
    const result = String((await big.spans()).find((s) => s.name === 'execute_tool read_file')!.attributes['gen_ai.tool.call.result'])
    expect(result.length).toBe(MAX_CONTENT_CHARS + 1)
  })

  it('records token, cost, tool-call and run-duration metrics', async () => {
    const { tel, ev, metricNames } = harness(false)
    playRun(ev, tel)
    const m = await metricNames()
    expect([...m.keys()].sort()).toEqual(
      ['gen_ai.client.operation.duration', 'gen_ai.client.token.usage', 'houston.cost', 'houston.run.duration', 'houston.tool.calls'].sort()
    )
    const tokens = m.get('gen_ai.client.token.usage') as { attributes: Record<string, unknown>; value: { sum: number } }[]
    const sum = (type: string): number =>
      tokens.filter((d) => d.attributes['gen_ai.token.type'] === type).reduce((n, d) => n + d.value.sum, 0)
    expect(sum('input')).toBe(320)
    expect(sum('output')).toBe(40)
    const calls = m.get('houston.tool.calls') as { attributes: Record<string, unknown>; value: number }[]
    expect(calls).toEqual([expect.objectContaining({ attributes: { 'gen_ai.tool.name': 'run_shell', 'houston.tool.ok': false }, value: 1 })])
  })

  it('marks an errored run and counts the error by class', async () => {
    const { tel, ev, spans, metricNames } = harness(false)
    tel.requestStart('claude-test')
    ev({ type: 'error', message: `bad key ${SECRET}`, cause: 'auth' })
    tel.end()
    tel.end() // idempotent
    const run = (await spans()).find((s) => s.name.startsWith('invoke_agent'))!
    // The message can quote content, so without content on only the class goes out.
    expect(run.status).toEqual({ code: 2 })
    expect(run.attributes['error.type']).toBe('auth')
    expect((await spans()).filter((s) => s.name.startsWith('invoke_agent'))).toHaveLength(1)
    const errors = (await metricNames()).get('houston.run.errors') as { attributes: Record<string, unknown>; value: number }[]
    expect(errors[0]).toMatchObject({ value: 1, attributes: { 'error.type': 'auth' } })
  })

  it('with content on, an error keeps its message, redacted', async () => {
    const { tel, ev, spans } = harness(true)
    ev({ type: 'error', message: `bad key ${SECRET}`, cause: 'auth' })
    tel.end()
    const run = (await spans()).find((s) => s.name.startsWith('invoke_agent'))!
    expect(run.status).toEqual({ code: 2, message: 'bad key [redacted:secret]' })
  })

  it('ends a request cut off by a retry as an error, and spans still open at the end', async () => {
    const { tel, ev, spans } = harness(false)
    tel.requestStart('claude-test')
    ev({ type: 'retry', attempt: 1, message: 'Overloaded' })
    ev({ type: 'tool_start', callId: 'c9', name: 'run_shell', args: {} })
    tel.end()
    const chat = (await spans()).find((s) => s.name === 'chat claude-test')!
    expect(chat.status.code).toBe(2)
    expect((await spans()).some((s) => s.name === 'execute_tool run_shell')).toBe(true)
  })
})

describe('runTelemetryFor (OTLP over HTTP)', () => {
  let server: Server | undefined
  afterEach(async () => {
    await shutdownTelemetry()
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    server = undefined
  })

  it('returns nothing when export is off', () => {
    expect(runTelemetryFor(undefined, { redact, runId: 'r', providerId: 'p', model: 'm' }, {})).toBeUndefined()
  })

  it('posts spans and metrics to the configured endpoint, with secrets redacted', async () => {
    const got: { url: string; body: string }[] = []
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        got.push({ url: req.url ?? '', body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    const tel = runTelemetryFor(
      { otlpEndpoint: `http://127.0.0.1:${port}`, includeContent: true },
      { redact, runId: 'r1', providerId: 'anthropic', model: 'claude-test', prompt: `use ${SECRET}` },
      {}
    )!
    expect(tel).toBeDefined()
    tel.requestStart('claude-test')
    tel.onEvent({ runId: 'r1', type: 'usage', inputTokens: 5, outputTokens: 1, cost: 0 } as AgentEvent)
    tel.end()
    await tel.flush()
    const paths = got.map((g) => g.url).sort()
    expect(paths).toContain('/v1/traces')
    expect(paths).toContain('/v1/metrics')
    const traces = got.find((g) => g.url === '/v1/traces')!.body
    expect(traces).toContain('invoke_agent houston')
    expect(traces).toContain('[redacted:secret]')
    expect(got.map((g) => g.body).join('')).not.toContain(SECRET)
  }, 20_000)
})
