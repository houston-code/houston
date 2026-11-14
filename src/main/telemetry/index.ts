import type { TelemetrySettings } from '@shared/types'
import { version as APP_VERSION } from '../../../package.json'
import { resolveTelemetryConfig } from './config'
import { telemetrySdk } from './otel'
import { startRunTelemetry, type RunTelemetry, type RunTelemetryOptions } from './runTelemetry'

export { shutdownTelemetry } from './otel'
export type { RunTelemetry } from './runTelemetry'

/**
 * Telemetry for one run, or undefined when export is off (the default: no endpoint set,
 * or OTEL_SDK_DISABLED=true). `flush` exports what the run buffered, bounded in time.
 */
export function runTelemetryFor(
  settings: TelemetrySettings | undefined,
  opts: Omit<RunTelemetryOptions, 'tracer' | 'meter' | 'includeContent'>,
  env: NodeJS.ProcessEnv = process.env
): (RunTelemetry & { flush(): Promise<void> }) | undefined {
  const config = resolveTelemetryConfig(settings, env)
  if (!config) return undefined
  const sdk = telemetrySdk(config, APP_VERSION)
  if (!sdk) return undefined
  const run = startRunTelemetry({ ...opts, tracer: sdk.tracer, meter: sdk.meter, includeContent: config.includeContent })
  return { ...run, flush: () => sdk.flush() }
}
