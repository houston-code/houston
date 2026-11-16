#!/usr/bin/env node
// Sum what Houston reports a Harbor job has cost so far, and tell run.sh when it reaches a cap.
//
//   node bench/terminal-bench/spend.mjs <job-dir> [--cap <usd>] [--markdown]
//
// Harbor's ACP runner writes each trial under <job-dir>/<trial>/: agent/acp-events.jsonl gets
// every ACP update as it arrives, agent/acp-summary.json the final usage once the agent stops,
// and result.json the reward once the verifier has run. Houston's `usage_update` carries the
// session's running cost (`cost.amount`, in USD) priced from its own model table, so a trial
// that is still running counts from its latest update instead of only once it finishes.
//
// Prints one tab-separated row per trial and a TOTAL line, or with --markdown the table
// RESULTS.md uses. With --cap, exits 3 once the total reaches the cap (the exit code a
// headless run uses for a limit). Exits 2 on bad arguments or a missing job directory, and 1
// when a trial's file exists but cannot be read, so the guard never counts it as free.
//
// The pure readers below are unit-tested in spend.test.mjs.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CAP_EXIT = 3
const USAGE = 'usage: spend.mjs <job-dir> [--cap <usd>] [--markdown]'

/**
 * A file's text, or null when it does not exist yet. Any other read error (a file the
 * container wrote with modes the host user cannot read, say) is thrown, so the spend check
 * fails instead of counting the trial as free.
 */
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}

/** A JSON file, or null when it does not exist yet or is still being written. */
function readJson(path) {
  const text = readIfPresent(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The cost in one ACP `usage_update`, or null when the update is something else or has none. */
function usageCost(update) {
  if (!update || update.sessionUpdate !== 'usage_update') return null
  const amount = update.cost?.amount
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null
}

/**
 * The highest running cost Houston reported in an ACP events log, or null when it reported
 * none. Lines that don't parse are skipped: the last one may be half-written while the trial
 * runs.
 */
export function reportedCost(eventsText) {
  let cost = null
  for (const line of eventsText.split('\n')) {
    if (!line.includes('usage_update')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const amount = usageCost(entry?.payload?.update)
    if (amount !== null) cost = cost === null ? amount : Math.max(cost, amount)
  }
  return cost
}

/** "terminal-bench/fin-saccr-rwa" or the trial dir "fin-saccr-rwa__wJRWh3F" -> "fin-saccr-rwa". */
function taskName(result, trial) {
  const name = typeof result?.task_name === 'string' ? result.task_name : trial.split('__')[0]
  return name.slice(name.lastIndexOf('/') + 1)
}

function rewardOf(result, dir) {
  const reward = result?.verifier_result?.rewards?.reward
  if (typeof reward === 'number') return reward
  const text = readIfPresent(join(dir, 'verifier', 'reward.txt'))?.trim() ?? ''
  return text === '' || Number.isNaN(Number(text)) ? null : Number(text)
}

function agentMinutes(result) {
  const started = Date.parse(result?.agent_execution?.started_at ?? '')
  const finished = Date.parse(result?.agent_execution?.finished_at ?? '')
  return Number.isNaN(started) || Number.isNaN(finished) ? null : (finished - started) / 60_000
}

const count = (n) => (typeof n === 'number' ? n : null)

/** One trial directory's model, build, reward, tokens and cost; every field may be null. */
export function readTrial(dir) {
  const trial = basename(dir)
  const result = readJson(join(dir, 'result.json'))
  const summary = readJson(join(dir, 'agent', 'acp-summary.json'))
  // Null until the agent has connected.
  const events = readIfPresent(join(dir, 'agent', 'acp-events.jsonl'))
  const costs = [usageCost(summary?.latest_usage_update), events === null ? null : reportedCost(events)]
    .filter((c) => c !== null)
  const usage = summary?.prompt_response?.usage ?? {}
  const model = result?.config?.agent?.model_name ?? summary?.requested_model ?? null
  return {
    trial,
    task: taskName(result, trial),
    model: typeof model === 'string' ? model.slice(model.lastIndexOf('/') + 1) : null,
    version: result?.agent_info?.version ?? summary?.registry_entry_version ?? null,
    finished: typeof result?.finished_at === 'string',
    reward: rewardOf(result, dir),
    inputTokens: count(usage.inputTokens),
    cachedReadTokens: count(usage.cachedReadTokens),
    outputTokens: count(usage.outputTokens),
    cost: costs.length ? Math.max(...costs) : null,
    stopReason: summary?.prompt_response?.stopReason ?? null,
    error: result?.exception_info?.exception_type ?? null,
    agentMinutes: agentMinutes(result)
  }
}

/** Every trial Harbor has started in a job directory, ordered by task. */
export function readJob(jobDir) {
  return readdirSync(jobDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(jobDir, e.name))
    .filter((dir) => existsSync(join(dir, 'agent')) || existsSync(join(dir, 'result.json')))
    .map(readTrial)
    .sort((a, b) => a.task.localeCompare(b.task) || a.trial.localeCompare(b.trial))
}

export function totalCost(rows) {
  return rows.reduce((sum, r) => sum + (r.cost ?? 0), 0)
}

const show = (v) => (v === null || v === undefined ? '-' : String(v))
const thousands = (n) => (n === null ? '-' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','))
const dollars = (n) => (n === null ? '-' : `$${n.toFixed(2)}`)

export function textReport(rows) {
  const lines = rows.map((r) =>
    [r.trial, show(r.model), show(r.reward), show(r.inputTokens), show(r.cachedReadTokens), show(r.outputTokens),
      r.cost === null ? '-' : r.cost.toFixed(3), r.finished ? 'done' : 'running'].join('\t')
  )
  const finished = rows.filter((r) => r.finished).length
  lines.push(`TOTAL $${totalCost(rows).toFixed(2)} over ${rows.length} trials (${finished} finished)`)
  return `${lines.join('\n')}\n`
}

/** The per-trial results table, with a closing row of totals and the solved count. */
export function markdownTable(rows) {
  const header = [
    '| Task | Model | Houston build | Reward | Input tokens | Cached input | Output tokens | Cost | Agent time | Ended |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ]
  const body = rows.map((r) =>
    `| ${[
      r.task,
      show(r.model),
      show(r.version),
      show(r.reward),
      thousands(r.inputTokens),
      thousands(r.cachedReadTokens),
      thousands(r.outputTokens),
      dollars(r.cost),
      r.agentMinutes === null ? '-' : `${Math.round(r.agentMinutes)} min`,
      show(r.error ?? r.stopReason)
    ].join(' | ')} |`
  )
  const sum = (key) => {
    const known = rows.map((r) => r[key]).filter((n) => n !== null)
    return known.length ? known.reduce((a, b) => a + b, 0) : null
  }
  const solved = rows.filter((r) => r.reward !== null && r.reward >= 1).length
  const total =
    `| **Total** | | | **${solved}/${rows.length}** | ${thousands(sum('inputTokens'))} | ` +
    `${thousands(sum('cachedReadTokens'))} | ${thousands(sum('outputTokens'))} | **${dollars(totalCost(rows))}** | | |`
  return `${[...header, ...body, total].join('\n')}\n`
}

function parseArgs(argv) {
  const opts = { jobDir: null, cap: null, markdown: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--markdown') opts.markdown = true
    else if (arg === '--cap') {
      const value = argv[++i]
      if (value === undefined || !/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
        throw new Error(`--cap needs a dollar amount above 0 (got ${value === undefined ? 'nothing' : JSON.stringify(value)})`)
      }
      opts.cap = Number(value)
    } else if (arg.startsWith('-') || opts.jobDir !== null) throw new Error(`unexpected argument: ${arg}`)
    else opts.jobDir = arg
  }
  if (opts.jobDir === null) throw new Error('a job directory is required')
  return opts
}

/** Runs the CLI and returns its exit code, so the test can drive it without a child process. */
export function main(argv, out = process.stdout, err = process.stderr) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    err.write(`spend.mjs: ${e.message}\n${USAGE}\n`)
    return 2
  }
  const jobDir = resolve(opts.jobDir)
  if (!existsSync(jobDir) || !statSync(jobDir).isDirectory()) {
    err.write(`spend.mjs: no job directory at ${opts.jobDir}\n`)
    return 2
  }
  let rows
  try {
    rows = readJob(jobDir)
  } catch (e) {
    err.write(`spend.mjs: cannot read the job's spend: ${e.message}\n`)
    return 1
  }
  out.write(opts.markdown ? markdownTable(rows) : textReport(rows))
  return opts.cap !== null && totalCost(rows) >= opts.cap ? CAP_EXIT : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
