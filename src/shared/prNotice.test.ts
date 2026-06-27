import { describe, expect, it } from 'vitest'
import { prNoticeFromToolResult, prNoticeText } from './prNotice'

const CREATE_OUT = 'https://github.com/acme/houston/pull/42'
const MERGED_VIEW = [
  '#42 Resizable sidebar [merged]',
  'feat/sidebar → main · by piyushvijay',
  '3 file(s), +120 −8',
  'https://github.com/acme/houston/pull/42',
  '',
  'Some body text.'
].join('\n')
const OPEN_VIEW = MERGED_VIEW.replace('[merged]', '[open]')

describe('prNoticeFromToolResult', () => {
  it('reports a created PR from gh_pr_create output', () => {
    expect(prNoticeFromToolResult('gh_pr_create', true, CREATE_OUT)).toEqual({
      event: 'created',
      number: 42,
      url: 'https://github.com/acme/houston/pull/42'
    })
  })

  it('reports a merged PR from a gh_pr_view whose state is merged', () => {
    expect(prNoticeFromToolResult('gh_pr_view', true, MERGED_VIEW)).toEqual({
      event: 'merged',
      number: 42,
      url: 'https://github.com/acme/houston/pull/42'
    })
  })

  it('still finds the merged tag when a diff is appended to the view', () => {
    const withDiff = `${MERGED_VIEW}\n\n--- diff ---\ndiff --git a/x b/x\n[merged] in the diff body should not matter`
    expect(prNoticeFromToolResult('gh_pr_view', true, withDiff)?.event).toBe('merged')
  })

  it('stays quiet for a PR that is open or closed-but-not-merged', () => {
    expect(prNoticeFromToolResult('gh_pr_view', true, OPEN_VIEW)).toBeNull()
    expect(
      prNoticeFromToolResult('gh_pr_view', true, MERGED_VIEW.replace('[merged]', '[closed]'))
    ).toBeNull()
  })

  it('ignores gh_pr_list so a bulk "merged" query does not spam banners', () => {
    const list = '#1 [merged] A (a by me) https://github.com/acme/houston/pull/1'
    expect(prNoticeFromToolResult('gh_pr_list', true, list)).toBeNull()
  })

  it('ignores failed gh calls (no PR URL / merged tag to match)', () => {
    expect(prNoticeFromToolResult('gh_pr_create', true, 'gh failed (exit 1): not authenticated')).toBeNull()
    expect(prNoticeFromToolResult('gh_pr_create', false, CREATE_OUT)).toBeNull()
    expect(prNoticeFromToolResult('gh_pr_view', true, 'gh failed (exit 1): no PR found')).toBeNull()
  })

  it('ignores non-PR tools and empty output', () => {
    expect(prNoticeFromToolResult('read_file', true, CREATE_OUT)).toBeNull()
    expect(prNoticeFromToolResult('gh_pr_create', true, '')).toBeNull()
  })
})

describe('prNoticeText', () => {
  it('renders created and merged with number and url', () => {
    expect(
      prNoticeText({ event: 'created', number: 42, url: 'https://x/pull/42' })
    ).toBe('🔀 Opened pull request #42 · https://x/pull/42')
    expect(prNoticeText({ event: 'merged', number: 42, url: 'https://x/pull/42' })).toBe(
      '✅ Pull request #42 merged · https://x/pull/42'
    )
  })

  it('degrades gracefully when number or url is missing', () => {
    expect(prNoticeText({ event: 'created' })).toBe('🔀 Opened pull request')
    expect(prNoticeText({ event: 'merged', number: 7 })).toBe('✅ Pull request #7 merged')
  })
})
