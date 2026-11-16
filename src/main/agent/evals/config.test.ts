import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@shared/types'
import {
  DEFAULT_LIVE_ATTEMPTS,
  SCRIPTED_MODEL,
  envOr,
  resolveEvalConfig,
  selectTasks,
  type Env
} from './config'
import { DEFAULT_ATTEMPT_MAX_COST_USD } from './costCaps'

const providers = [
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic', models: [], defaultModel: 'claude-opus-4-8' },
  { id: 'nodefault', kind: 'openai-compatible', label: 'No default', models: [] }
] as unknown as ProviderConfig[]

const live = (env: Env = {}): Env => ({ HOUSTON_EVAL_LIVE: '1', ...env })

describe('envOr', () => {
  it('returns the value when set', () => {
    expect(envOr({ A: 'x' }, 'A', 'fallback')).toBe('x')
  })

  it('falls back when unset', () => {
    expect(envOr({}, 'A', 'fallback')).toBe('fallback')
  })

  // THE bug: `??` returns '' here, silently skipping every default downstream.
  it('treats an empty env var as unset', () => {
    expect(envOr({ A: '' }, 'A', 'fallback')).toBe('fallback')
  })

  it('treats a whitespace-only env var as unset', () => {
    expect(envOr({ A: '   ' }, 'A', 'fallback')).toBe('fallback')
  })

  it('trims a set value', () => {
    expect(envOr({ A: '  x  ' }, 'A', 'fallback')).toBe('x')
  })
})

describe('resolveEvalConfig', () => {
  it('defaults to the scripted driver', () => {
    expect(resolveEvalConfig({}, providers)).toEqual({
      live: false,
      record: false,
      providerId: 'anthropic',
      model: SCRIPTED_MODEL,
      attempts: 1,
      trace: false,
      maxCostUsd: DEFAULT_ATTEMPT_MAX_COST_USD
    })
  })

  it('resolves the provider default model in live mode', () => {
    expect(resolveEvalConfig(live(), providers).model).toBe('claude-opus-4-8')
  })

  /**
   * REGRESSION (the all-zero baseline incident). GitHub Actions' `env: FOO: ${{
   * inputs.foo || '' }}` sets the var to '' on a scheduled run, and the old `??`
   * let that through as the model id. Every live call then failed and
   * `eval:baseline` recorded 0 for all eight tasks — a permanently dead gate.
   */
  it('falls back to the default model when HOUSTON_EVAL_MODEL is set but EMPTY', () => {
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_MODEL: '' }), providers).model).toBe('claude-opus-4-8')
  })

  it('falls back to the default provider when HOUSTON_EVAL_PROVIDER is set but EMPTY', () => {
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_PROVIDER: '' }), providers).providerId).toBe('anthropic')
  })

  it('honors an explicit model', () => {
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_MODEL: 'claude-haiku-4-5' }), providers).model).toBe(
      'claude-haiku-4-5'
    )
  })

  it('never resolves an empty model id in live mode', () => {
    // Both spellings of "no model available" must throw, never yield ''.
    expect(() => resolveEvalConfig(live({ HOUSTON_EVAL_PROVIDER: 'nodefault' }), providers)).toThrow(
      /No model to evaluate/
    )
  })

  it('rejects an unknown provider with the known ids', () => {
    expect(() => resolveEvalConfig(live({ HOUSTON_EVAL_PROVIDER: 'nope' }), providers)).toThrow(
      /not a known provider id.*anthropic/s
    )
  })

  it('ignores the provider check in scripted mode', () => {
    // Scripted never reaches an adapter, so an odd provider id is harmless.
    expect(resolveEvalConfig({ HOUSTON_EVAL_PROVIDER: 'whatever' }, providers).model).toBe(SCRIPTED_MODEL)
  })

  describe('attempts', () => {
    it('defaults to 1 scripted and 3 live', () => {
      expect(resolveEvalConfig({}, providers).attempts).toBe(1)
      expect(resolveEvalConfig(live(), providers).attempts).toBe(DEFAULT_LIVE_ATTEMPTS)
    })

    it('honors an explicit count', () => {
      expect(resolveEvalConfig(live({ HOUSTON_EVAL_ATTEMPTS: '5' }), providers).attempts).toBe(5)
    })

    // Same empty-env-var trap: the workflow interpolates this one too.
    it('falls back when set but empty', () => {
      expect(resolveEvalConfig(live({ HOUSTON_EVAL_ATTEMPTS: '' }), providers).attempts).toBe(
        DEFAULT_LIVE_ATTEMPTS
      )
    })

    it.each(['0', '-1', '1.5', 'three'])('rejects %s rather than silently defaulting', (raw) => {
      expect(() => resolveEvalConfig(live({ HOUSTON_EVAL_ATTEMPTS: raw }), providers)).toThrow(
        /positive integer/
      )
    })
  })

  it('reads the record flag', () => {
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_RECORD: '1' }), providers).record).toBe(true)
    expect(resolveEvalConfig(live(), providers).record).toBe(false)
  })

  it('reads the run-record path in either driver', () => {
    expect(resolveEvalConfig({ HOUSTON_EVAL_OUT: 'a.json' }, providers).out).toBe('a.json')
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_OUT: ' b.json ' }), providers).out).toBe('b.json')
  })

  // The scheduled workflow passes empty inputs through; '' must not become a file named ''.
  it('leaves the run-record path unset when it is empty', () => {
    expect('out' in resolveEvalConfig(live({ HOUSTON_EVAL_OUT: '' }), providers)).toBe(false)
  })

  it('reads the trace flag in either driver', () => {
    expect(resolveEvalConfig({ HOUSTON_EVAL_TRACE: '1' }, providers).trace).toBe(true)
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_TRACE: '1' }), providers).trace).toBe(true)
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_TRACE: '' }), providers).trace).toBe(false)
  })

  it('reads the task subset in either driver, and leaves it unset when empty', () => {
    expect(resolveEvalConfig({ HOUSTON_EVAL_TASKS: 'hard' }, providers).tasks).toBe('hard')
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_TASKS: ' a,b ' }), providers).tasks).toBe('a,b')
    expect('tasks' in resolveEvalConfig(live({ HOUSTON_EVAL_TASKS: '' }), providers)).toBe(false)
  })

  // A recorded subset would replace the baseline file and drop the other tasks from the gate.
  it('refuses to record a baseline for a subset of the tasks', () => {
    expect(() =>
      resolveEvalConfig(live({ HOUSTON_EVAL_RECORD: '1', HOUSTON_EVAL_TASKS: 'hard' }), providers)
    ).toThrow(/records every task/)
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_RECORD: '1', HOUSTON_EVAL_TASKS: '' }), providers).record).toBe(
      true
    )
  })

  describe('cost caps', () => {
    // Always a per-attempt cap: the default is a runaway guard, never "none".
    it('caps every attempt at the default, in either driver', () => {
      expect(resolveEvalConfig({}, providers).maxCostUsd).toBe(DEFAULT_ATTEMPT_MAX_COST_USD)
      expect(resolveEvalConfig(live(), providers).maxCostUsd).toBe(DEFAULT_ATTEMPT_MAX_COST_USD)
    })

    // capsEnforceable refuses a cap someone set on an unpriced model, and only warns
    // about the default, so the config must tell the two apart even at the same amount.
    it('says whether the per-attempt cap was set or defaulted', () => {
      expect('maxCostUsdSet' in resolveEvalConfig(live(), providers)).toBe(false)
      expect('maxCostUsdSet' in resolveEvalConfig(live({ HOUSTON_EVAL_MAX_COST_USD: '' }), providers)).toBe(false)
      const atDefault = resolveEvalConfig(live({ HOUSTON_EVAL_MAX_COST_USD: String(DEFAULT_ATTEMPT_MAX_COST_USD) }), providers)
      expect(atDefault).toMatchObject({ maxCostUsd: DEFAULT_ATTEMPT_MAX_COST_USD, maxCostUsdSet: true })
      expect(resolveEvalConfig({ HOUSTON_EVAL_MAX_COST_USD: '5' }, providers)).toMatchObject({ maxCostUsdSet: true })
    })

    it('has no run cap unless one is set', () => {
      expect('maxRunUsd' in resolveEvalConfig(live(), providers)).toBe(false)
    })

    it('reads both caps in either driver', () => {
      const env = { HOUSTON_EVAL_MAX_COST_USD: '40', HOUSTON_EVAL_MAX_RUN_USD: ' 2.5 ' }
      expect(resolveEvalConfig(live(env), providers)).toMatchObject({ maxCostUsd: 40, maxRunUsd: 2.5 })
      expect(resolveEvalConfig(env, providers)).toMatchObject({ maxCostUsd: 40, maxRunUsd: 2.5 })
      expect(resolveEvalConfig(live({ HOUSTON_EVAL_MAX_RUN_USD: '.5' }), providers).maxRunUsd).toBe(0.5)
    })

    // The workflows pass unset inputs through as ''.
    it('treats an empty cap as unset', () => {
      const cfg = resolveEvalConfig(live({ HOUSTON_EVAL_MAX_COST_USD: '', HOUSTON_EVAL_MAX_RUN_USD: ' ' }), providers)
      expect(cfg.maxCostUsd).toBe(DEFAULT_ATTEMPT_MAX_COST_USD)
      expect('maxRunUsd' in cfg).toBe(false)
    })

    // A cap that fails to parse must stop the run, never become NaN (no cap) or 0.
    it.each(['0', '0.0', '-1', '$5', '5 USD', '1e2', '0x10', 'Infinity', 'NaN', 'five', '5,00'])(
      'rejects %s',
      (raw) => {
        expect(() => resolveEvalConfig(live({ HOUSTON_EVAL_MAX_COST_USD: raw }), providers)).toThrow(
          /HOUSTON_EVAL_MAX_COST_USD must be a positive amount in US dollars/
        )
        expect(() => resolveEvalConfig(live({ HOUSTON_EVAL_MAX_RUN_USD: raw }), providers)).toThrow(
          /HOUSTON_EVAL_MAX_RUN_USD must be a positive amount in US dollars/
        )
      }
    )
  })

  describe('hash-only mode', () => {
    // The prompt depends on the model (per-model notes), so hashing must resolve the
    // model a live run would use, not the scripted stand-in.
    it('resolves the live provider and model without going live', () => {
      expect(resolveEvalConfig({ HOUSTON_EVAL_HASH_OUT: 'h.txt' }, providers)).toMatchObject({
        live: false,
        hashOut: 'h.txt',
        providerId: 'anthropic',
        model: 'claude-opus-4-8'
      })
      expect(
        resolveEvalConfig({ HOUSTON_EVAL_HASH_OUT: 'h.txt', HOUSTON_EVAL_MODEL: 'claude-haiku-5-5' }, providers).model
      ).toBe('claude-haiku-5-5')
    })

    it('rejects an unknown provider and a missing model, as a live run would', () => {
      expect(() => resolveEvalConfig({ HOUSTON_EVAL_HASH_OUT: 'h.txt', HOUSTON_EVAL_PROVIDER: 'nope' }, providers)).toThrow(
        /not a known provider/
      )
      expect(() =>
        resolveEvalConfig({ HOUSTON_EVAL_HASH_OUT: 'h.txt', HOUSTON_EVAL_PROVIDER: 'nodefault' }, providers)
      ).toThrow(/No model to evaluate/)
    })

    // It stops before any model call, so it can't score a run or record a baseline.
    it('refuses to combine with a live run or a recording', () => {
      expect(() => resolveEvalConfig(live({ HOUSTON_EVAL_HASH_OUT: 'h.txt' }), providers)).toThrow(/only hashes/)
      expect(() => resolveEvalConfig({ HOUSTON_EVAL_HASH_OUT: 'h.txt', HOUSTON_EVAL_RECORD: '1' }, providers)).toThrow(
        /only hashes/
      )
    })

    // A workflow passes an unset input through as ''; that must not switch the mode on.
    it('stays off when the path is empty', () => {
      const cfg = resolveEvalConfig({ HOUSTON_EVAL_HASH_OUT: ' ' }, providers)
      expect('hashOut' in cfg).toBe(false)
      expect(cfg.model).toBe(SCRIPTED_MODEL)
    })
  })
})

describe('selectTasks', () => {
  const t = (id: string): { id: string } => ({ id })
  const all = [t('a'), t('b'), t('c'), t('d')]
  const hard = [t('c'), t('d')]
  const probes = [t('p1'), t('p2'), t('p3')]
  const ids = (s: { tasks: { id: string }[]; probes: { id: string }[] }): string[][] => [
    s.tasks.map((x) => x.id),
    s.probes.map((x) => x.id)
  ]

  // Probes are an A/B instrument: the scheduled run (no spec) and so a baseline never include them.
  it('runs every task and no probe when no subset is named', () => {
    expect(selectTasks(all, hard, undefined, probes)).toEqual({ tasks: all, probes: [] })
    expect(selectTasks(all, hard, '  ', probes)).toEqual({ tasks: all, probes: [] })
  })

  it('runs the harder subset for "hard"', () => {
    expect(ids(selectTasks(all, hard, 'hard', probes))).toEqual([['c', 'd'], []])
  })

  it('runs named ids in registry order', () => {
    expect(ids(selectTasks(all, hard, ' d, a ,', probes))).toEqual([['a', 'd'], []])
  })

  it('runs every probe for "probes", and one for probe:<id>, in registry order', () => {
    expect(ids(selectTasks(all, hard, 'probes', probes))).toEqual([[], ['p1', 'p2', 'p3']])
    expect(ids(selectTasks(all, hard, 'probe:p3, probe:p1', probes))).toEqual([[], ['p1', 'p3']])
    // Keywords and ids combine, and a repeat runs once.
    expect(ids(selectTasks(all, hard, 'probe:p2,hard,probes,c', probes))).toEqual([['c', 'd'], ['p1', 'p2', 'p3']])
  })

  // A typo must not shrink the run and still report green.
  it('rejects an id that is not registered', () => {
    expect(() => selectTasks(all, hard, 'a,nope', probes)).toThrow(/aren't registered: nope/)
    // A probe is named with its prefix, and a task id never takes one.
    expect(() => selectTasks(all, hard, 'p1', probes)).toThrow(/aren't registered: p1/)
    expect(() => selectTasks(all, hard, 'probe:a,probe:nope', probes)).toThrow(/aren't registered: probe:a, probe:nope/)
  })

  it('rejects a spec that selects nothing', () => {
    expect(() => selectTasks(all, hard, ',', probes)).toThrow(/selects no tasks/)
    // No probes registered: the keyword selects nothing rather than everything.
    expect(() => selectTasks(all, hard, 'probes')).toThrow(/selects no tasks/)
  })
})

describe('the harder subset', () => {
  it('is a non-empty, registered part of the task list', async () => {
    const { HARD_TASKS, TASKS } = await import('./tasks')
    expect(HARD_TASKS.length).toBeGreaterThan(0)
    expect(HARD_TASKS.length).toBeLessThan(TASKS.length)
    for (const task of HARD_TASKS) expect(TASKS).toContain(task)
    expect(selectTasks(TASKS, HARD_TASKS, 'hard').tasks).toEqual(HARD_TASKS)
  })
})
