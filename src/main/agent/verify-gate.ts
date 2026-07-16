import type { ApprovalPolicy } from '@shared/types'
import type { EgressProxyEndpoints, SandboxRunResult } from '../sandbox'
import { runSandboxed, clampToolResult } from '../sandbox'

/**
 * End-of-run verification gate (opt-in).
 *
 * When the model finishes naturally (an `end_turn` with no tool calls) after
 * having actually modified files this session, it's easy for it to declare
 * victory on a change that doesn't compile or breaks a test. This gate lets the
 * user configure a verification command (typically their typecheck/test) that
 * runs at that natural stop; if it fails, the failure output is fed back and the
 * loop is allowed a bounded number of extra passes so the model can self-correct
 * before the run is accepted as done.
 *
 * It is deliberately conservative:
 *  - OPT-IN only: does nothing unless the user enabled it AND configured a
 *    command. We never run a command the user didn't type.
 *  - Only fires when files were actually modified this run (no point verifying a
 *    read-only Q&A turn).
 *  - BOUNDED: at most `maxPasses` extra verification cycles, after which `done`
 *    is accepted regardless — so a persistently-failing verify can never loop
 *    forever.
 *  - Respects the abort signal and runs through the same sandbox as `run_shell`,
 *    inheriting the host's confinement posture.
 *
 * The decision half (should we verify? may we run another pass?) is pure and
 * unit-tested; the execution half wraps the sandbox runner.
 */

/** Config + live state the gate decision reads. */
export interface VerifyGateState {
  /** Master toggle (settings). */
  enabled: boolean
  /** The user-configured verification command; empty/whitespace = not configured. */
  command: string | undefined
  /** Did the run modify any files this session? */
  filesModified: boolean
  /** How many verification passes have already run this session. */
  passesRun: number
  /** Maximum extra verification passes allowed (bounded self-correction). */
  maxPasses: number
  /**
   * The run's LIVE approval policy. Plan mode is read-only — "Plan mode runs
   * nothing" — so the verify command (a shell command) must not execute in Plan,
   * mirroring the `isBlockedByPlan` gate on `run_shell`. Read at decision time so
   * a mid-run toggle into Plan suppresses the gate on the next natural stop.
   */
  policy: ApprovalPolicy
}

/** Default cap on extra self-correction passes — small on purpose. */
export const DEFAULT_VERIFY_MAX_PASSES = 1

/**
 * Resolve the effective max-passes bound from a user override, clamped to a
 * sane range so it stays "bounded": at least 1 (a gate that can't run a pass is
 * pointless) and at most 3 (beyond that it's just a slow loop). Invalid/undefined
 * falls back to the default.
 */
export function resolveVerifyMaxPasses(override?: number): number {
  if (typeof override !== 'number' || !Number.isFinite(override)) return DEFAULT_VERIFY_MAX_PASSES
  return Math.min(3, Math.max(1, Math.floor(override)))
}

/**
 * Whether the gate should run a verification pass at this natural stop. True only
 * when it's enabled, a non-empty command is configured, files were modified, we're
 * not in Plan (read-only) mode, and we haven't already used the bounded pass
 * budget. Pure — the loop calls this before deciding whether to actually execute
 * the command.
 */
export function shouldVerify(state: VerifyGateState): boolean {
  if (!state.enabled) return false
  // Plan mode runs nothing: never execute the verify shell command while the live
  // policy is Plan, even if a pre-Plan turn armed the gate by modifying files.
  if (state.policy === 'plan') return false
  if (!state.command || state.command.trim() === '') return false
  if (!state.filesModified) return false
  if (state.passesRun >= state.maxPasses) return false
  return true
}

/** Outcome of a verification run, shaped for feeding back into the loop. */
export interface VerifyResult {
  /** True when the command exited 0 (verification passed). */
  passed: boolean
  /** Combined, clamped stdout+stderr for the feedback message (empty when passed cleanly). */
  output: string
  /** True when the run was aborted (the caller should stop, not feed back). */
  aborted: boolean
}

/**
 * Format the verification failure into the message fed back to the model. Kept
 * separate (and pure) so the exact wording is testable and stable.
 */
export function verifyFailureMessage(command: string, output: string): string {
  return (
    `Automatic verification failed. I ran your configured verification command ` +
    `\`${command}\` after your changes and it did not pass:\n\n` +
    '```\n' +
    output +
    '\n```\n\n' +
    'Fix the problems above, then finish. If the failures are unrelated to your ' +
    'changes or you cannot fix them, say so and stop.'
  )
}

/** Inputs needed to actually execute the verification command. */
export interface RunVerifyInput {
  command: string
  workspace: string
  roots?: string[]
  allowNetwork: boolean
  /** Egress-proxy endpoints; with allowNetwork:true the command's egress is per-domain filtered. */
  egressProxy?: EgressProxyEndpoints
  signal?: AbortSignal
  /** Byte cap for the fed-back output (reuse the shell-output budget). */
  maxBytes?: number
  /** Wall-clock timeout for the verification command. */
  timeoutMs?: number
  /** Injected for tests; defaults to the real sandbox runner. */
  run?: (opts: {
    command: string
    cwd: string
    workspace: string
    roots?: string[]
    allowNetwork: boolean
    egressProxy?: EgressProxyEndpoints
    timeoutMs?: number
    signal?: AbortSignal
  }) => Promise<SandboxRunResult>
}

/** Default verification timeout (5 minutes) — typecheck/test suites can be slow. */
const DEFAULT_VERIFY_TIMEOUT_MS = 5 * 60_000

/**
 * Execute the verification command through the sandbox and shape the result.
 * Runs in the workspace with the run's network posture, honoring the abort
 * signal. Never throws — a spawn failure is reported as a failed verification so
 * the model gets a chance to react (or the bounded budget ends the run).
 */
export async function runVerification(input: RunVerifyInput): Promise<VerifyResult> {
  const run = input.run ?? runSandboxed
  try {
    const res = await run({
      command: input.command,
      cwd: input.workspace,
      workspace: input.workspace,
      roots: input.roots,
      allowNetwork: input.allowNetwork,
      egressProxy: input.egressProxy,
      timeoutMs: input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      signal: input.signal
    })
    if (input.signal?.aborted) return { passed: false, output: '', aborted: true }
    const passed = res.exitCode === 0 && !res.timedOut
    const combined = [res.stdout, res.stderr].filter((s) => s && s.trim()).join('\n').trim()
    const note = res.timedOut ? '\n[verification command timed out]' : ''
    return {
      passed,
      output: clampToolResult(combined + note, input.maxBytes),
      aborted: false
    }
  } catch (e) {
    if (input.signal?.aborted) return { passed: false, output: '', aborted: true }
    return { passed: false, output: `Failed to run verification command: ${(e as Error).message}`, aborted: false }
  }
}
