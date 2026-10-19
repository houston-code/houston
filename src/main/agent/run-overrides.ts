import type { RunSettingsOverrides } from '@shared/agent'
import type { AppSettings } from '@shared/types'

/**
 * The settings a run executes under: the saved settings with the run's own
 * overrides (the headless `--effort`/`--max-turns`/`--max-cost`/`--verify` flags)
 * laid over them. Pure, and returns a copy, so an override never reaches the
 * saved settings or outlives the run.
 */
export function applyRunOverrides(
  settings: AppSettings,
  overrides: RunSettingsOverrides | undefined
): AppSettings {
  if (!overrides) return settings
  const o = overrides
  return {
    ...settings,
    ...(o.reasoningEffort !== undefined ? { reasoningEffort: o.reasoningEffort } : {}),
    // A cap passed for this run is a hard stop. Pinning autoExtendTurns off keeps a
    // saved "auto-extend" preference from stretching it past what the caller asked.
    ...(o.maxIterations !== undefined ? { maxIterations: o.maxIterations, autoExtendTurns: false } : {}),
    ...(o.costCeilingUsd !== undefined ? { costCeilingUsd: o.costCeilingUsd } : {}),
    ...(o.verifyCommand !== undefined ? { verifyOnStop: true, verifyCommand: o.verifyCommand } : {})
  }
}
