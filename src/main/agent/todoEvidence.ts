import type { CheckKind } from '@shared/evidence'
import type { Todo } from '@shared/todos'

/**
 * Todo items that claim a check ran, held against what actually ran.
 *
 * A model can mark "Backend tests with pytest" completed when pytest never ran. The
 * todo list is the model's own, so Houston doesn't rewrite or refuse it: an item it
 * marks done is accepted as written. What Houston adds is the fact beside it: the
 * moment an item that names a check is marked completed with no matching successful
 * run this turn, the todo_write result says so (the model reads it on the next step,
 * at no extra cost), and the turn's receipt lists any that are still unbacked at the
 * end.
 *
 * Only items about running or verifying something count. "Write tests with pytest" is
 * about writing, and never needs a test run behind it; nothing pushes the model to
 * reword its list, because nothing is refused.
 */

/** What an item needs a passing run of: a check kind, or any check of the code. */
export type RequiredCheck = CheckKind | 'any'

/** The ledger's answer to "did a check of this kind pass this turn?". */
export interface CheckOracle {
  passed(kind: RequiredCheck): boolean
}

/** Items that start by making something are about writing it, not running it. */
const MAKES = /^(write|add|create|implement|scaffold|set ?up|update|fix|refactor|draft|build|design|plan)\b/i
/** Words that make a "write" item also about running it ("write and run the tests"). */
const RUNS = /\b(run|runs|running|execute|verify|verified|verification|validate|confirm)\b/i

const NEEDS: Array<[RegExp, RequiredCheck]> = [
  [/\b(pytest|vitest|jest|mocha|unittest|tests?|testing|specs?|go test|cargo test)\b/i, 'test'],
  [/\b(type-?check\w*|tsc|mypy|pyright)\b/i, 'typecheck'],
  [/\b(builds?|compiles?|compiling|bundles?)\b/i, 'build'],
  [/\blint\w*\b/i, 'lint'],
  [/\b(curl|wget|httpie|endpoints?|http requests?)\b/i, 'http'],
  [/\b(browser|view_localhost|e2e|end-to-end|playwright)\b/i, 'browser']
]

/** Words that ask for a check without naming one ("verify everything works"). */
const GENERIC = /\b(verify|verified|verification|validate|smoke[- ]test|confirm (it|that|everything))\b/i

/** The checks a todo item claims ran, or none when it isn't about running one. */
export function requiredChecks(item: string): RequiredCheck[] {
  const text = item.trim()
  if (MAKES.test(text) && !RUNS.test(text)) return []
  const kinds = NEEDS.filter(([re]) => re.test(text)).map(([, k]) => k)
  if (kinds.length) return [...new Set(kinds)]
  return GENERIC.test(text) ? ['any'] : []
}

const NEED_TEXT: Record<RequiredCheck, string> = {
  test: 'test run',
  typecheck: 'typecheck',
  build: 'build',
  lint: 'lint run',
  http: 'HTTP request',
  browser: 'browser check that checked the page',
  install: 'install',
  server: 'server start',
  verify: 'verify command',
  any: 'check'
}

/**
 * The checks a plan's verification step stands for. Unlike a todo item, every step is
 * a check by definition, so one that names no particular kind ("add a todo and see it
 * listed") needs a passing check of any kind.
 */
export function checksNamedBy(step: string): RequiredCheck[] {
  const kinds = NEEDS.filter(([re]) => re.test(step)).map(([, k]) => k)
  return kinds.length ? [...new Set(kinds)] : ['any']
}

/** An item marked completed this turn with nothing recorded behind it. */
export interface TodoGap {
  item: string
  missing: RequiredCheck[]
}

/**
 * Items that went to `completed` between `before` and `after` (matched by text, so an
 * item already completed earlier is never flagged again) and that claim a check no
 * passing run backs.
 */
export function todoEvidenceGaps(before: Todo[], after: Todo[], ledger: CheckOracle): TodoGap[] {
  const doneBefore = new Set(before.filter((t) => t.status === 'completed').map((t) => t.content))
  const gaps: TodoGap[] = []
  for (const t of after) {
    if (t.status !== 'completed' || doneBefore.has(t.content)) continue
    const missing = requiredChecks(t.content).filter((k) => !ledger.passed(k))
    if (missing.length) gaps.push({ item: t.content, missing })
  }
  return gaps
}

/** The line todo_write adds to its result for the model, one per gap. */
export function todoGapNote(g: TodoGap): string {
  const what = g.missing.map((k) => NEED_TEXT[k]).join(', ')
  return `[note: "${g.item}" is marked completed, but Houston has no passing ${what} recorded this turn. If it didn't run, keep the item open or say so when you report.]`
}
