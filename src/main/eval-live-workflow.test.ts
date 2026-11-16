import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveEvalConfig } from './agent/evals/config'
import { loadEvalLive, resolveStep, scheduleArms, scheduledCrons, scheduledLegs } from './test/eval-live-legs'

/**
 * Guards how eval-live.yml spends and reports, its scheduled legs and their on-demand
 * dispatches. A live run costs real money and takes over an hour, so these pin which model
 * each cron scores and under what cap, that no dispatch or re-run cancels one in progress,
 * that a dispatch typo stops before the install, that every run keeps its run record, and
 * that a scheduled run which never finished still reaches a human. baselines.test.ts pins
 * the keys, the baseline recording, and a baseline for every scheduled leg.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { source, doc } = loadEvalLive()
const { resolve: resolveJob, evals, alert } = doc.jobs
const steps = evals.steps as any[]
const leg = resolveStep(doc)
const requireKey = steps.find((s) => s.name === 'Require the model API key')
const score = steps.find((s) => s.id === 'score')
const upload = steps.find((s) => s.name === 'Upload the run record')
const alertOnFailure = load(readFileSync(resolve(root, '.github/workflows/alert-on-failure.yml'), 'utf8')) as any

/** An output of the resolve job, as the jobs after it spell it. */
const R = (name: string) => `\${{ needs.resolve.outputs.${name} }}`

/** The workflow's code: every line but its comments, which may name anything. */
const code = source
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n')

/** The scheduled legs as they stand, and the cap a dispatch runs under. */
const HAIKU = { cron: '0 9 * * 1', provider: 'anthropic', model: 'claude-haiku-5-5', maxRunUsd: '5' }
const LUNA = { cron: '23 12 3 * *', provider: 'openai', model: 'gpt-6-luna', maxRunUsd: '5' }
const FLASH_LITE = { cron: '47 14 5 1,4,7,10 *', provider: 'gemini', model: 'gemini-3.5-flash-lite', maxRunUsd: '20' }
const DISPATCH_CAP = '25'

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

/** The resolve script run for an event, with no inputs unless given, as a scheduled run has none. */
const resolveFor = (env: { EVENT: string; SCHEDULE?: string; PROVIDER_INPUT?: string; MODEL_INPUT?: string }) =>
  runStep(leg.run, { SCHEDULE: '', PROVIDER_INPUT: '', MODEL_INPUT: '', ...env })
const scheduled = (cron: string) => resolveFor({ EVENT: 'schedule', SCHEDULE: cron })
const dispatched = (provider: string, model = '') =>
  resolveFor({ EVENT: 'workflow_dispatch', PROVIDER_INPUT: provider, MODEL_INPUT: model })

/** What the resolve job writes for a run of `provider` and `model` (empty: the provider default). */
const outputs = (provider: string, model: string, cap: string) => ({
  provider,
  model,
  key: model || 'default',
  artifact: `eval-run-${provider}-${model || 'default'}`,
  max_run_usd: cap
})

/** The evals job's concurrency group, filled in with what the resolve job wrote. */
const groupFor = (out: Record<string, string>) =>
  String(evals.concurrency.group).replace(R('provider'), out.provider).replace(R('key'), out.key)

describe('live eval workflow', () => {
  it('reads its inputs the way this test assumes', () => {
    // Event data and inputs reach the resolve script through env, and only there.
    expect(leg.env).toEqual({
      EVENT: '${{ github.event_name }}',
      SCHEDULE: '${{ github.event.schedule }}',
      PROVIDER_INPUT: '${{ inputs.provider }}',
      MODEL_INPUT: '${{ inputs.model }}'
    })
    expect(resolveJob.outputs).toEqual(
      Object.fromEntries(
        ['provider', 'model', 'key', 'artifact', 'max_run_usd'].map((o) => [o, `\${{ steps.leg.outputs.${o} }}`])
      )
    )
    expect(evals.needs).toEqual(['resolve'])
    expect(requireKey.env.PROVIDER).toBe(R('provider'))
    expect(score.env.PROVIDER).toBe(R('provider'))
    expect(score.env.HOUSTON_EVAL_PROVIDER).toBe(R('provider'))
    expect(score.env.HOUSTON_EVAL_MODEL).toBe(R('model'))
    expect(score.env.HOUSTON_EVAL_MAX_RUN_USD).toBe(R('max_run_usd'))
    expect(upload.with.name).toBe(R('artifact'))
    expect(requireKey.env.ATTEMPTS).toBe('${{ inputs.attempts }}')
    expect(score.env.HOUSTON_EVAL_ATTEMPTS).toBe('${{ inputs.attempts }}')
  })

  describe('the scheduled legs', () => {
    it('scores Haiku weekly on the Monday cron, luna monthly and flash-lite quarterly', () => {
      expect(scheduledLegs(doc)).toEqual([HAIKU, LUNA, FLASH_LITE])
    })

    // Cron fields: minute hour day-of-month month day-of-week. Setting both day fields would
    // run on either (cron ORs them), so each leg sets one.
    it('keeps each cadence to the one its cost allows', () => {
      const fields = (cron: string) => cron.split(' ')
      const [, , dom, month, dow] = fields(HAIKU.cron)
      expect([dom, month, dow]).toEqual(['*', '*', '1'])
      for (const monthly of [LUNA, FLASH_LITE]) {
        const [m, h, d, , w] = fields(monthly.cron)
        expect([m, h, d].every((f) => /^\d+$/.test(f)), monthly.cron).toBe(true)
        expect(Number(d), monthly.cron).toBeLessThanOrEqual(28) // every month has the day
        expect(w, monthly.cron).toBe('*')
      }
      expect(fields(LUNA.cron)[3]).toBe('*')
      // About $8.62 a run: four a year, three months apart.
      expect(fields(FLASH_LITE.cron)[3]).toBe('1,4,7,10')
    })

    it('starts no two legs together', () => {
      const crons = scheduledCrons(doc)
      expect(new Set(crons).size).toBe(crons.length)
      const times = crons.map((c) => c.split(' ').slice(0, 2).join(' '))
      expect(new Set(times).size, 'two legs share a start time').toBe(times.length)
      // The monthly and quarterly legs never share a day of the month.
      expect(LUNA.cron.split(' ')[2]).not.toBe(FLASH_LITE.cron.split(' ')[2])
    })

    // An arm with no cron is dead code that reads as a leg; a cron with no arm fails its
    // run (scheduledLegs throws for it, and the script test below shows the run failing).
    it('has one resolve arm for every cron under on.schedule, and none besides', () => {
      expect([...scheduleArms(doc).keys()].sort()).toEqual([...scheduledCrons(doc)].sort())
    })

    // The mapping lives in the resolve job alone: every other consumer reads its outputs, and
    // only run-name (which GitHub evaluates before any job) reads the schedule at all.
    it('maps a cron to its leg in one place', () => {
      expect(code.split('github.event.schedule')).toHaveLength(3)
      expect(leg.env.SCHEDULE).toBe('${{ github.event.schedule }}')
      expect(doc['run-name']).toContain('github.event.schedule')
      for (const [name, job] of Object.entries({ evals, alert })) {
        const text = JSON.stringify(job)
        expect(text, name).not.toContain('github.event.schedule')
        expect(text, name).not.toContain('inputs.provider')
        expect(text, name).not.toContain('inputs.model')
      }
      for (const { cron, model } of [LUNA, FLASH_LITE]) {
        expect(code.split(`'${cron}'`), cron).toHaveLength(3) // on.schedule and the arm
        expect(code.split(model), model).toHaveLength(2) // the arm
      }
    })

    it('runs the resolve job with no secret and no token', () => {
      expect(resolveJob.permissions).toEqual({})
      expect(JSON.stringify(resolveJob)).not.toContain('secrets.')
      expect(resolveJob.concurrency).toBeUndefined()
    })
  })

  describe.skipIf(process.platform === 'win32')("the resolve job's script", () => {
    it.each([HAIKU, LUNA, FLASH_LITE])('maps the cron "$cron" to $provider/$model under a $maxRunUsd USD cap', (l) => {
      const r = scheduled(l.cron)
      expect(r.status, r.log).toBe(0)
      expect(r.out).toEqual(outputs(l.provider, l.model, l.maxRunUsd))
      expect(r.log).toContain(`Scoring ${l.provider}/${l.model}, with a run cap of $${l.maxRunUsd}.`)
    })

    // What scheduledLegs reads from the script's text is what the script does.
    it('agrees with the legs the baselines test reads', () => {
      for (const l of scheduledLegs(doc)) expect(scheduled(l.cron).out, l.cron).toEqual(outputs(l.provider, l.model, l.maxRunUsd))
    })

    // A cron added to on.schedule with no arm must not score some default and look green.
    it('fails a scheduled run whose cron has no leg, writing nothing', () => {
      for (const cron of ['0 0 * * *', '0 9 * * 2', '0  9 * * 1', ' 0 9 * * 1', '']) {
        const r = scheduled(cron)
        expect(r.status, JSON.stringify(cron)).toBe(1)
        expect(r.log).toContain(`::error::The schedule '${cron}' has no leg in eval-live.yml's resolve job.`)
        expect(r.out).toEqual({})
      }
    })

    it('fails an event it has no leg for', () => {
      const r = resolveFor({ EVENT: 'push', PROVIDER_INPUT: 'anthropic' })
      expect(r.status).toBe(1)
      expect(r.log).toContain("::error::eval-live.yml has no leg for a 'push' event.")
      expect(r.out).toEqual({})
    })

    it('scores the leg on a scheduled run whatever inputs say, and the inputs on a dispatch whatever the schedule says', () => {
      const run = resolveFor({ EVENT: 'schedule', SCHEDULE: LUNA.cron, PROVIDER_INPUT: 'anthropic', MODEL_INPUT: 'claude-opus-5-5' })
      expect(run.out).toEqual(outputs('openai', 'gpt-6-luna', '5'))
      const dispatch = resolveFor({ EVENT: 'workflow_dispatch', SCHEDULE: FLASH_LITE.cron })
      expect(dispatch.out).toEqual(outputs('anthropic', 'claude-haiku-5-5', DISPATCH_CAP))
    })

    // As before the legs: claude-haiku-5-5 on anthropic with no model, the provider's default
    // (an empty model) on any other provider, and the model input as typed.
    it('resolves a dispatch from its inputs, under the dispatch cap', () => {
      expect(dispatched('anthropic').out).toEqual(outputs('anthropic', 'claude-haiku-5-5', DISPATCH_CAP))
      expect(dispatched('').out).toEqual(outputs('anthropic', 'claude-haiku-5-5', DISPATCH_CAP))
      expect(dispatched('anthropic', 'claude-opus-5-5').out).toEqual(outputs('anthropic', 'claude-opus-5-5', DISPATCH_CAP))
      expect(dispatched('openai').out).toEqual(outputs('openai', '', DISPATCH_CAP))
      expect(dispatched('gemini').out).toEqual(outputs('gemini', '', DISPATCH_CAP))
      expect(dispatched('openai', 'gpt-6.1-sol').out).toEqual(outputs('openai', 'gpt-6.1-sol', DISPATCH_CAP))
      // The suite trims the model, and the group keeps it as typed.
      expect(dispatched('anthropic', ' claude-opus-5-5').out).toMatchObject({ model: ' claude-opus-5-5', key: ' claude-opus-5-5' })
      // An unknown provider resolves, and the key check stops it, naming the ones it knows.
      expect(dispatched('mistral').out).toEqual(outputs('mistral', '', DISPATCH_CAP))
    })

    it('names the artifact with a model id an artifact name can hold', () => {
      expect(dispatched('openai', 'org/model:v1').out).toMatchObject({ key: 'org/model:v1', artifact: 'eval-run-openai-org-model-v1' })
      expect(dispatched('openai', 'a"b*c?d<e>f|g\\h').out.artifact).toBe('eval-run-openai-a-b-c-d-e-f-g-h')
    })

    // An input reaches GITHUB_OUTPUT as an output line: a newline in one would write an
    // output of its own, such as a larger cap. Carriage returns split lines too.
    it('refuses an input holding a newline or other control character, before writing anything', () => {
      for (const [provider, model] of [
        ['anthropic', 'm\nmax_run_usd=1000'],
        ['anthropic', 'm\rmax_run_usd=1000'],
        ['openai\nmax_run_usd=1000', ''],
        ['openai', 'gpt-6-luna\t'],
        ['openai', 'gpt\u001b[0m']
      ]) {
        const r = dispatched(provider, model)
        expect(r.status, JSON.stringify([provider, model])).toBe(1)
        expect(r.log).toContain('::error::The provider and model inputs must not hold a newline or other control character.')
        expect(r.out).toEqual({})
      }
    })
  })

  describe('concurrency', () => {
    // A single cancel-in-progress group let any dispatch or re-run kill another session's
    // run in flight: two live runs died that way on 2026-11-12.
    it('queues runs of the same provider and model, and never cancels one in progress', () => {
      expect(evals.concurrency).toEqual({
        group: `eval-live-${R('provider')}-${R('key')}`,
        'cancel-in-progress': false
      })
    })

    // The leg's model, not the event: a scheduled leg lands in the same group as a dispatch of
    // that model, recording or grading, so the two wait for each other rather than share a
    // rate limit, which would read as a regression or lower the baseline being recorded.
    it('keys the group on what a run scores, never on its event, ref, run or mode', () => {
      expect(evals.concurrency.group).not.toMatch(/github\.|inputs\./)
    })

    describe.skipIf(process.platform === 'win32')('per leg', () => {
      it('gives each scheduled leg a group of its own', () => {
        const groups = [HAIKU, LUNA, FLASH_LITE].map((l) => groupFor(scheduled(l.cron).out))
        expect(groups).toEqual([
          'eval-live-anthropic-claude-haiku-5-5',
          'eval-live-openai-gpt-6-luna',
          'eval-live-gemini-gemini-3.5-flash-lite'
        ])
      })

      it('shares each leg group with a dispatch of that model, and keeps others apart', () => {
        expect(groupFor(dispatched('anthropic').out)).toBe(groupFor(scheduled(HAIKU.cron).out))
        expect(groupFor(dispatched('openai', 'gpt-6-luna').out)).toBe(groupFor(scheduled(LUNA.cron).out))
        expect(groupFor(dispatched('gemini', 'gemini-3.5-flash-lite').out)).toBe(groupFor(scheduled(FLASH_LITE.cron).out))
        expect(groupFor(dispatched('openai').out)).toBe('eval-live-openai-default')
        expect(groupFor(dispatched('anthropic', 'claude-opus-5-5').out)).toBe('eval-live-anthropic-claude-opus-5-5')
      })
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
      // A dispatch is named after its provider and model, a scheduled run after its cron, and
      // the job after the leg the resolve job picked.
      expect(doc['run-name']).toBe(
        "Task evals (live): ${{ github.event_name == 'schedule' && format('scheduled {0}', github.event.schedule) || " +
          "format('{0}/{1}{2}', inputs.provider || 'anthropic', inputs.model || ((inputs.provider || 'anthropic') == 'anthropic' && " +
          "'claude-haiku-5-5' || 'default'), inputs.record && ', recording' || '') }}"
      )
      expect(evals.name).toBe(`evals (${R('provider')}/${R('key')})`)
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
        name: R('artifact'),
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
          'echo "gemini=${GEMINI_API_KEY:-}"',
          'echo "api_key=${API_KEY-unset}"',
          'exit "${STUB_STATUS:-0}"'
        ].join('\n')
      })
    })
    afterAll(() => rmSync(bin, { recursive: true, force: true }))
    const scoreWith = (env: Record<string, string>) => {
      const r = runStep(score.run, { PROVIDER: 'anthropic', API_KEY: 'sk-test', ...env }, bin)
      const seen = Object.fromEntries(
        r.log
          .split('\n')
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
      )
      return { ...r, seen }
    }

    it("runs the suite with the record path set and the key under the provider's own name", () => {
      const r = scoreWith({})
      expect(r.status, r.log).toBe(0)
      expect(r.seen).toEqual({ args: 'run eval', out: 'eval-run.json', anthropic: 'sk-test', openai: '', gemini: '', api_key: 'unset' })
      // The resolve job names the artifact; this step writes no output.
      expect(r.out).toEqual({})
      expect(scoreWith({ PROVIDER: 'openai' }).seen).toMatchObject({ anthropic: '', openai: 'sk-test', gemini: '' })
      expect(scoreWith({ PROVIDER: 'gemini' }).seen).toMatchObject({ anthropic: '', openai: '', gemini: 'sk-test' })
    })

    it('fails on a failed suite', () => {
      expect(scoreWith({ STUB_STATUS: '1' }).status).toBe(1)
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
    // A failed resolve job (a cron with no leg) skips the whole job, so nothing is spent.
    expect(evals.if).toBeUndefined()
    expect(evals['continue-on-error']).toBeUndefined()
    expect(resolveJob['continue-on-error']).toBeUndefined()
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

  describe('the run caps', () => {
    // HOUSTON_EVAL_MAX_RUN_USD, which the driver enforces: once a run has spent it, no
    // attempt starts and the run fails. Each scheduled leg's cap sits over its recorded run
    // (Haiku $0.67, luna $0.45, flash-lite $8.62, three attempts each), and a dispatch,
    // which may pick any model at up to five attempts, gets the widest.
    it('caps each scheduled leg for its model, below the dispatch cap', () => {
      const caps = Object.fromEntries(scheduledLegs(doc).map((l) => [l.model, l.maxRunUsd]))
      expect(caps).toEqual({ 'claude-haiku-5-5': '5', 'gpt-6-luna': '5', 'gemini-3.5-flash-lite': '20' })
      // flash-lite has no prompt caching: one run costs $8.62, so a 5 cap would stop every one partway.
      expect(Number(caps['gemini-3.5-flash-lite'])).toBeGreaterThan(2 * 8.62)
      for (const cap of Object.values(caps)) expect(Number(cap)).toBeLessThan(Number(DISPATCH_CAP))
    })

    it('hands the driver each cap in a form it reads as that many dollars', () => {
      for (const cap of [...scheduledLegs(doc).map((l) => l.maxRunUsd), DISPATCH_CAP]) {
        expect(resolveEvalConfig({ HOUSTON_EVAL_MAX_RUN_USD: cap }, []).maxRunUsd, cap).toBe(Number(cap))
      }
    })

    it.skipIf(process.platform === 'win32')('gives a dispatch the dispatch cap whatever it scores', () => {
      for (const [provider, model] of [
        ['anthropic', ''],
        ['gemini', 'gemini-3.5-flash-lite'],
        ['openai', 'gpt-6.1-sol']
      ]) {
        expect(dispatched(provider, model).out.max_run_usd, `${provider}/${model}`).toBe(DISPATCH_CAP)
      }
    })
  })

  describe('alerting', () => {
    // The scheduled legs are the only quality gate: one that never finished is a missed slot.
    it('reports a scheduled run that failed or was cancelled, and no dispatched run', () => {
      expect(alert.needs).toEqual(['resolve', 'evals'])
      expect(alert.uses).toBe('./.github/workflows/alert-on-failure.yml')
      expect(alert.permissions).toEqual({ issues: 'write' })
      expect(alert.if).toBe("${{ always() && github.event_name == 'schedule' }}")
      // `failed: false` closes the open issue, so a cancellation has to count as a failure.
      // A failed resolve job (a cron with no leg) skips evals, and still counts.
      expect(alert.with.failed).toBe("${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}")
    })

    // The shared alert keeps one issue per title, and a green run closes it: one title for
    // every leg would let a green weekly Haiku run close a red monthly luna run's issue.
    it('files each leg under its own issue, and a run with no leg under the workflow', () => {
      expect(alert.with.workflow).toBe(
        "${{ needs.resolve.outputs.key && format('Task evals (live): {0}/{1}', needs.resolve.outputs.provider, " +
          "needs.resolve.outputs.key) || 'Task evals (live)' }}"
      )
      expect(alertOnFailure.jobs.alert.env.TITLE).toBe('${{ inputs.workflow }} is failing')
    })

    // Called from a cancelled run, the alert job's default `success()` would skip it.
    it('lets the shared alert run in a cancelled run only when it was told the run failed', () => {
      expect(alertOnFailure.jobs.alert.if).toBe('${{ !cancelled() || inputs.failed }}')
    })
  })

  it('passes event data through env, never interpolated into a script', () => {
    for (const [name, job] of Object.entries(doc.jobs as Record<string, any>)) {
      for (const step of job.steps ?? []) if (step.run) expect(step.run, `${name}: ${step.name}`).not.toContain('${{')
    }
    // The resolve script is the one that reads the event, so check it was found.
    expect(leg.run).toContain('case "$SCHEDULE" in')
  })

  it('pins every action to a commit SHA', () => {
    for (const job of Object.values(doc.jobs as Record<string, any>)) {
      for (const step of job.steps ?? []) if (step.uses?.startsWith('actions/')) expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
    }
  })
})
