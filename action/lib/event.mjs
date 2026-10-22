// Reading a GitHub event payload into what one Houston run needs, and deciding whether the
// event may start a run at all. Pure: every function takes the parsed payload and returns
// data, so the gates are unit-tested without a runner.
//
// Text from the payload (issue and comment bodies, titles, branch and workflow names) is
// written by whoever opened the issue, commented, or pushed. Nothing here interpolates it
// into a shell or a URL; it flows only into the prompt file and the reply.

export const MODES = /** @type {const} */ (['respond', 'review', 'fix-ci'])

/**
 * `author_association` values that can belong to someone with write access. It is a hint
 * (an org MEMBER may only have read access), so a respond run also asks the API for the
 * commenter's actual permission; this check just turns strangers away without a request.
 */
export const WRITE_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/** Repository permission levels (the API's `permission` field) that include write. */
export const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write'])

/** The mode an event implies when the workflow doesn't set `mode`. */
export function defaultMode(eventName) {
  switch (eventName) {
    case 'issue_comment':
    case 'issues':
    case 'pull_request_review_comment':
      return 'respond'
    case 'pull_request':
      return 'review'
    case 'workflow_run':
      return 'fix-ci'
    default:
      return null
  }
}

/** A trigger phrase is one `@name` handle, so it can be matched literally. */
export function isValidTrigger(trigger) {
  return typeof trigger === 'string' && /^@[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/.test(trigger)
}

/**
 * Markdown with the parts that aren't the author's own words removed: fenced and inline
 * code, quoted lines (a reply quoting an earlier mention), and HTML comments. A mention
 * only counts in what remains, so quoting or documenting `@houston` doesn't start a run.
 */
export function proseOnly(markdown) {
  const out = []
  let fence = null // the opening fence's marker while inside a fenced block
  for (const line of markdown.replace(/<!--[\s\S]*?(-->|$)/g, ' ').split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker
      continue
    }
    if (/^\s*>/.test(line)) continue
    out.push(line.replace(/`[^`]*`/g, ' '))
  }
  return out.join('\n')
}

/** True when `body` mentions `trigger` (case-insensitive) as a whole handle in its prose. */
export function hasMention(body, trigger) {
  if (typeof body !== 'string' || !isValidTrigger(trigger)) return false
  // isValidTrigger leaves only letters, digits, `_`, and `-`: nothing a regex reads specially.
  const handle = trigger.slice(1)
  // Not part of a longer handle (`@houston-bot`), an email (`ci@houston`), or a path.
  const re = new RegExp(`(^|[^A-Za-z0-9_@./-])@${handle}(?![A-Za-z0-9_-])`, 'i')
  return re.test(proseOnly(body))
}

/**
 * The event names Houston refuses outright. `pull_request_target` runs with the base
 * repository's secrets and a write token while the pull request may come from a fork, so
 * any step that reads the fork's code hands that code the key.
 */
export const REFUSED_EVENTS = new Set(['pull_request_target'])

/**
 * What a respond run answers. Returns `{ skip }` with a reason when the event shouldn't
 * start one; the API permission check comes after, since it needs the network.
 */
export function respondContext(eventName, event, { trigger, repository }) {
  const base = { repository }
  if (eventName === 'issue_comment') {
    if (event.action !== 'created') return { skip: `issue_comment ${event.action}: only new comments start a run` }
    return commentRequest(base, event.comment, {
      number: event.issue?.number,
      isPullRequest: Boolean(event.issue?.pull_request),
      trigger
    })
  }
  if (eventName === 'pull_request_review_comment') {
    if (event.action !== 'created') {
      return { skip: `pull_request_review_comment ${event.action}: only new comments start a run` }
    }
    const comment = event.comment
    const ctx = commentRequest(base, comment, { number: event.pull_request?.number, isPullRequest: true, trigger })
    if ('skip' in ctx) return ctx
    // Replies attach to the thread's first comment; the API refuses a reply to a reply.
    return { ...ctx, replyToReviewComment: comment.in_reply_to_id ?? comment.id }
  }
  if (eventName === 'issues') {
    if (event.action !== 'opened') return { skip: `issues ${event.action}: only a newly opened issue starts a run` }
    return commentRequest(base, event.issue, { number: event.issue?.number, isPullRequest: false, trigger })
  }
  return { skip: `respond mode does not handle ${eventName} events` }
}

/** Shared gate for a comment-shaped object (a comment, or an issue's own body). */
function commentRequest(base, item, { number, isPullRequest, trigger }) {
  if (!item || !Number.isSafeInteger(number)) return { skip: 'the event carries no issue or comment' }
  const login = item.user?.login
  if (typeof login !== 'string' || !login) return { skip: 'the comment has no author' }
  // A bot's comment never starts a run: Houston's own replies must not loop.
  if (item.user?.type === 'Bot' || login.endsWith('[bot]')) return { skip: `@${login} is a bot` }
  if (!hasMention(item.body, trigger)) return { skip: `no ${trigger} mention` }
  const association = item.author_association
  if (!WRITE_ASSOCIATIONS.has(association)) {
    return { skip: `@${login} is not a collaborator with write access (author_association ${association ?? 'missing'})` }
  }
  return {
    ...base,
    mode: 'respond',
    number,
    isPullRequest,
    author: login,
    association,
    request: item.body.trim()
  }
}

/** What a review run reviews, or `{ skip }`. Fork pull requests are skipped: see README. */
export function reviewContext(eventName, event, { repository }) {
  if (eventName !== 'pull_request') return { skip: `review mode runs on pull_request events, not ${eventName}` }
  const reviewable = ['opened', 'synchronize', 'reopened', 'ready_for_review']
  if (!reviewable.includes(event.action)) return { skip: `pull_request ${event.action} is not a code change` }
  const pr = event.pull_request
  if (!pr || !Number.isSafeInteger(pr.number)) return { skip: 'the event carries no pull request' }
  if (pr.draft === true) return { skip: 'the pull request is a draft' }
  // A fork's pull_request run gets no secrets and a read-only token: there is no key to run
  // with and no way to post. Say so instead of failing.
  if (pr.head?.repo?.full_name !== repository) return { skip: 'the pull request comes from a fork' }
  const baseSha = pr.base?.sha
  if (!isSha(baseSha)) return { skip: 'the pull request has no base commit' }
  return { repository, mode: 'review', number: pr.number, baseSha, headSha: pr.head?.sha }
}

/** What a fix-ci run repairs, or `{ skip }`. Only same-repository runs that failed. */
export function fixCiContext(eventName, event, { repository, branchPrefix }) {
  if (eventName !== 'workflow_run') return { skip: `fix-ci mode runs on workflow_run events, not ${eventName}` }
  const run = event.workflow_run
  if (event.action !== 'completed' || !run) return { skip: 'the workflow run has not completed' }
  if (run.conclusion !== 'failure') return { skip: `the run concluded ${run.conclusion}, not failure` }
  // A run of a fork's pull request ran the fork's code: its logs and its branch are not
  // this repository's to fix, and its head branch can't be pushed to.
  if (run.head_repository?.full_name !== repository) return { skip: 'the failed run belongs to a fork' }
  const branch = run.head_branch
  if (typeof branch !== 'string' || !branch) return { skip: 'the failed run has no branch' }
  // A fix branch whose own CI fails gets a human, not another fix on top.
  if (branch.startsWith(branchPrefix)) return { skip: `${branch} is already a Houston fix branch` }
  if (!Number.isSafeInteger(run.id) || !isSha(run.head_sha)) return { skip: 'the run has no id or commit' }
  return {
    repository,
    mode: 'fix-ci',
    runId: run.id,
    attempt: Number.isSafeInteger(run.run_attempt) ? run.run_attempt : 1,
    headSha: run.head_sha,
    branch,
    defaultBranch: event.repository?.default_branch ?? null,
    runUrl: typeof run.html_url === 'string' ? run.html_url : null
  }
}

/** Route to the mode's context builder. Refused events throw: they are a workflow bug. */
export function buildContext(mode, eventName, event, opts) {
  if (REFUSED_EVENTS.has(eventName)) {
    throw new Error(
      `Houston does not run on ${eventName}: it hands the base repository's secrets to a run that can read fork code. ` +
        'Use pull_request (review) or issue_comment (respond) instead.'
    )
  }
  if (mode === 'respond') return respondContext(eventName, event, opts)
  if (mode === 'review') return reviewContext(eventName, event, opts)
  if (mode === 'fix-ci') return fixCiContext(eventName, event, opts)
  throw new Error(`Unknown mode ${JSON.stringify(mode)}: use one of ${MODES.join(', ')}`)
}

export function isSha(v) {
  return typeof v === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v)
}
