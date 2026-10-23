// The action's own GitHub calls, through `gh` with an argument array (never a shell) and
// bodies passed as files, so no event text is ever parsed as a command or a flag.

import { WRITE_PERMISSIONS } from './event.mjs'

/**
 * `exec(cmd, args, opts)` resolves to `{ code, stdout, stderr }`. Every call here goes
 * through it, so tests substitute a fake `gh`.
 */
async function gh(exec, args, opts = {}) {
  const r = await exec('gh', args, opts)
  if (r.code !== 0) {
    const what = args.slice(0, 2).join(' ')
    throw new Error(`gh ${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  }
  return r.stdout
}

/**
 * A GitHub login: letters, digits, and hyphens, plus the `_shortcode` suffix an
 * Enterprise Managed User's login carries (`mona-cat_octo`). Nothing that could change
 * the API path it is put into.
 */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:_[A-Za-z0-9]{1,39})?$/

/** The commenter's actual permission on the repository, from the API. */
export async function collaboratorPermission(exec, repository, login) {
  if (!LOGIN.test(login)) throw new Error(`not a GitHub login: ${JSON.stringify(login)}`)
  const out = await gh(exec, ['api', `repos/${repository}/collaborators/${login}/permission`, '--jq', '.permission'])
  return out.trim()
}

export async function hasWriteAccess(exec, repository, login) {
  return WRITE_PERMISSIONS.has(await collaboratorPermission(exec, repository, login))
}

/** A reply on an issue or a pull request's conversation. Returns the comment URL. */
export async function postIssueComment(exec, repository, number, bodyFile) {
  const out = await gh(exec, ['issue', 'comment', String(number), '--repo', repository, '--body-file', bodyFile])
  return out.trim()
}

/** A reply inside a pull request review thread. */
export async function replyToReviewComment(exec, repository, number, commentId, bodyFile) {
  const out = await gh(exec, [
    'api',
    '--method',
    'POST',
    `repos/${repository}/pulls/${number}/comments/${commentId}/replies`,
    '-F',
    `body=@${bodyFile}`,
    '--jq',
    '.html_url'
  ])
  return out.trim()
}

/** One review comment on a pull request (a comment review: it neither approves nor blocks). */
export async function postReview(exec, repository, number, bodyFile) {
  await gh(exec, ['pr', 'review', String(number), '--repo', repository, '--comment', '--body-file', bodyFile])
  return `https://github.com/${repository}/pull/${number}`
}

/** Open the fix pull request. Returns its URL. */
export async function createPullRequest(exec, repository, { base, head, title, bodyFile, draft }) {
  // `--flag=value`: a branch name from the event can never be read as another flag.
  const args = ['pr', 'create', '--repo', repository, `--base=${base}`, `--head=${head}`, `--title=${title}`, '--body-file', bodyFile]
  if (draft) args.push('--draft')
  const out = await gh(exec, args)
  return out.trim().split('\n').pop() ?? ''
}
