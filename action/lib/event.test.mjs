import { describe, expect, it } from 'vitest'
import { buildContext, defaultMode, fixCiContext, hasMention, isValidTrigger, respondContext, reviewContext } from './event.mjs'

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

describe('buildContext', () => {
  it('refuses pull_request_target in every mode', () => {
    for (const mode of ['respond', 'review', 'fix-ci']) {
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
