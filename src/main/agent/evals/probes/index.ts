/**
 * The registered behavior probes (see ProbeTask in ../types.ts).
 *
 * Adding a probe: write `probes/<id>.ts` exporting a {@link ProbeTask} named `probe`,
 * with a passing and a failing script, then register it here. The suite asserts that
 * the file names and the registered ids agree in both directions, and runs both
 * scripts through the real loop.
 *
 * A SEPARATE REGISTRY, on purpose. Probes are an A/B instrument: they run only when
 * HOUSTON_EVAL_TASKS names them (`probes`, or `probe:<id>`), never in the scheduled
 * run, and a baseline never records them (config.ts and assertRecordable refuse it,
 * and the gate reads every `probe:` row as unrecorded). A probe grades a habit, so
 * its pass rate says how often a model shows it, not whether the harness regressed.
 *
 * COST, estimated. A probe is stopped once `maxActions` of its calls are answered, and
 * a run that ends sooner has made fewer calls, so an attempt makes about `maxActions`
 * model requests at most: 31 for the eight below together. A request carries the
 * system prompt and the eager tool schemas (about 34,000 characters, so roughly 10,000
 * tokens, for claude-haiku-5-5 as HOUSTON_EVAL_HASH_OUT builds it) plus a short
 * conversation, call it 11,000 input tokens, and up to about 1,000 output tokens with
 * reasoning. At claude-haiku-5-5's $0.10 per million input tokens and $0.50 per million
 * output, that is about $0.0016 a request with no prompt caching, so about $0.05 for
 * one attempt at every probe (31 x $0.0016), $0.15 for the default three, and $0.25 for
 * the five a side an eval-ab.yml A/B runs. An upper bound: most attempts stop before
 * their cap, and cached prompt reads cost a fraction of that. For scale, a recorded
 * three-attempt run of all 29 tasks cost $0.66.
 *
 * MEASURED. The first live run, eval-ab.yml's A/B on PR #962 (five attempts a side at
 * all eight probes on claude-haiku-5-5), cost about $0.04 a side, a fifth of the $0.20
 * its budget then allowed. That budget was 25: unchecked-visual-claim stopped at 6
 * actions, before any attempt of it had reported. At 12 those attempts run on to their
 * report, so a run now costs a little more. A scorecard prints the real figure, and a
 * local run with a key makes one (an agent's shell has no provider key):
 *
 *   HOUSTON_EVAL_LIVE=1 HOUSTON_EVAL_MODEL=claude-haiku-5-5 HOUSTON_EVAL_TASKS=probes npm run eval
 */
import type { ProbeTask } from '../types'
import { probe as actBeforeAsking } from './act-before-asking'
import { probe as existingFile } from './existing-file'
import { probe as fencedInjection } from './fenced-injection'
import { probe as fixMalformedCall } from './fix-malformed-call'
import { probe as noGuessedUrls } from './no-guessed-urls'
import { probe as planModeSwitch } from './plan-mode-switch'
import { probe as repeatedFailure } from './repeated-failure'
import { probe as uncheckedVisualClaim } from './unchecked-visual-claim'

export const PROBES: ProbeTask[] = [
  existingFile,
  actBeforeAsking,
  uncheckedVisualClaim,
  noGuessedUrls,
  fixMalformedCall,
  planModeSwitch,
  fencedInjection,
  repeatedFailure
]
