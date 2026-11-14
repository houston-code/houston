import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { baselineFileName } from './agent/evals/baseline'

/**
 * Guards eval-ab.yml, the live prompt A/B for pull requests. It runs the pull request's own
 * code with the model key in scope, so these pin who can reach that key, that it never gates
 * a merge, and that it can't cancel the weekly eval-live.yml run.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = readFileSync(resolve(root, '.github/workflows/eval-ab.yml'), 'utf8')
const doc = load(source) as any
const triggers = doc.on ?? doc[true as unknown as string]
const { plan, ab, compare, comment } = doc.jobs
const allSteps = Object.values(doc.jobs).flatMap((j: any) => j.steps as any[])
const decide = plan.steps.find((s: any) => s.id === 'decide')
const score = ab.steps.find((s: any) => s.name === 'Score the harder tasks')

/** The path regex the plan job matches the diff against, as written in its script. */
function pathPattern(): RegExp {
  const m = /grep -Eq '([^']+)'/.exec(decide.run)
  expect(m, 'the plan job no longer matches paths with grep -Eq').not.toBeNull()
  return new RegExp(m![1])
}

describe('prompt A/B workflow', () => {
  it('runs on pull request events, never pull_request_target', () => {
    expect(Object.keys(triggers)).toEqual(['pull_request'])
    expect(triggers.pull_request.types).toEqual(['opened', 'reopened', 'ready_for_review', 'labeled'])
    const code = source
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toContain('pull_request_target')
  })

  it('skips forks and Dependabot, and starts on a label only for eval-ab', () => {
    expect(plan.if).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(plan.if).toContain("github.event.pull_request.user.login != 'dependabot[bot]'")
    expect(plan.if).toContain("github.event.action != 'labeled' || github.event.label.name == 'eval-ab'")
    expect(decide.env.LABELLED).toBe("${{ contains(github.event.pull_request.labels.*.name, 'eval-ab') }}")
    expect(ab.needs).toEqual(['plan'])
    expect(ab.if).toBe("needs.plan.outputs.run == 'true'")
  })

  it('runs automatically for changes to the prompt, tool descriptions, guide or goldens', () => {
    const re = pathPattern()
    for (const f of [
      'src/main/agent/prompt.ts',
      'src/main/agent/tools.ts',
      'src/main/agent/memoryTools.ts',
      'src/main/agent/goldens/system-prompt.gui.txt',
      'docs/houston-guide.md'
    ]) {
      expect(re.test(f), f).toBe(true)
    }
    for (const f of ['src/main/agent/prompt.test.ts', 'src/main/agent/tools.test.ts', 'docs/houston-guide.mdx', 'README.md']) {
      expect(re.test(f), f).toBe(false)
    }
  })

  it('compares the base commit with the merge commit on the cheap model and the harder tasks', () => {
    expect(ab.strategy.matrix.side).toEqual(['base', 'head'])
    const checkout = ab.steps.find((s: any) => String(s.uses ?? '').startsWith('actions/checkout@'))
    expect(checkout.with.ref).toBe(
      "${{ matrix.side == 'base' && github.event.pull_request.base.sha || github.sha }}"
    )
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

  it('posts the eval:compare scorecard', () => {
    const run = compare.steps.find((s: any) => s.name === 'Compare B against A').run
    expect(run).toContain('npm run eval:compare')
    expect(run).toContain('HOUSTON_EVAL_COMPARE_OUT=')
    const post = comment.steps.find((s: any) => s.run)
    expect(post.run).toBe('gh pr comment "$PR" --repo "$REPO" --body-file "$RUNNER_TEMP/scorecard/comment.md"')
  })

  it('uses its own concurrency group, never eval-live', () => {
    // eval-live cancels in progress: sharing its group would let a PR kill the weekly run.
    expect(doc.concurrency).toEqual({ group: 'eval-ab-${{ github.event.pull_request.number }}', 'cancel-in-progress': true })
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
