// Turning the action's inputs into one headless Houston CLI invocation, and reading its
// `--json` output back. Pure, so the security-relevant choices (approval policy,
// permission rules, the arguments) are pinned by unit tests.

/**
 * The read-only GitHub tools a run may call without a prompt. They return issue, pull
 * request, and CI text inside Houston's untrusted-content fence. Every other networked
 * tool (the GitHub write tools, web fetch and search, MCP) prompts, and an unattended run
 * answers every prompt with a denial (`--on-approval deny`).
 */
export const GITHUB_READ_TOOLS = [
  'gh_issue_view',
  'gh_issue_list',
  'gh_pr_view',
  'gh_pr_list',
  'gh_pr_checks',
  'gh_run_list',
  'gh_run_view'
]

/**
 * Denied by rule as well, so no `allowed-tools` entry or later default can open them: the
 * web tools are how a prompt-injected run would send repository content elsewhere, the
 * action, not the agent, is what writes to GitHub, and the session, scheduling, and
 * writable-subagent tools start work outside this one run's budget and review.
 */
export const ALWAYS_DENIED_TOOLS = [
  'web_fetch',
  'web_search',
  'dispatch_writable_agent',
  'spawn_session',
  'propose_session',
  'schedule_run',
  'cancel_scheduled_run',
  'pr_sweep',
  'gh_pr_create',
  'gh_pr_comment',
  'gh_pr_checkout',
  'gh_pr_review',
  'gh_pr_merge',
  'gh_pr_set_state',
  'gh_repo_create',
  'gh_issue_create',
  'gh_issue_comment',
  'gh_issue_set_state'
]

/** The tools each mode's prompt asks for, kept in any `allowed-tools` list. */
export const MODE_TOOLS = {
  respond: ['gh_issue_view', 'gh_pr_view'],
  review: ['review_changes', 'gh_pr_view'],
  'fix-ci': ['gh_run_view']
}

export const APPROVAL_POLICIES = ['plan', 'ask', 'auto-edit', 'full-auto']

/**
 * The approval policy for a run. Unset (or `default`) picks the safe one per mode:
 * read-only plan mode to answer or review, sandboxed full-auto to fix CI.
 */
export function resolveApproval(mode, input) {
  const v = (input ?? '').trim()
  if (v === '' || v === 'default') return mode === 'fix-ci' ? 'full-auto' : 'plan'
  if (!APPROVAL_POLICIES.includes(v)) {
    throw new Error(`approval must be one of default, ${APPROVAL_POLICIES.join(', ')} (got ${JSON.stringify(v)})`)
  }
  return v
}

/** Split an `allowed-tools` input (commas, spaces, or newlines) into tool names. */
export function parseToolList(input) {
  const names = (input ?? '').split(/[\s,]+/).filter(Boolean)
  for (const n of names) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(n)) throw new Error(`allowed-tools: ${JSON.stringify(n)} is not a tool name`)
  }
  return [...new Set(names)]
}

/**
 * The user-level permission rules written into the run's private profile. The first
 * matching rule wins, so the denials come first. With `allowed-tools`, the listed tools
 * (plus the mode's own) are the only ones that run at all.
 *
 * TODO(D3 headless flags): once `--allowed-tools` lands in headless, pass the list there
 * and keep only the denials here.
 */
export function permissionRules(mode, allowedTools = []) {
  const deny = ALWAYS_DENIED_TOOLS.map((tool) => ({ action: 'deny', tool, match: '*' }))
  const reads = GITHUB_READ_TOOLS.map((tool) => ({ action: 'allow', tool, match: '*' }))
  if (allowedTools.length === 0) return [...deny, ...reads]
  const allowed = [...new Set([...allowedTools, ...(MODE_TOOLS[mode] ?? [])])].filter(
    (t) => !ALWAYS_DENIED_TOOLS.includes(t)
  )
  return [...deny, ...allowed.map((tool) => ({ action: 'allow', tool, match: '*' })), { action: 'deny', tool: '*', match: '*' }]
}

/** The env var the standalone CLI reads a provider's key from (see src/shared/provider-keys.ts). */
export function keyEnvName(providerId) {
  return `HOUSTON_API_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/** A provider id as the CLI's settings store it. */
export function isValidProviderId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)
}

/**
 * The CLI's arguments. The prompt goes on stdin (`-p -`), never in argv, so its text is
 * not a process argument and can't be read as a flag.
 */
export function cliArgs({ cwd, provider, model, approval, maxTurns, maxCost, verify, effort }) {
  const args = ['-p', '-', '--json', '--cwd', cwd, '--approval', approval, '--on-approval', 'deny']
  if (provider) args.push('--provider', provider)
  if (model) args.push('--model', model)
  // `--flag=value` keeps a value that starts with `-` from being read as a flag.
  if (maxTurns) args.push(`--max-turns=${maxTurns}`)
  if (maxCost) args.push(`--max-cost=${maxCost}`)
  if (effort) args.push(`--effort=${effort}`)
  if (verify) args.push(`--verify=${verify}`)
  // TODO(D3 headless flags): `--output-format stream-json` and `--output-schema` (a
  // structured review) slot in here once they land; `--json` is today's event stream.
  return args
}

/** Validate the numeric budget inputs up front, with the input's name in the message. */
export function budgetInputs({ maxTurns, maxCost }) {
  const turns = (maxTurns ?? '').trim()
  const cost = (maxCost ?? '').trim()
  if (turns && !/^[1-9][0-9]{0,5}$/.test(turns)) throw new Error(`max-turns must be a whole number of at least 1 (got ${JSON.stringify(turns)})`)
  if (cost && !(/^[0-9]+(\.[0-9]+)?$/.test(cost) && Number(cost) > 0)) {
    throw new Error(`max-cost must be a positive amount in US dollars, like 2 or 0.5 (got ${JSON.stringify(cost)})`)
  }
  return { maxTurns: turns || undefined, maxCost: cost || undefined }
}

/**
 * Fold the CLI's `--json` stdout into what the action acts on: the closing `result` line,
 * the tools that ran, whether a final verification passed, and any error messages.
 */
export function parseRunOutput(stdout) {
  const tools = []
  const errors = []
  let result = null
  let verification = null
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'result') result = e
    else if (e.type === 'tool_start' && typeof e.name === 'string') tools.push(e.name)
    else if (e.type === 'verification') verification = e.passed === true
    else if (e.type === 'error' && typeof e.message === 'string') errors.push(e.message)
  }
  return { result, tools, errors, verification }
}
