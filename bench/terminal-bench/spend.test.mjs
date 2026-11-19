import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main, markdownTable, readJob, reportedCost, totalCost } from './spend.mjs'

const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** One ACP events line the way Harbor's runner writes it (Python's json.dumps spacing). */
const usageLine = (amount) =>
  JSON.stringify({
    event_type: 'session_update',
    payload: { session_id: 's1', update: { cost: { amount, currency: 'USD' }, size: 1000000, used: 5000, sessionUpdate: 'usage_update' } }
  }).replace(/":/g, '": ')
const messageLine = JSON.stringify({
  event_type: 'session_update',
  payload: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'usage_update is just a word here' } } }
})

function write(path, content) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
}

/**
 * A job with a solved trial, one still running (its last events line half-written), one whose
 * agent crashed before replying, a trial that has not started its agent yet, and Harbor's own
 * job-level files, which are not trials.
 */
function fixtureJob() {
  const job = mkdtempSync(join(tmpdir(), 'tb-job-'))
  dirs.push(job)
  write(join(job, 'result.json'), { stats: {} })
  write(join(job, 'job.log'), 'log')

  const solved = join(job, 'sound-change-cascade__UqtgkRU')
  write(join(solved, 'result.json'), {
    task_name: 'terminal-bench/sound-change-cascade',
    config: { agent: { model_name: 'anthropic/claude-opus-5-5' } },
    agent_info: { version: '0.12.0+main.f49a4a7b' },
    verifier_result: { rewards: { reward: 1.0 } },
    exception_info: null,
    agent_execution: { started_at: '2026-11-14T22:29:56.688593Z', finished_at: '2026-11-14T22:41:56.688593Z' },
    finished_at: '2026-11-14T22:42:30.000000Z'
  })
  write(join(solved, 'agent', 'acp-summary.json'), {
    requested_model: 'anthropic/claude-opus-5-5',
    prompt_response: {
      stopReason: 'end_turn',
      usage: { inputTokens: 1575865, cachedReadTokens: 1476142, cachedWriteTokens: 99665, outputTokens: 61947 }
    },
    latest_usage_update: { cost: { amount: 2.033, currency: 'USD' }, sessionUpdate: 'usage_update' }
  })
  write(join(solved, 'agent', 'acp-events.jsonl'), `${[usageLine(0.4), usageLine(2.033)].join('\n')}\n`)

  const running = join(job, 'fin-saccr-rwa__wJRWh3F')
  write(join(running, 'agent', 'acp-events.jsonl'), `${[usageLine(0.25), messageLine, usageLine(0.75), '{"event_type": "session_up'].join('\n')}`)

  const crashed = join(job, 'medical-claims-processing__48EDcGH')
  write(join(crashed, 'result.json'), {
    task_name: 'terminal-bench/medical-claims-processing',
    config: { agent: { model_name: 'anthropic/claude-haiku-5-5' } },
    agent_info: { version: '0.12.0+main.e5a26f14' },
    verifier_result: null,
    exception_info: { exception_type: 'NonZeroAgentExitCodeError' },
    finished_at: '2026-11-14T23:00:00.000000Z'
  })
  write(join(crashed, 'agent', 'acp-summary.json'), {
    prompt_response: null,
    latest_usage_update: { cost: { amount: 0.164, currency: 'USD' }, sessionUpdate: 'usage_update' }
  })
  write(join(crashed, 'verifier', 'reward.txt'), '0\n')

  mkdirSync(join(job, 'ks-solver-cpp__jAnjspb', 'agent'), { recursive: true })
  mkdirSync(join(job, 'not-a-trial'), { recursive: true })
  return job
}

function capture() {
  const out = { text: '', write: (s) => (out.text += s) }
  return out
}

describe('reportedCost', () => {
  it('reads the highest running cost Houston reported', () => {
    expect(reportedCost([usageLine(0.5), usageLine(1.25), usageLine(1.0)].join('\n'))).toBe(1.25)
  })

  it('skips other updates, a half-written last line, and updates with no numeric cost', () => {
    const noCost = JSON.stringify({ payload: { update: { sessionUpdate: 'usage_update', used: 10 } } })
    const textCost = JSON.stringify({ payload: { update: { sessionUpdate: 'usage_update', cost: { amount: '9' } } } })
    expect(reportedCost([messageLine, usageLine(0.3), noCost, textCost, '{"payload": {"update": {"sessionUpdate": "usage_up'].join('\n'))).toBe(0.3)
  })

  it('is null when no cost was reported yet', () => {
    expect(reportedCost('')).toBeNull()
    expect(reportedCost(messageLine)).toBeNull()
  })
})

describe('readJob', () => {
  it('reads every started trial, in task order, and nothing else', () => {
    const rows = readJob(fixtureJob())
    expect(rows.map((r) => r.trial)).toEqual([
      'fin-saccr-rwa__wJRWh3F',
      'ks-solver-cpp__jAnjspb',
      'medical-claims-processing__48EDcGH',
      'sound-change-cascade__UqtgkRU'
    ])
  })

  it('takes reward, build, tokens and cost from a finished trial', () => {
    const solved = readJob(fixtureJob()).find((r) => r.task === 'sound-change-cascade')
    expect(solved).toEqual({
      trial: 'sound-change-cascade__UqtgkRU',
      task: 'sound-change-cascade',
      model: 'claude-opus-5-5',
      version: '0.12.0+main.f49a4a7b',
      finished: true,
      reward: 1,
      inputTokens: 1575865,
      cachedReadTokens: 1476142,
      outputTokens: 61947,
      cost: 2.033,
      unpriced: false,
      stopReason: 'end_turn',
      error: null,
      agentMinutes: 12
    })
  })

  it('counts a running trial from its live events and a crashed one from its summary', () => {
    const rows = readJob(fixtureJob())
    const running = rows.find((r) => r.task === 'fin-saccr-rwa')
    expect(running).toMatchObject({ finished: false, cost: 0.75, reward: null, inputTokens: null, model: null })
    const crashed = rows.find((r) => r.task === 'medical-claims-processing')
    expect(crashed).toMatchObject({ finished: true, cost: 0.164, reward: 0, error: 'NonZeroAgentExitCodeError', inputTokens: null })
    expect(rows.find((r) => r.task === 'ks-solver-cpp')).toMatchObject({ cost: null, finished: false })
    expect(totalCost(rows)).toBeCloseTo(2.947, 6)
  })

  it('renders the results table with a totals row', () => {
    const table = markdownTable(readJob(fixtureJob()))
    expect(table).toContain(
      '| sound-change-cascade | claude-opus-5-5 | 0.12.0+main.f49a4a7b | 1 | 1,575,865 | 1,476,142 | 61,947 | $2.03 | 12 min | end_turn |'
    )
    expect(table).toContain('| medical-claims-processing | claude-haiku-5-5 | 0.12.0+main.e5a26f14 | 0 | - | - | - | $0.16 | - | NonZeroAgentExitCodeError |')
    expect(table.trimEnd().split('\n').at(-1)).toBe('| **Total** | | | **1/4** | 1,575,865 | 1,476,142 | 61,947 | **$2.95** | | |')
  })
})

describe('spend.mjs', () => {
  it('prints a row per trial and the total, and exits 0 under the cap', () => {
    const out = capture()
    expect(main([fixtureJob(), '--cap', '3'], out, capture())).toBe(0)
    expect(out.text).toContain('sound-change-cascade__UqtgkRU\tclaude-opus-5-5\t1\t1575865\t1476142\t61947\t2.033\tdone')
    expect(out.text).toContain('fin-saccr-rwa__wJRWh3F\t-\t-\t-\t-\t-\t0.750\trunning')
    expect(out.text.trimEnd().split('\n').at(-1)).toBe('TOTAL $2.95 over 4 trials (2 finished)')
  })

  it('exits 3 once the total reaches the cap, counting the running trial', () => {
    const job = fixtureJob()
    // The finished trials alone (2.197) are under 2.5: only the running one's live cost tips it.
    expect(main([job, '--cap', '2.5'], capture(), capture())).toBe(3)
    expect(main([job, '--cap', String(totalCost(readJob(job)))], capture(), capture())).toBe(3)
    expect(main([job, '--cap', '2.95'], capture(), capture())).toBe(0)
  })

  it('refuses bad arguments and a missing job directory with exit 2', () => {
    const job = fixtureJob()
    for (const argv of [[], [job, '--cap'], [job, '--cap', '0'], [job, '--cap', '-1'], [job, '--cap', 'ten'], [job, '--bogus'], [job, job]]) {
      const err = capture()
      expect(main(argv, capture(), err)).toBe(2)
      expect(err.text).toContain('usage: spend.mjs')
    }
    const err = capture()
    expect(main([join(job, 'missing')], capture(), err)).toBe(2)
    expect(err.text).toContain('no job directory')
  })

  it('fails closed with --cap on a trial that did work but reported no cost', () => {
    const toolLine = JSON.stringify({ event_type: 'session_update', payload: { update: { sessionUpdate: 'tool_call', toolCallId: 't1' } } })
    const zeroCost = (job) => {
      // An unpriced model: Houston reports its cost as 0.
      const agent = join(job, 'unpriced-task__aaaa', 'agent')
      write(join(agent, 'acp-events.jsonl'), `${[usageLine(0), toolLine].join('\n')}\n`)
      return job
    }
    const noUsage = (job) => {
      // A model whose context window Houston doesn't know: no usage_update at all.
      write(join(job, 'unknown-window__bbbb', 'agent', 'acp-events.jsonl'), `${messageLine}\n${toolLine}\n`)
      return job
    }
    const finishedNoCost = (job) => {
      write(join(job, 'finished-free__cccc', 'agent', 'acp-summary.json'), {
        prompt_response: { stopReason: 'end_turn', usage: { inputTokens: 5000, outputTokens: 200 } },
        latest_usage_update: null
      })
      return job
    }
    for (const add of [zeroCost, noUsage, finishedNoCost]) {
      const job = add(fixtureJob())
      const err = capture()
      expect(main([job, '--cap', '100'], capture(), err), add.name).toBe(1)
      expect(err.text, add.name).toContain('reported no cost')
      // Still a plain report without a cap.
      expect(main([job], capture(), capture()), add.name).toBe(0)
    }
    // A trial still in its first step (text only, no usage yet) is not flagged, and a
    // dry run's refused first call (no work at all) is not either.
    const job = fixtureJob()
    write(join(job, 'first-step__dddd', 'agent', 'acp-events.jsonl'), `${messageLine}\n`)
    expect(main([job, '--cap', '100'], capture(), capture())).toBe(0)
    expect(readJob(job).filter((r) => r.unpriced)).toEqual([])
  })

  // chmod 000 blocks reads only for a non-root user on a POSIX system.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails instead of counting a trial as free when its events or summary cannot be read',
    () => {
      for (const file of ['acp-events.jsonl', 'acp-summary.json']) {
        const job = mkdtempSync(join(tmpdir(), 'tb-job-'))
        dirs.push(job)
        const agent = join(job, 'fin-saccr-rwa__wJRWh3F', 'agent')
        write(join(agent, 'acp-events.jsonl'), `${usageLine(50)}\n`)
        write(join(agent, 'acp-summary.json'), { latest_usage_update: { cost: { amount: 50, currency: 'USD' }, sessionUpdate: 'usage_update' } })
        expect(main([job, '--cap', '10'], capture(), capture()), file).toBe(3)

        chmodSync(join(agent, file), 0o000)
        const out = capture()
        const err = capture()
        expect(main([job, '--cap', '10'], out, err), file).toBe(1)
        expect(out.text, file).toBe('')
        expect(err.text, file).toContain("cannot read the job's spend")
        expect(err.text, file).toContain('EACCES')
        chmodSync(join(agent, file), 0o644)
      }
    }
  )
})
