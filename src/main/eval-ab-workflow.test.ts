import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { defaultProviders } from '@shared/defaults'
import { baselineFileName } from './agent/evals/baseline'
import { HARD_SUBSET, PROBES_SUBSET, resolveEvalConfig, selectTasks } from './agent/evals/config'
import { DEFAULT_ATTEMPT_MAX_COST_USD } from './agent/evals/costCaps'
import { PROBES } from './agent/evals/probes'
import { HARD_TASKS, TASKS } from './agent/evals/tasks'

/**
 * Guards eval-ab.yml, the live prompt A/B for pull requests. It runs the pull request's own
 * code with the model key in scope, so these pin who can reach that key, that it never gates
 * a merge, that it can't cancel the weekly eval-live.yml run, that it spends a live run
 * only when the eval prompt actually changed, and what each side scores: the behavior probes,
 * plus the harder tasks under the label, or the harder tasks alone on a base without probes.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = readFileSync(resolve(root, '.github/workflows/eval-ab.yml'), 'utf8')
const doc = load(source) as any
const triggers = doc.on ?? doc[true as unknown as string]
const { plan, payload, ab, compare, comment, decide: decideJob } = doc.jobs
const hashBase = doc.jobs['hash-base']
const hashHead = doc.jobs['hash-head']
const allSteps = Object.values(doc.jobs).flatMap((j: any) => j.steps as any[])
const decide = plan.steps.find((s: any) => s.id === 'decide')
const pick = payload.steps.find((s: any) => s.id === 'pick')
const score = ab.steps.find((s: any) => s.name === 'Score each suite')
const compareStep = compare.steps.find((s: any) => s.name === 'Compare B against A')

/** The workflow without its comment lines, for checks on what actually runs. */
const code = source
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n')

/** Write `files` (relative path to contents) under `root`. */
function writeTree(root: string, files: Record<string, string> = {}): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
}

/**
 * Run one step's script the way the runner would, hermetically: bash with no startup files,
 * a temp HOME, only the system PATH plus `stubs` (executables written to a temp bin dir), a
 * temp GITHUB_OUTPUT and GITHUB_STEP_SUMMARY, and the given env. `files` are written to the
 * working directory and `temp` under RUNNER_TEMP, and the `collect` paths (under RUNNER_TEMP)
 * are read back before the temp dir goes. Returns the exit status, the outputs it wrote, its
 * log, and what it collected (undefined for a file that doesn't exist).
 */
function runStep(
  script: string,
  env: Record<string, string>,
  opts: {
    stubs?: Record<string, string>
    files?: Record<string, string>
    temp?: Record<string, string>
    collect?: string[]
  } = {}
): { status: number | null; out: Record<string, string>; log: string; collected: Record<string, string | undefined> } {
  const dir = mkdtempSync(join(tmpdir(), 'eval-ab-step-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    for (const [name, body] of Object.entries(opts.stubs ?? {})) {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    }
    const work = join(dir, 'work')
    mkdirSync(work)
    writeTree(work, opts.files)
    writeTree(dir, opts.temp)
    const output = join(dir, 'out')
    // The runner's own bash invocation. Without --norc, bash whose stdin is a socket (as
    // Node's pipes are on macOS) takes itself for an ssh session and sources ~/.bashrc,
    // which on some runner images puts the real gh and npm ahead of the stubs.
    const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      cwd: work,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
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
    const collected = Object.fromEntries(
      (opts.collect ?? []).map((rel) => [rel, existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : undefined])
    )
    return { status: r.status, out, log: r.stdout + r.stderr, collected }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('prompt A/B workflow', () => {
  it('runs on pull request events, never pull_request_target', () => {
    expect(Object.keys(triggers)).toEqual(['pull_request'])
    expect(triggers.pull_request.types).toEqual(['opened', 'reopened', 'ready_for_review', 'labeled'])
    expect(code).not.toContain('pull_request_target')
  })

  it('skips forks and Dependabot, and starts on a label only for eval-ab', () => {
    expect(plan.if).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(plan.if).toContain("github.event.pull_request.user.login != 'dependabot[bot]'")
    expect(plan.if).toContain("github.event.action != 'labeled' || github.event.label.name == 'eval-ab'")
    expect(decide.env.LABELLED).toBe("${{ contains(github.event.pull_request.labels.*.name, 'eval-ab') }}")
    expect(plan.outputs).toEqual({
      run: '${{ steps.decide.outputs.run }}',
      labelled: '${{ steps.decide.outputs.labelled }}'
    })
  })

  describe.skipIf(process.platform === 'win32')("plan's decide script", () => {
    // A stub gh: the file list for the files call, the label check for the pull request.
    const gh = 'case "$*" in *"/files"*) printf \'%s\\n\' "$STUB_FILES" ;; *) printf \'%s\\n\' "${STUB_LABELLED:-false}" ;; esac'
    // The step's own path patterns, as the runner would set them.
    const { PROMPT_SURFACE, NOT_PROMPT } = decide.env
    const planWith = (env: Record<string, string>) => {
      const base = { REPO: 'o/r', PR: '1', DRAFT: 'false', LABELLED: 'false', PROMPT_SURFACE, NOT_PROMPT }
      const r = runStep(decide.run, { ...base, ...env }, { stubs: { gh } })
      expect(r.status, r.log).toBe(0)
      return r.out
    }
    const touching = (...files: string[]) => planWith({ STUB_FILES: files.join('\n') }).run

    // hash-base, hash-head, decide and payload all read `labelled`; losing it would let the
    // hash check skip an A/B the label asked for, and drop the harder tasks it adds.
    it('reports the label so the hash check is bypassed', () => {
      expect(planWith({ LABELLED: 'true' })).toEqual({ labelled: 'true', run: 'true' })
      expect(planWith({ LABELLED: 'true', DRAFT: 'true' })).toEqual({ labelled: 'true', run: 'true' })
    })

    // `gh pr create --label` opens the pull request, then labels it: the `opened` payload
    // has no label, and that run would otherwise hash, start late and cancel the labelled one.
    it('reads the label from the pull request when the event did not carry it', () => {
      expect(planWith({ STUB_LABELLED: 'true' })).toEqual({ labelled: 'true', run: 'true' })
    })

    it('skips a draft without the label', () => {
      expect(planWith({ DRAFT: 'true' })).toEqual({ labelled: 'false', run: 'false' })
    })

    it('hashes a pull request that touches code which can shape the prompt', () => {
      for (const f of [
        'src/main/agent/prompt.ts',
        'src/main/agent/tools.ts',
        'src/main/agent/memoryTools.ts',
        'src/main/agent/capabilities.ts',
        'src/main/sandbox/index.ts',
        // The prompt lists the provider's models, from here.
        'src/shared/defaults.ts',
        'src/main/agent/goldens/system-prompt.gui.txt',
        'src/main/agent/goldens/per-model-request-shape.txt',
        // The files the hash comes from, so a pull request that breaks hash-only mode shows it.
        'src/main/agent/evals/evals.eval.ts',
        'src/main/agent/evals/stamp.ts'
      ]) {
        expect(touching('README.md', f), f).toBe('true')
      }
    })

    // The guide reaches the model only on demand, through the houston-guide skill, so an
    // edit to it leaves the eval prompt as it was. Six of the first eleven scorecards were
    // guide-only pull requests comparing identical prompts.
    it('skips the guide, tests, and code outside the agent', () => {
      expect(touching('docs/houston-guide.md')).toBe('false')
      expect(touching('src/main/agent/prompt.test.ts', 'src/main/agent/evals/stamp.test.ts')).toBe('false')
      expect(touching('src/renderer/src/App.tsx', 'src/main/ipc.ts', 'website/index.html')).toBe('false')
    })
  })

  it('hashes the eval prompt on both sides with no key, skipped when the label asks for a run', () => {
    for (const job of [hashBase, hashHead]) {
      expect(job.needs).toEqual(['plan'])
      expect(job.if).toBe("needs.plan.outputs.run == 'true' && needs.plan.outputs.labelled != 'true'")
      expect(job.permissions).toEqual({ contents: 'read' })
      expect(JSON.stringify(job)).not.toContain('secrets.')
      const checkout = job.steps.find((s: any) => String(s.uses ?? '').startsWith('actions/checkout@'))
      expect(checkout.with).toMatchObject({ ref: '${{ github.sha }}', 'persist-credentials': false })
      const hash = job.steps.find((s: any) => s.id === 'hash')
      expect(hash.env).toEqual({ HOUSTON_EVAL_PROVIDER: 'anthropic', HOUSTON_EVAL_MODEL: 'claude-haiku-5-5' })
      expect(hash.run).toContain('export HOUSTON_EVAL_HASH_OUT=')
      expect(hash.run).not.toContain('HOUSTON_EVAL_LIVE')
    }
    expect(hashBase.outputs).toEqual({
      supported: '${{ steps.support.outputs.supported }}',
      hash: '${{ steps.hash.outputs.hash }}'
    })
    expect(hashHead.outputs).toEqual({ hash: '${{ steps.hash.outputs.hash }}' })
  })

  it('hashes the same model the live A/B scores', () => {
    for (const job of [hashBase, hashHead]) {
      expect(job.steps.find((s: any) => s.id === 'hash').env.HOUSTON_EVAL_MODEL).toBe(score.env.HOUSTON_EVAL_MODEL)
    }
  })

  describe.skipIf(process.platform === 'win32')("the hash jobs' script", () => {
    // A stub npm that writes what hash-only mode would, or something else.
    const hashWith = (job: any, written: string) =>
      runStep(job.steps.find((s: any) => s.id === 'hash').run, { WRITTEN: written }, {
        stubs: { npm: 'printf \'%s\\n\' "$WRITTEN" > "$HOUSTON_EVAL_HASH_OUT"' }
      })

    it('passes a prompt hash on to decide', () => {
      for (const job of [hashBase, hashHead]) {
        expect(hashWith(job, '0123456789ab')).toMatchObject({ status: 0, out: { hash: '0123456789ab' } })
      }
    })

    // The file is written by the pull request's code; only a hash may reach decide.
    it('fails rather than pass on anything else', () => {
      for (const job of [hashBase, hashHead]) {
        for (const bad of ['', 'not-a-hash', '0123456789ab\nrun=true']) {
          const r = hashWith(job, bad)
          expect(r.status, bad).toBe(1)
          expect(r.out.hash, bad).toBeUndefined()
        }
      }
    })
  })

  // pull_request.base.sha is a snapshot from the last push: on a later labeled or reopened
  // event it can be behind the base the merge commit was built on, and main's own changes
  // since would then read as the pull request's. The merge commit's first parent can't be.
  it("takes A from the merge commit's first parent, in the hash, the payload and the live run alike", () => {
    expect(code).not.toContain('pull_request.base.sha')
    const firstParent = (steps: any[]) => {
      const checkout = steps.findIndex((s: any) => String(s.uses ?? '').startsWith('actions/checkout@'))
      expect(steps[checkout].with).toMatchObject({ ref: '${{ github.sha }}', 'fetch-depth': 2 })
      const parent = steps.findIndex((s: any) => s.run === 'git checkout --quiet --detach HEAD^1')
      expect(parent, 'no checkout of HEAD^1').toBeGreaterThan(checkout)
      return steps[parent]
    }
    expect(firstParent(hashBase.steps).if).toBeUndefined()
    expect(firstParent(payload.steps).if).toBeUndefined()
    expect(payload.steps.indexOf(firstParent(payload.steps))).toBeLessThan(payload.steps.indexOf(pick))
    expect(firstParent(ab.steps).if).toBe("matrix.side == 'base'")
    expect(hashHead.steps.some((s: any) => String(s.run ?? '').includes('HEAD^1'))).toBe(false)
    const compareCheckout = compare.steps.find((s: any) => String(s.uses ?? '').startsWith('actions/checkout@'))
    expect(compareCheckout.with).toMatchObject({ 'fetch-depth': 2 })
    expect(compareStep.run).toContain('BASE_SHA="$(git rev-parse HEAD^1)"')
  })

  describe('hash-base on a base from before hash-only mode', () => {
    const support = hashBase.steps.find((s: any) => s.id === 'support')
    const config = 'src/main/agent/evals/config.ts'

    // The support check greps the base's config for this name: renaming it here would
    // read every base as too old, and A/B every pull request that reaches the hash check.
    it('looks for the name config.ts really reads', () => {
      expect(support.run).toContain(`grep -q 'HOUSTON_EVAL_HASH_OUT' ${config}`)
      expect(readFileSync(resolve(root, config), 'utf8')).toContain("'HOUSTON_EVAL_HASH_OUT'")
    })

    // Unsupported leaves the hash empty, which decide reads as "run the A/B".
    it.skipIf(process.platform === 'win32')('hashes only when the base knows HOUSTON_EVAL_HASH_OUT', () => {
      const supported = (files: Record<string, string>) => runStep(support.run, {}, { files }).out.supported
      expect(supported({ [config]: "envOr(env, 'HOUSTON_EVAL_HASH_OUT', '')" })).toBe('true')
      expect(supported({ [config]: "envOr(env, 'HOUSTON_EVAL_OUT', '')" })).toBe('false')
      expect(supported({})).toBe('false')
    })

    it('skips the install and the hash step when it does not', () => {
      for (const step of hashBase.steps.slice(hashBase.steps.indexOf(support) + 1)) {
        expect(step.if, JSON.stringify(step)).toBe("steps.support.outputs.supported == 'true'")
      }
    })
  })

  it('runs the live A/B only on what decide says, through the payload job', () => {
    expect(decideJob.needs).toEqual(['plan', 'hash-base', 'hash-head'])
    expect(decideJob.if).toBe("${{ !cancelled() && needs.plan.outputs.run == 'true' }}")
    expect(decideJob.permissions).toEqual({})
    expect(payload.needs).toEqual(['plan', 'decide'])
    expect(ab.needs).toEqual(['payload'])
  })

  // A skip anywhere above a job skips it too unless its condition checks status itself,
  // and the label path skips the hash jobs: without these the label could never run an A/B.
  it('states every downstream condition with !cancelled(), so the label path reaches the A/B', () => {
    expect(payload.if).toBe(
      "${{ !cancelled() && needs.decide.result == 'success' && needs.decide.outputs.run == 'true' }}"
    )
    expect(ab.if).toBe("${{ !cancelled() && needs.payload.result == 'success' }}")
    expect(compare.needs).toEqual(['payload', 'ab'])
    expect(compare.if).toBe("${{ !cancelled() && needs.ab.result == 'success' }}")
    expect(comment.needs).toEqual(['compare'])
    expect(comment.if).toBe("${{ !cancelled() && needs.compare.result == 'success' }}")
  })

  describe.skipIf(process.platform === 'win32')("decide's script", () => {
    const script = decideJob.steps.find((s: any) => s.id === 'compare').run as string
    const decideWith = (env: Record<string, string>) => {
      const r = runStep(script, {
        LABELLED: 'false',
        BASE_RESULT: 'success',
        HEAD_RESULT: 'success',
        BASE_SUPPORTED: 'true',
        BASE_HASH: 'aaaaaaaaaaaa',
        HEAD_HASH: 'aaaaaaaaaaaa',
        ...env
      })
      return { status: r.status, run: r.out.run, log: r.log }
    }

    it('skips an A/B of an unchanged prompt', () => {
      const r = decideWith({})
      expect(r).toMatchObject({ status: 0, run: 'false' })
      expect(r.log).toContain('unchanged')
    })

    it('runs one when the prompt changed', () => {
      expect(decideWith({ HEAD_HASH: 'bbbbbbbbbbbb' })).toMatchObject({ status: 0, run: 'true' })
    })

    it('runs one when the label asks, whatever the hashes (the hash jobs are skipped then)', () => {
      expect(
        decideWith({
          LABELLED: 'true',
          BASE_RESULT: 'skipped',
          HEAD_RESULT: 'skipped',
          BASE_SUPPORTED: '',
          BASE_HASH: '',
          HEAD_HASH: ''
        })
      ).toMatchObject({ status: 0, run: 'true' })
    })

    // Conservative for pull requests whose base predates hash-only mode.
    it('runs one when the base predates hash-only mode', () => {
      expect(decideWith({ BASE_SUPPORTED: 'false', BASE_HASH: '' })).toMatchObject({ status: 0, run: 'true' })
    })

    // A newer run took the hash jobs' groups; it decides, so this one stops quietly.
    it('stops without failing when a newer run cancelled the hashing', () => {
      expect(decideWith({ HEAD_RESULT: 'cancelled', HEAD_HASH: '' })).toMatchObject({ status: 0, run: 'false' })
      expect(decideWith({ BASE_RESULT: 'cancelled', BASE_HASH: '' })).toMatchObject({ status: 0, run: 'false' })
    })

    // The merge commit it couldn't hash is the one the A/B would run: spend nothing, show red.
    it('fails without spending when a side could not be hashed', () => {
      expect(decideWith({ HEAD_RESULT: 'failure', HEAD_HASH: '' })).toMatchObject({ status: 1, run: 'false' })
      expect(decideWith({ BASE_RESULT: 'failure', BASE_HASH: '' })).toMatchObject({ status: 1, run: 'false' })
      expect(decideWith({ HEAD_HASH: '' })).toMatchObject({ status: 1, run: 'false' })
      // A base that supports hashing but produced none is broken, not old.
      expect(decideWith({ BASE_HASH: '' })).toMatchObject({ status: 1, run: 'false' })
    })
  })

  describe('what each side scores', () => {
    const config = 'src/main/agent/evals/config.ts'
    const realConfig = readFileSync(resolve(root, config), 'utf8')
    const keyword = "PROBES_SUBSET = 'probes'"

    it('is decided once, from the base, by a job that holds no secret and runs none of its code', () => {
      expect(payload.permissions).toEqual({ contents: 'read' })
      expect(JSON.stringify(payload)).not.toContain('secrets.')
      expect(payload.outputs).toEqual({
        suites: '${{ steps.pick.outputs.suites }}',
        fallback: '${{ steps.pick.outputs.fallback }}'
      })
      expect(pick.env).toEqual({ LABELLED: '${{ needs.plan.outputs.labelled }}' })
      for (const step of payload.steps) {
        expect(String(step.uses ?? '')).not.toMatch(/^\.\//)
        expect(String(step.run ?? '')).not.toMatch(/\bnpm\b|\bnode\b/)
      }
      // Both sides and the comment read the one decision.
      expect(score.env.SUITES).toBe('${{ needs.payload.outputs.suites }}')
      expect(compareStep.env).toEqual({
        SUITES: '${{ needs.payload.outputs.suites }}',
        FALLBACK: '${{ needs.payload.outputs.fallback }}'
      })
    })

    // The check greps the base's config for this line: renaming the constant or changing how
    // it is written would read every base as too old, and quietly score the harder tasks
    // instead of the probes on every pull request.
    it('looks for the probes keyword exactly as config.ts defines it', () => {
      expect(pick.run).toContain(`grep -qF "${keyword}" ${config}`)
      expect(realConfig).toContain(`export const ${keyword}`)
      expect(PROBES_SUBSET).toBe('probes')
    })

    describe.skipIf(process.platform === 'win32')("the payload job's script", () => {
      const pickWith = (labelled: string, files: Record<string, string>) => {
        const r = runStep(pick.run, { LABELLED: labelled }, { files })
        expect(r.status, r.log).toBe(0)
        return { ...r.out, log: r.log }
      }
      // The real file with the probes keyword taken out: a base from before the probes.
      const preProbes = realConfig.replace(`export const ${keyword}\n`, '')

      it('scores the probes on both sides, and the harder tasks after them when the label is set', () => {
        expect(pickWith('false', { [config]: realConfig })).toMatchObject({ suites: 'probes', fallback: 'false' })
        expect(pickWith('true', { [config]: realConfig })).toMatchObject({ suites: 'probes hard', fallback: 'false' })
      })

      // Its eval run would stop at an unregistered id and write no run record, failing its
      // side; and probes on one side only would compare nothing.
      it('falls back to the harder tasks on both sides when the base does not know the probes', () => {
        expect(preProbes).not.toBe(realConfig)
        for (const labelled of ['false', 'true']) {
          const r = pickWith(labelled, { [config]: preProbes })
          expect(r, labelled).toMatchObject({ suites: 'hard', fallback: 'true' })
          expect(r.log).toContain('predates the behavior probes')
          expect(pickWith(labelled, {}), labelled).toMatchObject({ suites: 'hard', fallback: 'true' })
        }
      })
    })
  })

  describe('the suites', () => {
    const suites = { probes: { attempts: '5', cap: '1' }, hard: { attempts: '2', cap: '2' } }

    // Each suite is its own eval run, so each keeps its own attempt count and run cap.
    it('scores the probes at five attempts and the harder tasks at two, each under its own run cap', () => {
      expect(doc.env).toEqual({
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
        AB_PROBES_ATTEMPTS: suites.probes.attempts,
        AB_PROBES_MAX_RUN_USD: suites.probes.cap,
        AB_HARD_ATTEMPTS: suites.hard.attempts,
        AB_HARD_MAX_RUN_USD: suites.hard.cap
      })
    })

    it('names HOUSTON_EVAL_TASKS keywords that select what the comment says they ran', () => {
      expect(HARD_SUBSET).toBe('hard')
      expect(selectTasks(TASKS, HARD_TASKS, 'probes', PROBES)).toEqual({ tasks: [], probes: PROBES })
      expect(selectTasks(TASKS, HARD_TASKS, 'hard', PROBES)).toEqual({ tasks: HARD_TASKS, probes: [] })
    })

    // The driver enforces the run cap; a value it refused would stop the run instead.
    it('gives the driver settings it accepts, leaving the per-attempt cap at its default', () => {
      for (const [tasks, { attempts, cap }] of Object.entries(suites)) {
        const config = resolveEvalConfig(
          {
            HOUSTON_EVAL_LIVE: '1',
            HOUSTON_EVAL_PROVIDER: score.env.HOUSTON_EVAL_PROVIDER,
            HOUSTON_EVAL_MODEL: score.env.HOUSTON_EVAL_MODEL,
            HOUSTON_EVAL_TASKS: tasks,
            HOUSTON_EVAL_ATTEMPTS: attempts,
            HOUSTON_EVAL_MAX_RUN_USD: cap
          },
          defaultProviders()
        )
        expect(config, tasks).toMatchObject({ attempts: Number(attempts), maxRunUsd: Number(cap), tasks })
        expect(config.maxCostUsd, tasks).toBe(DEFAULT_ATTEMPT_MAX_COST_USD)
        expect(config.maxCostUsdSet, tasks).toBeUndefined()
      }
      expect(code).not.toContain('HOUSTON_EVAL_MAX_COST_USD')
    })
  })

  it('compares the base commit with the merge commit on the cheap model', () => {
    expect(ab.strategy.matrix.side).toEqual(['base', 'head'])
    expect(score.env).toMatchObject({
      HOUSTON_EVAL_LIVE: '1',
      HOUSTON_EVAL_PROVIDER: 'anthropic',
      HOUSTON_EVAL_MODEL: 'claude-haiku-5-5'
    })
    // Set per eval run by the script, never for the whole step.
    for (const name of [
      'HOUSTON_EVAL_RECORD',
      'HOUSTON_EVAL_TASKS',
      'HOUSTON_EVAL_ATTEMPTS',
      'HOUSTON_EVAL_MAX_RUN_USD',
      'HOUSTON_EVAL_OUT'
    ]) {
      expect(score.env).not.toHaveProperty(name)
    }
    // A live run with no baseline fails before scoring anything, probes-only runs included.
    const baseline = resolve(root, 'src/main/agent/evals/baselines', baselineFileName('anthropic', 'claude-haiku-5-5'))
    expect(existsSync(baseline), baseline).toBe(true)
  })

  // The records the compare job reads: every suite's, from both sides.
  it("uploads every suite's record from each side", () => {
    const upload = ab.steps.find((s: any) => String(s.uses ?? '').startsWith('actions/upload-artifact@'))
    expect(upload.with).toEqual({
      name: 'eval-ab-${{ matrix.side }}',
      'retention-days': 14,
      path: '${{ runner.temp }}/eval-ab/${{ matrix.side }}-*.json',
      'if-no-files-found': 'error'
    })
  })

  describe.skipIf(process.platform === 'win32')("the scoring step's script", () => {
    // A stub npm that logs what each eval run was handed, then writes a run record unless
    // its suite is in STUB_NO_RECORD, and exits STUB_STATUS.
    const npm = [
      'out="${HOUSTON_EVAL_OUT#"$RUNNER_TEMP"/}"',
      'echo "$*|$HOUSTON_EVAL_TASKS|$HOUSTON_EVAL_ATTEMPTS|$HOUSTON_EVAL_MAX_RUN_USD|$out|${HOUSTON_EVAL_MAX_COST_USD-unset}" >> "$RUNNER_TEMP/npm.log"',
      'case " ${STUB_NO_RECORD:-} " in *" $HOUSTON_EVAL_TASKS "*) ;; *) echo "{}" > "$HOUSTON_EVAL_OUT" ;; esac',
      'exit "${STUB_STATUS:-0}"'
    ].join('\n')
    const scoreWith = (env: Record<string, string>) => {
      const r = runStep(
        score.run,
        { ...doc.env, SIDE: 'base', SUITES: 'probes', ANTHROPIC_API_KEY: 'sk-test', ...env },
        { stubs: { npm }, collect: ['npm.log', 'eval-ab/base-probes.json', 'eval-ab/head-hard.json'] }
      )
      const calls = (r.collected['npm.log'] ?? '').split('\n').filter(Boolean)
      return { status: r.status, calls, log: r.log, collected: r.collected }
    }

    it('runs the probes alone by default, at five attempts under their own cap', () => {
      const r = scoreWith({})
      expect(r.status, r.log).toBe(0)
      expect(r.calls).toEqual(['run eval|probes|5|1|eval-ab/base-probes.json|unset'])
      expect(r.collected['eval-ab/base-probes.json']).toBeDefined()
    })

    it('runs the probes, then the harder tasks, as two eval runs with their own records', () => {
      const r = scoreWith({ SIDE: 'head', SUITES: 'probes hard' })
      expect(r.status, r.log).toBe(0)
      expect(r.calls).toEqual([
        'run eval|probes|5|1|eval-ab/head-probes.json|unset',
        'run eval|hard|2|2|eval-ab/head-hard.json|unset'
      ])
      expect(r.collected['eval-ab/head-hard.json']).toBeDefined()
    })

    it('runs the harder tasks alone on the fallback', () => {
      expect(scoreWith({ SUITES: 'hard' }).calls).toEqual(['run eval|hard|2|2|eval-ab/base-hard.json|unset'])
    })

    // A drop below the baseline, or a stop at the run cap, exits non-zero after the record
    // is written: still a valid side, and the next suite still runs.
    it('keeps going when an eval run fails but wrote its record', () => {
      const r = scoreWith({ SUITES: 'probes hard', STUB_STATUS: '1' })
      expect(r.status, r.log).toBe(0)
      expect(r.calls).toHaveLength(2)
      expect(r.log).toContain('The base probes run exited 1')
    })

    it('fails the side when an eval run wrote no record, spending nothing more', () => {
      const first = scoreWith({ SUITES: 'probes hard', STUB_NO_RECORD: 'probes' })
      expect(first.status).toBe(1)
      expect(first.calls).toHaveLength(1)
      expect(first.log).toContain('The base probes run wrote no run record')
      const second = scoreWith({ SUITES: 'probes hard', STUB_NO_RECORD: 'hard' })
      expect(second.status).toBe(1)
      expect(second.calls).toHaveLength(2)
      expect(second.log).toContain('The base hard run wrote no run record')
    })

    it('runs nothing without a key, a suite, or with a suite it does not know', () => {
      for (const [env, why] of [
        [{ ANTHROPIC_API_KEY: '' }, 'ANTHROPIC_API_KEY is empty or unset'],
        [{ SUITES: '' }, 'The payload job named no suite to score'],
        [{ SUITES: 'all' }, "'all' is not a suite this workflow scores"]
      ] as const) {
        const r = scoreWith(env)
        expect(r.status, JSON.stringify(env)).toBe(1)
        expect(r.calls, JSON.stringify(env)).toEqual([])
        expect(r.log).toContain(why)
      }
    })
  })

  describe.skipIf(process.platform === 'win32')("the compare step's script", () => {
    const merge = '1'.repeat(40)
    const base = '2'.repeat(40)
    const git = `case "$*" in "rev-parse HEAD") echo ${merge} ;; "rev-parse HEAD^1") echo ${base} ;; *) exit 1 ;; esac`
    // A stub npm that logs the pair it was handed and writes a scorecard naming it.
    const npm = [
      'a="${HOUSTON_EVAL_A#"$RUNNER_TEMP"/}"',
      'b="${HOUSTON_EVAL_B#"$RUNNER_TEMP"/}"',
      'echo "$*|$a|$b|${HOUSTON_EVAL_COMPARE_OUT#"$RUNNER_TEMP"/}" >> "$RUNNER_TEMP/npm.log"',
      'echo "scorecard: $(basename "$a") vs $(basename "$b")" > "$HOUSTON_EVAL_COMPARE_OUT"',
      'exit "${STUB_STATUS:-0}"'
    ].join('\n')
    const compareWith = (env: Record<string, string>) => {
      const r = runStep(
        compareStep.run,
        { ...doc.env, FALLBACK: 'false', ...env },
        { stubs: { git, npm }, temp: { 'eval-ab/.keep': '' }, collect: ['npm.log', 'eval-ab/comment.md', 'summary.md'] }
      )
      const comment = r.collected['eval-ab/comment.md'] ?? ''
      const calls = (r.collected['npm.log'] ?? '').split('\n').filter(Boolean)
      return { status: r.status, log: r.log, comment, calls, summary: r.collected['summary.md'] }
    }
    const probesTitle = '#### Behavior probes (`HOUSTON_EVAL_TASKS=probes`), 5 attempts each'
    const hardTitle = '#### Harder eval tasks (`HOUSTON_EVAL_TASKS=hard`), 2 attempts each'
    const fallbackNote = 'The base commit predates the behavior probes, so both sides scored the harder eval tasks instead.'
    const labelNote = 'With the `eval-ab` label set, each side also scores the harder eval tasks, 2 attempts each.'

    it('compares each suite pair and shows both scorecards, probes first, each labelled', () => {
      const r = compareWith({ SUITES: 'probes hard' })
      expect(r.status, r.log).toBe(0)
      expect(r.calls).toEqual([
        'run eval:compare|eval-ab/base-probes.json|eval-ab/head-probes.json|eval-ab/scorecard-probes.txt',
        'run eval:compare|eval-ab/base-hard.json|eval-ab/head-hard.json|eval-ab/scorecard-hard.txt'
      ])
      const lines = r.comment.split('\n')
      expect(lines[0]).toBe('<!-- houston:eval-ab -->')
      expect(lines[1]).toBe('### Prompt A/B (live)')
      expect(r.comment).toContain(`A is the base commit (\`${base.slice(0, 12)}\`)`)
      expect(r.comment).toContain(`merged onto it (\`${merge.slice(0, 12)}\`)`)
      // Each scorecard sits under its own heading, in that order.
      const at = (s: string) => {
        expect(lines, s).toContain(s)
        return lines.indexOf(s)
      }
      expect(at(probesTitle)).toBeLessThan(at('scorecard: base-probes.json vs head-probes.json'))
      expect(at('scorecard: base-probes.json vs head-probes.json')).toBeLessThan(at(hardTitle))
      expect(at(hardTitle)).toBeLessThan(at('scorecard: base-hard.json vs head-hard.json'))
      expect(r.comment).not.toContain(fallbackNote)
      expect(r.comment).not.toContain(labelNote)
      expect(r.comment).toContain('To run it again, remove the `eval-ab` label and add it back.')
      expect(r.summary).toBe(r.comment)
    })

    it('says the label adds the harder tasks when it ran the probes alone', () => {
      const r = compareWith({ SUITES: 'probes' })
      expect(r.status, r.log).toBe(0)
      expect(r.calls).toHaveLength(1)
      expect(r.comment).toContain(probesTitle)
      expect(r.comment).not.toContain(hardTitle)
      expect(r.comment).toContain(labelNote)
    })

    it('says so when the base predated the probes and both sides scored the harder tasks', () => {
      const r = compareWith({ SUITES: 'hard', FALLBACK: 'true' })
      expect(r.status, r.log).toBe(0)
      expect(r.calls).toEqual([
        'run eval:compare|eval-ab/base-hard.json|eval-ab/head-hard.json|eval-ab/scorecard-hard.txt'
      ])
      expect(r.comment).toContain(fallbackNote)
      expect(r.comment.indexOf(fallbackNote)).toBeLessThan(r.comment.indexOf(hardTitle))
      expect(r.comment).not.toContain(probesTitle)
      expect(r.comment).not.toContain(labelNote)
    })

    it('fails rather than post a partial scorecard', () => {
      expect(compareWith({ SUITES: 'probes all' }).status).toBe(1)
      expect(compareWith({ SUITES: 'probes hard', STUB_STATUS: '1' }).status).toBe(1)
    })
  })

  it('posts the eval:compare scorecard, editing its earlier comment rather than adding one', () => {
    const run = compareStep.run
    expect(run).toContain('npm run eval:compare')
    expect(run).toContain('HOUSTON_EVAL_COMPARE_OUT=')
    // The marker the comment job finds the earlier scorecard by, as the body's first line.
    expect(run).toContain("echo '<!-- houston:eval-ab -->'")
    expect(run.indexOf("echo '<!-- houston:eval-ab -->'")).toBeLessThan(run.indexOf("echo '### Prompt A/B (live)'"))
    // Re-adding a label that is already set fires no event, so it has to come off first.
    expect(run).toContain('remove the \\`eval-ab\\` label and add it back')
    const post = comment.steps.find((s: any) => s.run).run as string
    expect(post).toContain('startswith("<!-- houston:eval-ab -->")')
    expect(post).toContain('select(.user.login == "github-actions[bot]"')
    expect(post).toContain('gh api --method PATCH "repos/$REPO/issues/comments/$id" -F "body=@$body"')
    expect(post).toContain('gh pr comment "$PR" --repo "$REPO" --body-file "$body"')
  })

  // A workflow-level group cancels the running A/B as soon as any later event creates a
  // run, before the plan job can ignore it: adding full-ci used to kill a live A/B.
  it('has no workflow-level concurrency, only per-PR groups on the jobs that do work', () => {
    expect(doc.concurrency).toBeUndefined()
    const pr = '${{ github.event.pull_request.number }}'
    expect(hashBase.concurrency).toEqual({ group: `eval-ab-${pr}-hash-base`, 'cancel-in-progress': true })
    expect(hashHead.concurrency).toEqual({ group: `eval-ab-${pr}-hash-head`, 'cancel-in-progress': true })
    expect(ab.concurrency).toEqual({ group: `eval-ab-${pr}-\${{ matrix.side }}`, 'cancel-in-progress': true })
    // These cancel in progress: joining one of eval-live's groups would let a PR kill the weekly run.
    for (const job of Object.values(doc.jobs) as any[]) {
      expect(String(job.concurrency?.group ?? '')).not.toMatch(/^eval-live/)
    }
  })

  it('keeps the model key in one step, away from the jobs that write or compare', () => {
    expect(doc.permissions).toEqual({ contents: 'read' })
    const keyed = allSteps.filter((s) => JSON.stringify(s).includes('secrets.'))
    expect(keyed).toEqual([score])
    expect(score.env.ANTHROPIC_API_KEY).toBe('${{ secrets.ANTHROPIC_API_KEY }}')
    expect(doc.jobs.ab.env).toBeUndefined()
    expect(ab.permissions).toEqual({ contents: 'read' })
    expect(compare.permissions).toEqual({ contents: 'read' })
    expect(plan.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
  })

  it('comments from a job that checks out and runs nothing from the pull request', () => {
    expect(comment.permissions).toEqual({ 'pull-requests': 'write' })
    for (const step of comment.steps) {
      expect(String(step.uses ?? '')).not.toMatch(/^actions\/checkout@|^\.\//)
      expect(String(step.run ?? '')).not.toMatch(/\bnpm\b|\bnode\b/)
    }
  })

  it('passes event data through env, never interpolated into a script', () => {
    for (const step of allSteps) if (step.run) expect(step.run).not.toContain('${{')
  })

  it('pins every action to a commit SHA', () => {
    for (const step of allSteps) if (step.uses?.startsWith('actions/')) expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
  })
})
