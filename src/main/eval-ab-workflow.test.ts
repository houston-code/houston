import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { baselineFileName } from './agent/evals/baseline'

/**
 * Guards eval-ab.yml, the live prompt A/B for pull requests. It runs the pull request's own
 * code with the model key in scope, so these pin who can reach that key, that it never gates
 * a merge, that it can't cancel the weekly eval-live.yml run, and that it spends a live run
 * only when the eval prompt actually changed.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = readFileSync(resolve(root, '.github/workflows/eval-ab.yml'), 'utf8')
const doc = load(source) as any
const triggers = doc.on ?? doc[true as unknown as string]
const { plan, ab, compare, comment, decide: decideJob } = doc.jobs
const hashBase = doc.jobs['hash-base']
const hashHead = doc.jobs['hash-head']
const allSteps = Object.values(doc.jobs).flatMap((j: any) => j.steps as any[])
const decide = plan.steps.find((s: any) => s.id === 'decide')
const score = ab.steps.find((s: any) => s.name === 'Score the harder tasks')

/** The workflow without its comment lines, for checks on what actually runs. */
const code = source
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n')

/**
 * Run one step's script the way the runner would, hermetically: bash with no startup files,
 * a temp HOME, only the system PATH plus `stubs` (executables written to a temp bin dir), a
 * temp GITHUB_OUTPUT, and the given env. Returns the exit status, the outputs it wrote, and
 * its log.
 */
function runStep(
  script: string,
  env: Record<string, string>,
  opts: { stubs?: Record<string, string>; files?: Record<string, string> } = {}
): { status: number | null; out: Record<string, string>; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'eval-ab-step-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    for (const [name, body] of Object.entries(opts.stubs ?? {})) {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    }
    const work = join(dir, 'work')
    mkdirSync(work)
    for (const [rel, body] of Object.entries(opts.files ?? {})) {
      mkdirSync(dirname(join(work, rel)), { recursive: true })
      writeFileSync(join(work, rel), body)
    }
    const output = join(dir, 'out')
    // The runner's own bash invocation. Without --norc, bash whose stdin is a socket (as
    // Node's pipes are on macOS) takes itself for an ssh session and sources ~/.bashrc,
    // which on some runner images puts the real gh and npm ahead of the stubs.
    const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      cwd: work,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, GITHUB_OUTPUT: output, RUNNER_TEMP: dir, ...env }
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

    // hash-base, hash-head and decide all read `labelled`; losing it would let the hash
    // check skip an A/B the label asked for.
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
  it("takes A from the merge commit's first parent, in the hash and the live run alike", () => {
    expect(code).not.toContain('pull_request.base.sha')
    const firstParent = (steps: any[]) => {
      const checkout = steps.findIndex((s: any) => String(s.uses ?? '').startsWith('actions/checkout@'))
      expect(steps[checkout].with).toMatchObject({ ref: '${{ github.sha }}', 'fetch-depth': 2 })
      const parent = steps.findIndex((s: any) => s.run === 'git checkout --quiet --detach HEAD^1')
      expect(parent, 'no checkout of HEAD^1').toBeGreaterThan(checkout)
      return steps[parent]
    }
    expect(firstParent(hashBase.steps).if).toBeUndefined()
    expect(firstParent(ab.steps).if).toBe("matrix.side == 'base'")
    expect(hashHead.steps.some((s: any) => String(s.run ?? '').includes('HEAD^1'))).toBe(false)
    const compareCheckout = compare.steps.find((s: any) => String(s.uses ?? '').startsWith('actions/checkout@'))
    expect(compareCheckout.with).toMatchObject({ 'fetch-depth': 2 })
    const compareRun = compare.steps.find((s: any) => s.name === 'Compare B against A').run
    expect(compareRun).toContain('BASE_SHA="$(git rev-parse HEAD^1)"')
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

  it('runs the live A/B only on what decide says', () => {
    expect(decideJob.needs).toEqual(['plan', 'hash-base', 'hash-head'])
    expect(decideJob.if).toBe("${{ !cancelled() && needs.plan.outputs.run == 'true' }}")
    expect(decideJob.permissions).toEqual({})
    expect(ab.needs).toEqual(['decide'])
  })

  // A skip anywhere above a job skips it too unless its condition checks status itself,
  // and the label path skips the hash jobs: without these the label could never run an A/B.
  it('states every downstream condition with !cancelled(), so the label path reaches the A/B', () => {
    expect(ab.if).toBe("${{ !cancelled() && needs.decide.result == 'success' && needs.decide.outputs.run == 'true' }}")
    expect(compare.needs).toEqual(['ab'])
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

  it('compares the base commit with the merge commit on the cheap model and the harder tasks', () => {
    expect(ab.strategy.matrix.side).toEqual(['base', 'head'])
    expect(score.env).toMatchObject({
      HOUSTON_EVAL_LIVE: '1',
      HOUSTON_EVAL_PROVIDER: 'anthropic',
      HOUSTON_EVAL_MODEL: 'claude-haiku-5-5',
      HOUSTON_EVAL_ATTEMPTS: '2',
      HOUSTON_EVAL_TASKS: 'hard'
    })
    expect(score.env).not.toHaveProperty('HOUSTON_EVAL_RECORD')
    // A live run with no baseline fails before scoring anything.
    const baseline = resolve(root, 'src/main/agent/evals/baselines', baselineFileName('anthropic', 'claude-haiku-5-5'))
    expect(existsSync(baseline), baseline).toBe(true)
  })

  it('fails a side only when it wrote no run record, not on a task below its baseline', () => {
    expect(score.run).toContain('npm run eval || status=$?')
    expect(score.run).toContain('if [ ! -s "$HOUSTON_EVAL_OUT" ]')
  })

  it('posts the eval:compare scorecard, editing its earlier comment rather than adding one', () => {
    const run = compare.steps.find((s: any) => s.name === 'Compare B against A').run
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
    // eval-live cancels in progress: sharing its group would let a PR kill the weekly run.
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
