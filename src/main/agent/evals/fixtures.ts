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
import { cpSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { headline } from './report'
import type { EvalTask, EvalVerify } from './types'

/** Absolute path of `evals/tasks`, resolved from this module rather than cwd. */
export const TASKS_DIR = fileURLToPath(new URL('./tasks', import.meta.url))

/** A task's fixture repo — the tree copied into the workspace for each run. */
export function repoDirFor(taskId: string): string {
  return join(TASKS_DIR, taskId, 'repo')
}

/**
 * A task's hidden checks (see {@link EvalTask.holdout}). Beside `repo/`, never inside
 * it: `materializeTask` copies only `repo/`, which is what keeps them out of sight.
 */
export function holdoutDirFor(taskId: string): string {
  return join(TASKS_DIR, taskId, 'holdout')
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
 *
 * FRESH PER CALL, not per task. Every attempt at a task used to reuse one
 * `<tmpRoot>/<task id>` folder, and copying over it resets the files the fixture
 * has but leaves any the agent created. So attempt 2 of `new-module-write` started
 * with attempt 1's `slug.mjs` already in place and passed without doing anything.
 * Attempts have to be independent for a pass rate (or pass^k) to mean anything.
 *
 * NAMED `repo`, not after the task. The prompt names the workspace folder as the
 * project, so a folder called `fix-null-deref` told a live model what to fix, and
 * made the prompt (and its hash, stamp.ts) differ from task to task.
 */
export function materializeTask(task: EvalTask, tmpRoot: string): string {
  const ws = join(mkdtempSync(join(tmpRoot, 'attempt-')), 'repo')
  mkdirSync(ws, { recursive: true })
  cpSync(repoDirFor(task.id), ws, { recursive: true })
  return ws
}

/**
 * Restore a task's test files from the pristine fixture, overwriting whatever the
 * agent left behind. Call immediately before grading.
 *
 * The prompts state the symptom, not the fix, so the test file is the spec the
 * agent reads to learn the contract — and also the shortest path to a green
 * verify, by deleting the assertion that fails. Grading a tampered test would
 * score that as a solve. This makes the edit pointless instead of forbidden:
 * whatever the agent did to the test, the graded one is the original.
 */
export function restoreVerifyFiles(task: EvalTask, ws: string): void {
  for (const rel of task.verifyFiles ?? ['test.mjs']) {
    cpSync(join(repoDirFor(task.id), rel), join(ws, rel), { recursive: true })
  }
}

/**
 * Copy a task's holdout checks into the finished workspace. Call after
 * `restoreVerifyFiles`, immediately before grading: the files exist only from here
 * on, so nothing the agent ran could have read them.
 */
export function placeHoldout(task: EvalTask, ws: string): void {
  if (task.holdout) cpSync(holdoutDirFor(task.id), ws, { recursive: true })
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

/** How a finished workspace graded. */
export interface Grade extends VerifyOutcome {
  /**
   * The visible `verify` passed: the only check the agent could have run. Honesty is
   * graded against this, not `ok`, since a report can't be wrong about a holdout it
   * never saw.
   */
  visibleOk: boolean
}

/**
 * Grade a finished workspace: restore the tests, place the holdout, run `verify`,
 * then the holdout. Solved means both passed. A holdout failure says so up front,
 * because "passed what it could see, failed what it couldn't" is a narrow fix, a
 * different finding from a fix that doesn't work.
 */
export function gradeTask(task: EvalTask, ws: string): Grade {
  restoreVerifyFiles(task, ws)
  placeHoldout(task, ws)
  const visible = runVerify(task.verify, ws)
  if (!visible.ok || !task.holdout) return { ...visible, visibleOk: visible.ok }
  const hidden = runVerify(task.holdout, ws)
  if (hidden.ok) return { ...visible, visibleOk: true }
  return {
    ok: false,
    exitCode: hidden.exitCode,
    output: `holdout failed (the visible check passed): ${headline(hidden.output)}\n${hidden.output}`,
    visibleOk: true
  }
}

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
