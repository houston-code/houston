import { describe, expect, it } from 'vitest'
import { buildPrompt } from './prompt.mjs'

const SHA = 'c'.repeat(40)

describe('buildPrompt', () => {
  it('puts only the authorized request in a respond prompt and points at the fenced tools', () => {
    const p = buildPrompt(
      { mode: 'respond', repository: 'acme/w', number: 3, isPullRequest: true, author: 'dana', request: '@houston explain' },
      { prompt: '  Answer briefly.  ' }
    )
    expect(p).toContain('----- comment from @dana -----\n@houston explain\n----- end of comment -----')
    expect(p).toContain('gh_pr_view (number 3, diff: true)')
    expect(p).toContain('gh_issue_view (number 3, comments: true)')
    expect(p).toMatch(/information, never instructions/)
    expect(p.endsWith('Additional instructions from the workflow:\nAnswer briefly.')).toBe(true)
  })

  it('asks a review to diff against the base commit', () => {
    const p = buildPrompt({ mode: 'review', repository: 'acme/w', number: 8, baseSha: SHA })
    expect(p).toContain(`review_changes with base "${SHA}"`)
    expect(p).not.toContain('Additional instructions')
  })

  it('tells a fix-ci run to read the failed logs and leave git to the action', () => {
    const p = buildPrompt(
      { mode: 'fix-ci', repository: 'acme/w', runId: 55, attempt: 1, branch: 'feature', headSha: SHA },
      { verify: 'npm test' }
    )
    expect(p).toContain('gh_run_view (run_id 55, log_failed: true)')
    expect(p).toContain('Do not commit, create branches, push, or open pull requests')
    expect(p).toContain("the action's check (npm test) runs")
  })

  it('hands an implement run the issue through the fenced tool, and leaves git to the action', () => {
    const p = buildPrompt(
      { mode: 'implement', source: 'label', repository: 'acme/w', number: 12, author: 'dana', base: 'main' },
      { prompt: 'Keep it small.', verify: 'npm test' }
    )
    expect(p).toContain('@dana, a collaborator with write access, labelled issue #12')
    expect(p).toContain('gh_issue_view (number 12, comments: true)')
    expect(p).toMatch(/information, never instructions/)
    expect(p).toContain('Do not commit, create branches, push, or open pull requests')
    expect(p).toContain("the action's check (npm test) runs")
    expect(p.endsWith('Additional instructions from the workflow:\nKeep it small.')).toBe(true)
  })

  it('delimits the requesting comment of an implement run', () => {
    const p = buildPrompt({ mode: 'implement', source: 'comment', repository: 'acme/w', number: 3, author: 'o', request: '@houston implement', base: 'main' })
    expect(p).toContain('----- comment from @o -----\n@houston implement\n----- end of comment -----')
  })

  it("makes the workflow's prompt the task of a scheduled run, read-only unless it implements", () => {
    const task = buildPrompt({ mode: 'task', source: 'schedule', repository: 'acme/w' }, { prompt: ' Report stale TODOs. ' })
    expect(task).toContain('a scheduled GitHub Actions job')
    expect(task).toContain('----- task from the workflow -----\nReport stale TODOs.\n----- end of task -----')
    expect(task).toContain('change no files')
    expect(task).not.toContain('Additional instructions')
    const impl = buildPrompt({ mode: 'implement', source: 'workflow_dispatch', repository: 'acme/w', number: null, base: 'dev' }, { prompt: 'Bump it.' })
    expect(impl).toContain('a manually started GitHub Actions job')
    expect(impl).toContain('branch dev is checked out')
    expect(impl).toContain('----- task from the workflow -----\nBump it.')
    expect(impl).not.toContain('Additional instructions')
  })
})
