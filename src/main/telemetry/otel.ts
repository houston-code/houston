import type { Meter, Tracer } from '@opentelemetry/api'
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { log } from '../logger'
import type { TelemetryConfig } from './config'

/**
 * The process's OpenTelemetry SDK, built on the first run that has telemetry turned on
 * and rebuilt when the endpoints change. Exporters are OTLP over HTTP; any headers
 * (an auth token, say) come from the standard `OTEL_EXPORTER_OTLP_HEADERS` variables,
 * which the exporters read themselves, so no credential is kept in settings.
 *
 * The providers here are local to Houston, not registered as the global ones, so a
 * library that happens to use the OpenTelemetry API exports nothing through them.
 */

export interface TelemetrySdk {
  tracer: Tracer
  meter: Meter
  /** Export what's buffered, bounded so a dead endpoint can't hold up a run's end. */
  flush(): Promise<void>
  shutdown(): Promise<void>
}

/** How long a flush may take before the run gives up waiting on it. */
export const FLUSH_TIMEOUT_MS = 3_000

let current: { key: string; sdk: TelemetrySdk } | undefined

function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
    p.then(
      () => {
        clearTimeout(t)
        resolve()
      },
      (e) => {
        clearTimeout(t)
        log.warn(`telemetry export failed: ${(e as Error)?.message ?? String(e)}`)
        resolve()
      }
    )
  })
}

function build(config: TelemetryConfig, version: string): TelemetrySdk {
  const resource = resourceFromAttributes({ 'service.name': 'houston', 'service.version': version })
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: config.tracesUrl ? [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: config.tracesUrl }) })] : []
  })
  const meterProvider = new MeterProvider({
    resource,
    readers: config.metricsUrl
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: config.metricsUrl }),
            exportIntervalMillis: 60_000
          })
        ]
      : []
  })
  return {
    tracer: tracerProvider.getTracer('houston', version),
    meter: meterProvider.getMeter('houston', version),
    flush: () =>
      withTimeout(Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]), FLUSH_TIMEOUT_MS),
    shutdown: () => withTimeout(Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]), FLUSH_TIMEOUT_MS)
  }
}

/** The SDK for this config, building (or rebuilding) it as needed. Never throws. */
export function telemetrySdk(config: TelemetryConfig, version: string): TelemetrySdk | null {
  const key = JSON.stringify([config.tracesUrl, config.metricsUrl, version])
  if (current?.key === key) return current.sdk
  try {
    const old = current?.sdk
    const sdk = build(config, version)
    current = { key, sdk }
    if (old) void old.shutdown()
    log.info(
      `telemetry: exporting${config.tracesUrl ? ' traces' : ''}${config.metricsUrl ? ' metrics' : ''} over OTLP` +
        `${config.includeContent ? ', with content' : ''}`
    )
    return sdk
  } catch (e) {
    log.warn(`telemetry: could not start the exporter: ${(e as Error)?.message ?? String(e)}`)
    return null
  }
}

/** Shut the SDK down (flushing what it holds), e.g. before the process exits. */
export async function shutdownTelemetry(): Promise<void> {
  const sdk = current?.sdk
  current = undefined
  if (sdk) await sdk.shutdown()
}
