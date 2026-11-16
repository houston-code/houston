import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Guards how eval-live.yml spends and reports, the weekly live eval and its on-demand
 * dispatches. A live run costs real money and takes over an hour, so these pin that no
 * dispatch or re-run cancels one in progress, that a dispatch typo stops before the install,
 * that every run keeps its run record, and that a scheduled run which never finished still
 * reaches a human. baselines.test.ts pins its model, keys and baseline recording.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = readFileSync(resolve(root, '.github/workflows/eval-live.yml'), 'utf8')
const doc = load(source) as any
const { evals, alert } = doc.jobs
const steps = evals.steps as any[]
const requireKey = steps.find((s) => s.name === 'Require the model API key')
const score = steps.find((s) => s.id === 'score')
const upload = steps.find((s) => s.name === 'Upload the run record')
const alertOnFailure = load(readFileSync(resolve(root, '.github/workflows/alert-on-failure.yml'), 'utf8')) as any

/** The provider a run scores, as every step spells it: anthropic when nothing says otherwise. */
const PROVIDER = "${{ inputs.provider || 'anthropic' }}"
/** The scheduled model's expression with 'default' for "the provider's default model". */
const MODEL_KEY = String(score.env.HOUSTON_EVAL_MODEL).replace("|| '') }}", "|| 'default') }}")

/**
 * Write `stubs` as executables into a new temp dir, for {@link runStep}'s `bin`. Shared by a
 * whole describe block: macOS scans a new executable on its first run, which costs a few
 * hundred milliseconds a file.
 */
function stubBin(stubs: Record<string, string>): string {
  const bin = mkdtempSync(join(tmpdir(), 'eval-live-bin-'))
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  }
  return bin
}

/**
 * Run one step's script the way the runner would, hermetically: bash with no startup files,
 * a temp HOME and RUNNER_TEMP, a temp GITHUB_OUTPUT, PATH=/usr/bin:/bin (after `bin`, when
 * given), and the given env. Returns the exit status, the outputs it wrote, and its log.
 */
function runStep(
  script: string,
  env: Record<string, string>,
  bin?: string
): { status: number | null; out: Record<string, string>; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'eval-live-step-'))
  try {
    const output = join(dir, 'out')
    // Without --norc, bash whose stdin is a socket (as Node's pipes are on macOS) takes
    // itself for an ssh session and sources ~/.bashrc.
    const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: bin ? `${bin}:/usr/bin:/bin` : '/usr/bin:/bin',
        HOME: dir,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: dir,
        ...env
      }
    })
    const out = existsSync(output)
      ? Object.fromEntries(
          readFileSync(output, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
        )
      : {}
    return { status: r.status, out, log: r.stdout + r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('live eval workflow', () => {
  it('reads its inputs the way this test assumes', () => {
    expect(score.env.HOUSTON_EVAL_MODEL).toBe(
      "${{ inputs.model || ((inputs.provider || 'anthropic') == 'anthropic' && 'claude-haiku-5-5' || '') }}"
    )
    expect(MODEL_KEY).not.toBe(score.env.HOUSTON_EVAL_MODEL)
    expect(requireKey.env.PROVIDER).toBe(PROVIDER)
    expect(score.env.PROVIDER).toBe(PROVIDER)
    expect(requireKey.env.ATTEMPTS).toBe('${{ inputs.attempts }}')
    expect(score.env.HOUSTON_EVAL_ATTEMPTS).toBe('${{ inputs.attempts }}')
  })

  describe('concurrency', () => {
    // A single cancel-in-progress group let any dispatch or re-run kill another session's
    // run in flight: two live runs died that way on 2026-11-12.
    it('queues runs of the same provider and model, and never cancels one in progress', () => {
      expect(evals.concurrency).toEqual({
        group: `eval-live-${PROVIDER}-${MODEL_KEY}`,
        'cancel-in-progress': false
      })
    })

    // A scheduled run has no inputs, so it lands in the same group as a dispatch of
    // claude-haiku-5-5, recording or grading: the two wait for each other rather than share a
    // rate limit, which would read as a regression or lower the baseline being recorded.
    it('keys the group on what a run scores, never on its event, ref, run or mode', () => {
      expect(evals.concurrency.group).not.toMatch(/github\./)
      expect(evals.concurrency.group).not.toContain('inputs.record')
    })

    // A displaced waiting run is cancelled at the job, so the run still reaches `alert`.
    // A workflow-level group would cancel the whole run before any job could report it.
    it('sits on the job that spends, not on the workflow, so the alert job stays outside it', () => {
      expect(doc.concurrency).toBeUndefined()
      expect(alert.concurrency).toBeUndefined()
    })

    // GitHub keeps at most one waiting run per group, and a newer one cancels it whatever
    // cancel-in-progress says. Until `queue: max` can be used, the only guard is a person
    // checking before dispatching, so the workflow has to say so and the run names have to
    // show what each run holds.
    it('warns that a third same-key run cancels the waiting one, and names runs so it can be checked', () => {
      expect(evals.concurrency).not.toHaveProperty('queue')
      expect(source).toContain('GitHub holds at most ONE waiting run per group')
      expect(source).toContain('a third run with the same key cancels the')
      expect(source).toContain('`gh run list --workflow eval-live.yml`')
      expect(doc['run-name']).toBe(`Task evals (live): ${PROVIDER}/${MODEL_KEY}\${{ inputs.record && ', recording' || '' }}`)
    })
  })

  describe('the run record', () => {
    it('has the suite write it, under the name config.ts reads', () => {
      const run = String(score.run)
      expect(run).toContain('export HOUSTON_EVAL_OUT="$RUNNER_TEMP/eval-run.json"')
      expect(run.indexOf('export HOUSTON_EVAL_OUT=')).toBeLessThan(run.indexOf('npm run eval'))
      expect(readFileSync(resolve(root, 'src/main/agent/evals/config.ts'), 'utf8')).toContain("'HOUSTON_EVAL_OUT'")
    })

    // A run that regressed still wrote its record, and is the one most worth comparing.
    it('uploads it after every run that was not cancelled, failed ones included', () => {
      expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(score))
      expect(upload.if).toBe('${{ !cancelled() }}')
      expect(upload.with).toEqual({
        name: '${{ steps.score.outputs.artifact }}',
        'retention-days': 90,
        path: '${{ runner.temp }}/eval-run.json',
        'if-no-files-found': 'warn'
      })
    })

    it('uses the upload-artifact commit the repository already pins', () => {
      const baselineUpload = steps.find((s) => s.with?.name === 'eval-baseline')
      expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
      expect(upload.uses).toBe(baselineUpload.uses)
      const ab = readFileSync(resolve(root, '.github/workflows/eval-ab.yml'), 'utf8')
      expect(ab).toContain(`uses: ${upload.uses} #`)
    })
  })

  describe.skipIf(process.platform === 'win32')("the scoring step's script", () => {
    // A stub npm that reports what the suite would have been handed.
    let bin = ''
    beforeAll(() => {
      bin = stubBin({
        npm: [
          'echo "args=$*"',
          'echo "out=${HOUSTON_EVAL_OUT#"$RUNNER_TEMP"/}"',
          'echo "anthropic=${ANTHROPIC_API_KEY:-}"',
          'echo "openai=${OPENAI_API_KEY:-}"',
          'echo "api_key=${API_KEY-unset}"',
          'exit "${STUB_STATUS:-0}"'
        ].join('\n')
      })
    })
    afterAll(() => rmSync(bin, { recursive: true, force: true }))
    const scoreWith = (env: Record<string, string>) => {
      const r = runStep(score.run, { PROVIDER: 'anthropic', API_KEY: 'sk-test', HOUSTON_EVAL_MODEL: '', ...env }, bin)
      const seen = Object.fromEntries(
        r.log
          .split('\n')
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
      )
      return { ...r, seen }
    }

    it("runs the suite with the record path set and the key under the provider's own name", () => {
      const r = scoreWith({ HOUSTON_EVAL_MODEL: 'claude-haiku-5-5' })
      expect(r.status, r.log).toBe(0)
      expect(r.seen).toEqual({ args: 'run eval', out: 'eval-run.json', anthropic: 'sk-test', openai: '', api_key: 'unset' })
      expect(r.out).toEqual({ artifact: 'eval-run-anthropic-claude-haiku-5-5' })
      expect(scoreWith({ PROVIDER: 'openai', HOUSTON_EVAL_MODEL: 'gpt-6.1-sol' }).seen).toMatchObject({
        anthropic: '',
        openai: 'sk-test'
      })
    })

    it('names the artifact with a model id an artifact name can hold', () => {
      const artifact = (env: Record<string, string>) => scoreWith(env).out
      expect(artifact({ PROVIDER: 'openai', HOUSTON_EVAL_MODEL: 'gpt-6.1-sol' })).toEqual({ artifact: 'eval-run-openai-gpt-6.1-sol' })
      expect(artifact({ PROVIDER: 'openai', HOUSTON_EVAL_MODEL: 'org/model:v1' })).toEqual({
        artifact: 'eval-run-openai-org-model-v1'
      })
      // No model input on another provider scores that provider's default.
      expect(artifact({ PROVIDER: 'gemini' })).toEqual({ artifact: 'eval-run-gemini-default' })
      // The model comes from a dispatch input: a newline in it can't add an output line.
      expect(artifact({ PROVIDER: 'openai', HOUSTON_EVAL_MODEL: 'm\nartifact=x' })).toEqual({
        artifact: 'eval-run-openai-m-artifact-x'
      })
    })

    it('fails on a failed suite, with the artifact already named for the upload', () => {
      const r = scoreWith({ HOUSTON_EVAL_MODEL: 'claude-haiku-5-5', STUB_STATUS: '1' })
      expect(r.status).toBe(1)
      expect(r.out).toEqual({ artifact: 'eval-run-anthropic-claude-haiku-5-5' })
    })
  })

  // The attempts and key checks save nothing unless they stop the job before it installs and
  // scores: moved below the scoring step, or let through by continue-on-error, a dispatch
  // with attempts=30 would spend the whole run while the script tests below stayed green.
  it('runs the key check before the install and the scoring, and stops the job when it fails', () => {
    const setupNode = steps.findIndex((s) => s.uses === './.github/actions/setup-node')
    expect(steps.indexOf(requireKey)).toBeGreaterThan(-1)
    expect(setupNode).toBeGreaterThan(-1)
    expect(steps.indexOf(requireKey)).toBeLessThan(setupNode)
    expect(steps.indexOf(requireKey)).toBeLessThan(steps.indexOf(score))
    // With no `if` of their own, the steps after a failed check are skipped.
    for (const step of [requireKey, steps[setupNode], score]) {
      expect(step['continue-on-error'], step.name ?? step.uses).toBeUndefined()
      expect(step.if, step.name ?? step.uses).toBeUndefined()
    }
  })

  describe.skipIf(process.platform === 'win32')("the key check's script", () => {
    const check = (env: Record<string, string>) =>
      runStep(requireKey.run, { PROVIDER: 'anthropic', API_KEY: 'sk-test', ATTEMPTS: '', ...env })

    it('passes a scheduled run (no input) and any attempts from 1 to 5', () => {
      for (const attempts of ['', '1', '3', '5', ' 4 ']) {
        const r = check({ ATTEMPTS: attempts })
        expect(r.status, `${JSON.stringify(attempts)}: ${r.log}`).toBe(0)
        expect(r.log).not.toContain('::error::')
      }
    })

    // A dispatch typo guard: each attempt reruns every task, so 30 for 3 is ten times the spend.
    it('refuses attempts above 5 before anything is installed or spent', () => {
      for (const attempts of ['6', '30', '99999999999999999999']) {
        const r = check({ ATTEMPTS: attempts })
        expect(r.status, attempts).toBe(1)
        expect(r.log).toContain(`::error::The attempts input is ${attempts}, above the limit of 5.`)
      }
    })

    it('refuses attempts that are not a whole number from 1 to 5', () => {
      for (const attempts of ['0', '00', '-1', '3.5', 'three', '3x']) {
        const r = check({ ATTEMPTS: attempts })
        expect(r.status, attempts).toBe(1)
        expect(r.log).toContain(`::error::The attempts input must be a whole number from 1 to 5, got '${attempts}'.`)
      }
    })

    it('still stops on a provider with no key wired up, or an empty key', () => {
      const unknown = check({ PROVIDER: 'mistral' })
      expect(unknown.status).toBe(1)
      expect(unknown.log).toContain("::error::No API key is wired up for provider 'mistral'.")
      const empty = check({ PROVIDER: 'gemini', API_KEY: '' })
      expect(empty.status).toBe(1)
      expect(empty.log).toContain('::error::GEMINI_API_KEY is empty or unset')
    })
  })

  // Inert until the driver reads it; pinned so the ceiling is a deliberate number.
  it('gives the scoring step a spend ceiling, tighter for the unattended scheduled run', () => {
    expect(score.env.HOUSTON_EVAL_MAX_RUN_USD).toBe("${{ github.event_name == 'schedule' && '5' || '25' }}")
  })

  describe('alerting', () => {
    // The weekly run is the only quality gate: one that never finished is a missed week.
    it('reports a scheduled run that failed or was cancelled, and no dispatched run', () => {
      expect(alert.needs).toEqual(['evals'])
      expect(alert.uses).toBe('./.github/workflows/alert-on-failure.yml')
      expect(alert.permissions).toEqual({ issues: 'write' })
      expect(alert.if).toBe("${{ always() && github.event_name == 'schedule' }}")
      // `failed: false` closes the open issue, so a cancellation has to count as a failure.
      expect(alert.with).toEqual({
        workflow: 'Task evals (live)',
        failed: "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}"
      })
    })

    // Called from a cancelled run, the alert job's default `success()` would skip it.
    it('lets the shared alert run in a cancelled run only when it was told the run failed', () => {
      expect(alertOnFailure.jobs.alert.if).toBe('${{ !cancelled() || inputs.failed }}')
    })
  })

  it('passes event data through env, never interpolated into a script', () => {
    for (const step of steps) if (step.run) expect(step.run, step.name).not.toContain('${{')
  })

  it('pins every action to a commit SHA', () => {
    for (const step of steps) if (step.uses?.startsWith('actions/')) expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
  })
})
