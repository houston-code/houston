/**
 * Fixture plumbing for the task-level evals: materialize a task's repo into a
 * throwaway workspace, and grade it by running the task's verify command there.
 *
 * Kept free of any `./loop` import on purpose. The loop only accepts a fake
 * provider through `vi.mock`, which is file-scoped, so the suite file must own
 * the mock preamble and the deferred `await import('../loop')`. Anything a
 * helper module imports would bind to the UNMOCKED loop and silently drive a
 * real provider. Everything here is mock-agnostic, so it stays importable.
 */
import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { EvalTask, EvalVerify } from './types'

/** Absolute path of `evals/tasks`, resolved from this module rather than cwd. */
export const TASKS_DIR = fileURLToPath(new URL('./tasks', import.meta.url))

/** A task's fixture repo — the tree copied into the workspace for each run. */
export function repoDirFor(taskId: string): string {
  return join(TASKS_DIR, taskId, 'repo')
}

/** Task directory names on disk, so the suite can assert none is unregistered. */
export function taskDirNames(): string[] {
  return readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/**
 * Copy a task's fixture repo into a fresh workspace under `tmpRoot`.
 *
 * The fixture is copied, never used in place: the agent mutates the workspace,
 * and a run that wrote into `evals/tasks/*_/repo` would corrupt the fixture for
 * every later run and show up as a dirty git tree.
 */
export function materializeTask(task: EvalTask, tmpRoot: string): string {
  const ws = join(tmpRoot, task.id)
  mkdirSync(ws, { recursive: true })
  cpSync(repoDirFor(task.id), ws, { recursive: true })
  return ws
}

/** Outcome of a verify command. */
export interface VerifyOutcome {
  ok: boolean
  /** `null` when the command was killed (timeout) or never spawned. */
  exitCode: number | null
  output: string
}

/**
 * A fixture's tests are tiny and dependency-free, so this is generous headroom
 * rather than a real budget — it exists to turn "the agent left an infinite
 * loop in the fixture" into a failed task instead of a hung CI job.
 */
const VERIFY_TIMEOUT_MS = 30_000

/** Run a task's verify command in `ws`. Exit 0 = the task is solved. */
export function runVerify(verify: EvalVerify, ws: string): VerifyOutcome {
  const r = spawnSync(verify.cmd, verify.args, {
    cwd: ws,
    encoding: 'utf8',
    timeout: VERIFY_TIMEOUT_MS,
    // Fixtures are plain Node scripts with no dependencies; an inherited env
    // could otherwise let a stray NODE_OPTIONS change how they run.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
  })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  if (r.error) {
    return { ok: false, exitCode: null, output: `${output}\n${r.error.message}`.trim() }
  }
  return { ok: r.status === 0, exitCode: r.status, output }
}
