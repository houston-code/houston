import type { TelemetrySettings } from '@shared/types'

/**
 * Whether, and where, Houston exports OpenTelemetry. Off unless the user names an OTLP
 * endpoint, in Settings (`telemetry.otlpEndpoint` in settings.json) or with the
 * standard `OTEL_EXPORTER_OTLP_*` environment variables. `OTEL_SDK_DISABLED=true` turns
 * it off whatever else is set. Pure, so it can be tested without the SDK.
 */
export interface TelemetryConfig {
  /** Full URL spans are posted to (OTLP/HTTP, JSON or protobuf per the exporter). */
  tracesUrl?: string
  /** Full URL metrics are posted to. */
  metricsUrl?: string
  /** Put prompt text and tool arguments and results on spans (redacted). Off by default. */
  includeContent: boolean
}

/** A trimmed http(s) URL, or undefined for anything else (a typo never exports somewhere odd). */
function httpUrl(v: string | undefined): string | undefined {
  const t = v?.trim()
  if (!t) return undefined
  try {
    const u = new URL(t)
    return u.protocol === 'http:' || u.protocol === 'https:' ? t : undefined
  } catch {
    return undefined
  }
}

/** `base` + `/v1/<signal>`, the OTLP/HTTP convention for a base endpoint. */
function signalUrl(base: string, signal: 'traces' | 'metrics'): string {
  return `${base.replace(/\/+$/, '')}/v1/${signal}`
}

export function resolveTelemetryConfig(
  settings: TelemetrySettings | undefined,
  env: NodeJS.ProcessEnv = process.env
): TelemetryConfig | null {
  if ((env.OTEL_SDK_DISABLED ?? '').trim().toLowerCase() === 'true') return null
  const base = httpUrl(settings?.otlpEndpoint) ?? httpUrl(env.OTEL_EXPORTER_OTLP_ENDPOINT)
  const tracesUrl = httpUrl(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) ?? (base ? signalUrl(base, 'traces') : undefined)
  const metricsUrl = httpUrl(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) ?? (base ? signalUrl(base, 'metrics') : undefined)
  if (!tracesUrl && !metricsUrl) return null
  return {
    ...(tracesUrl ? { tracesUrl } : {}),
    ...(metricsUrl ? { metricsUrl } : {}),
    includeContent: settings?.includeContent === true
  }
}
