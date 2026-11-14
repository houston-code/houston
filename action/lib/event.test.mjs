import { describe, expect, it } from 'vitest'
import {
  buildContext,
  defaultMode,
  fixCiContext,
  hasCommand,
  hasMention,
  implementContext,
  isValidLabel,
  isValidTrigger,
  respondContext,
  reviewContext,
  taskContext
} from './event.mjs'

const REPO = 'acme/widgets'
const SHA = 'a'.repeat(40)
const opts = { trigger: '@houston', repository: REPO, branchPrefix: 'houston/' }

function issueComment(overrides = {}, comment = {}) {
  return {
    action: 'created',
    issue: { number: 12 },
    comment: {
      id: 99,
      body: '@houston why does the build fail?',
      author_association: 'MEMBER',
      user: { login: 'dana', type: 'User' },
      ...comment
    },
    ...overrides
  }
}

describe('hasMention', () => {
  it('finds the handle in prose, whatever its case', () => {
    expect(hasMention('@houston please look', '@houston')).toBe(true)
    expect(hasMention('Hey @Houston, any idea?', '@houston')).toBe(true)
    expect(hasMention('(@houston)', '@houston')).toBe(true)
  })

  it('ignores longer handles, emails, and paths', () => {
    expect(hasMention('@houston-bot ping', '@houston')).toBe(false)
    expect(hasMention('@houstonian', '@houston')).toBe(false)
    expect(hasMention('mail ci@houston.dev', '@houston')).toBe(false)
    expect(hasMention('see org/@houston/x', '@houston')).toBe(false)
  })

  it('ignores mentions in code, quotes, and HTML comments', () => {
    expect(hasMention('run `@houston` to start', '@houston')).toBe(false)
    expect(hasMention('```\n@houston fix\n```', '@houston')).toBe(false)
    expect(hasMention('~~~~\n@houston\n~~~\n~~~~\nok', '@houston')).toBe(false)
    expect(hasMention('> @houston said hi\nthanks', '@houston')).toBe(false)
    expect(hasMention('<!-- @houston -->', '@houston')).toBe(false)
    expect(hasMention('```\ncode\n```\n@houston now', '@houston')).toBe(true)
  })

  it('treats an unclosed fence as code to the end', () => {
    expect(hasMention('```\n@houston', '@houston')).toBe(false)
  })

  it('refuses a trigger that is not one handle', () => {
    expect(isValidTrigger('@houston')).toBe(true)
    expect(isValidTrigger('houston')).toBe(false)
    expect(isValidTrigger('@a.*')).toBe(false)
    expect(hasMention('@a.* x', '@a.*')).toBe(false)
    expect(hasMention(undefined, '@houston')).toBe(false)
  })
})

describe('defaultMode', () => {
  it('maps each supported event to its mode', () => {
    expect(defaultMode('issue_comment')).toBe('respond')
    expect(defaultMode('issues')).toBe('respond')
    expect(defaultMode('pull_request_review_comment')).toBe('respond')
    expect(defaultMode('pull_request')).toBe('review')
    expect(defaultMode('workflow_run')).toBe('fix-ci')
    expect(defaultMode('schedule')).toBe('task')
    expect(defaultMode('workflow_dispatch')).toBe('task')
    expect(defaultMode('push')).toBeNull()
  })
})

describe('respondContext', () => {
  it('accepts a write-capable collaborator mentioning the trigger', () => {
    const ctx = respondContext('issue_comment', issueComment(), opts)
    expect(ctx).toMatchObject({ mode: 'respond', number: 12, isPullRequest: false, author: 'dana' })
    expect(ctx.request).toBe('@houston why does the build fail?')
  })

  it('marks a comment on a pull request', () => {
    const ctx = respondContext('issue_comment', issueComment({ issue: { number: 3, pull_request: {} } }), opts)
    expect(ctx).toMatchObject({ number: 3, isPullRequest: true })
  })

  it.each(['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', undefined])(
    'skips author_association %s',
    (association) => {
      const ctx = respondContext('issue_comment', issueComment({}, { author_association: association }), opts)
      expect(ctx.skip).toMatch(/not a collaborator with write access/)
    }
  )

  it('skips bots, so its own replies never loop', () => {
    expect(respondContext('issue_comment', issueComment({}, { user: { login: 'helper', type: 'Bot' } }), opts).skip).toMatch(/bot/)
    expect(respondContext('issue_comment', issueComment({}, { user: { login: 'x[bot]', type: 'User' } }), opts).skip).toMatch(/bot/)
  })

  it('skips edits and deletions, and comments without the mention', () => {
    expect(respondContext('issue_comment', issueComment({ action: 'edited' }), opts).skip).toMatch(/only new comments/)
    expect(respondContext('issue_comment', issueComment({}, { body: 'no mention' }), opts).skip).toMatch(/no @houston mention/)
  })

  it('replies to a review comment thread at its first comment', () => {
    const event = {
      action: 'created',
      pull_request: { number: 5 },
      comment: { id: 70, in_reply_to_id: 60, body: '@houston?', author_association: 'OWNER', user: { login: 'o' } }
    }
    expect(respondContext('pull_request_review_comment', event, opts)).toMatchObject({
      number: 5,
      isPullRequest: true,
      replyToReviewComment: 60
    })
    delete event.comment.in_reply_to_id
    expect(respondContext('pull_request_review_comment', event, opts).replyToReviewComment).toBe(70)
  })

  it('reads a newly opened issue body', () => {
    const event = {
      action: 'opened',
      issue: { number: 9, body: '@houston triage this', author_association: 'COLLABORATOR', user: { login: 'c' } }
    }
    expect(respondContext('issues', event, opts)).toMatchObject({ number: 9, request: '@houston triage this' })
    expect(respondContext('issues', { ...event, action: 'labeled' }, opts).skip).toBeDefined()
  })
})

describe('reviewContext', () => {
  const pr = (o = {}) => ({
    action: 'opened',
    pull_request: {
      number: 4,
      draft: false,
      base: { sha: SHA },
      head: { sha: 'b'.repeat(40), repo: { full_name: REPO } },
      ...o
    }
  })

  it('reviews a same-repository pull request against its base', () => {
    expect(reviewContext('pull_request', pr(), opts)).toMatchObject({ mode: 'review', number: 4, baseSha: SHA })
  })

  it('skips forks, drafts, and non-code actions', () => {
    expect(reviewContext('pull_request', pr({ head: { sha: SHA, repo: { full_name: 'evil/widgets' } } }), opts).skip).toMatch(/fork/)
    expect(reviewContext('pull_request', pr({ head: { sha: SHA, repo: null } }), opts).skip).toMatch(/fork/)
    expect(reviewContext('pull_request', pr({ draft: true }), opts).skip).toMatch(/draft/)
    expect(reviewContext('pull_request', { ...pr(), action: 'closed' }, opts).skip).toBeDefined()
    expect(reviewContext('pull_request', pr({ base: { sha: 'main' } }), opts).skip).toMatch(/base commit/)
  })
})

describe('fixCiContext', () => {
  const run = (o = {}) => ({
    action: 'completed',
    repository: { default_branch: 'main' },
    workflow_run: {
      id: 321,
      run_attempt: 2,
      conclusion: 'failure',
      head_branch: 'feature',
      head_sha: SHA,
      html_url: 'https://github.com/acme/widgets/actions/runs/321',
      head_repository: { full_name: REPO },
      ...o
    }
  })

  it('fixes a failed same-repository run', () => {
    expect(fixCiContext('workflow_run', run(), opts)).toMatchObject({
      mode: 'fix-ci',
      runId: 321,
      attempt: 2,
      branch: 'feature',
      defaultBranch: 'main'
    })
  })

  it('skips passing runs, forks, and its own fix branches', () => {
    expect(fixCiContext('workflow_run', run({ conclusion: 'success' }), opts).skip).toMatch(/success/)
    expect(fixCiContext('workflow_run', run({ head_repository: { full_name: 'evil/widgets' } }), opts).skip).toMatch(/fork/)
    expect(fixCiContext('workflow_run', run({ head_branch: 'houston/fix-ci-1-1' }), opts).skip).toMatch(/already/)
    expect(fixCiContext('workflow_run', { ...run(), action: 'requested' }, opts).skip).toBeDefined()
  })
})

describe('hasCommand', () => {
  it('finds the trigger followed by the command, in prose only', () => {
    expect(hasCommand('@houston implement this please', '@houston', 'implement')).toBe(true)
    expect(hasCommand('Thanks! @Houston  IMPLEMENT', '@houston', 'implement')).toBe(true)
    expect(hasCommand('@houston implementation details?', '@houston', 'implement')).toBe(false)
    expect(hasCommand('@houston what would you implement?', '@houston', 'implement')).toBe(false)
    expect(hasCommand('`@houston implement`', '@houston', 'implement')).toBe(false)
    expect(hasCommand('> @houston implement\nno', '@houston', 'implement')).toBe(false)
    expect(hasCommand('@houston-bot implement', '@houston', 'implement')).toBe(false)
    expect(hasCommand('@houston\nimplement', '@houston', 'implement')).toBe(false)
  })
})

describe('isValidLabel', () => {
  it('takes a printable label name of at most 50 characters', () => {
    expect(isValidLabel('houston')).toBe(true)
    expect(isValidLabel('ai: implement')).toBe(true)
    expect(isValidLabel('')).toBe(false)
    expect(isValidLabel(' padded')).toBe(false)
    expect(isValidLabel('a\nb')).toBe(false)
    expect(isValidLabel('x'.repeat(51))).toBe(false)
  })
})

describe('implementContext', () => {
  const iopts = { ...opts, label: 'houston' }
  const labeled = (o = {}) => ({
    action: 'labeled',
    repository: { default_branch: 'main' },
    label: { name: 'houston' },
    issue: { number: 12, state: 'open' },
    sender: { login: 'dana', type: 'User' },
    ...o
  })

  it('implements an issue when the label is added, asking about the labeller', () => {
    expect(implementContext('issues', labeled(), iopts)).toMatchObject({
      mode: 'implement',
      source: 'label',
      number: 12,
      author: 'dana',
      request: null,
      base: 'main',
      defaultBranch: 'main'
    })
  })

  it('skips other labels and actions, closed issues, bots, and pull requests', () => {
    expect(implementContext('issues', labeled({ label: { name: 'bug' } }), iopts).skip).toMatch(/not houston/)
    expect(implementContext('issues', labeled({ action: 'opened' }), iopts).skip).toMatch(/only adding the houston label/)
    expect(implementContext('issues', labeled({ issue: { number: 12, state: 'closed' } }), iopts).skip).toMatch(/closed/)
    expect(implementContext('issues', labeled({ sender: { login: 'h[bot]', type: 'Bot' } }), iopts).skip).toMatch(/bot/)
    expect(implementContext('issues', labeled({ issue: { number: 3, pull_request: {} } }), iopts).skip).toMatch(/never from a pull request/)
    expect(implementContext('issues', labeled({ repository: {} }), iopts).skip).toMatch(/default branch/)
  })

  it('implements from a collaborator comment with the implement command', () => {
    const event = issueComment({ repository: { default_branch: 'trunk' } }, { body: '@houston implement, with tests' })
    expect(implementContext('issue_comment', event, iopts)).toMatchObject({
      mode: 'implement',
      source: 'comment',
      number: 12,
      author: 'dana',
      request: '@houston implement, with tests',
      base: 'trunk'
    })
  })

  it('skips a plain mention, a stranger, and any comment on a pull request', () => {
    const repo = { repository: { default_branch: 'main' } }
    expect(implementContext('issue_comment', issueComment(repo), iopts).skip).toMatch(/no @houston implement command/)
    const stranger = issueComment(repo, { body: '@houston implement', author_association: 'NONE' })
    expect(implementContext('issue_comment', stranger, iopts).skip).toMatch(/not a collaborator/)
    const onPr = issueComment({ ...repo, issue: { number: 4, pull_request: {} } }, { body: '@houston implement' })
    expect(implementContext('issue_comment', onPr, iopts).skip).toMatch(/never pushes to a pull request branch/)
  })

  it('runs a scheduled or manual opt-in on its branch, with no requester', () => {
    const ctx = implementContext('schedule', {}, { ...iopts, refName: 'main', refType: 'branch' })
    expect(ctx).toMatchObject({ mode: 'implement', source: 'schedule', number: null, author: null, base: 'main' })
    expect(implementContext('workflow_dispatch', {}, { ...iopts, refName: 'v1', refType: 'tag' }).skip).toMatch(/only on a branch/)
    expect(implementContext('pull_request', {}, iopts).skip).toMatch(/does not handle/)
  })
})

describe('taskContext', () => {
  it('runs on schedule and workflow_dispatch only', () => {
    expect(taskContext('schedule', {}, opts)).toMatchObject({ mode: 'task', source: 'schedule' })
    expect(taskContext('workflow_dispatch', {}, opts)).toMatchObject({ mode: 'task', source: 'workflow_dispatch' })
    expect(taskContext('issues', {}, opts).skip).toMatch(/schedule and workflow_dispatch/)
  })
})

describe('buildContext', () => {
  it('refuses pull_request_target in every mode', () => {
    for (const mode of ['respond', 'review', 'fix-ci', 'implement', 'task']) {
      expect(() => buildContext(mode, 'pull_request_target', {}, opts)).toThrow(/does not run on pull_request_target/)
    }
  })

  it('refuses an unknown mode', () => {
    expect(() => buildContext('merge', 'push', {}, opts)).toThrow(/Unknown mode/)
  })

  it('skips an event the mode does not handle', () => {
    expect(buildContext('review', 'issue_comment', issueComment(), opts).skip).toMatch(/pull_request events/)
  })
})
