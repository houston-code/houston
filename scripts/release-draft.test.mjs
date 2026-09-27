import { describe, it, expect } from 'vitest'
import { planReleaseDraft } from './release-draft.mjs'

describe('planReleaseDraft', () => {
  it('creates when no release has the tag', () => {
    expect(planReleaseDraft([], 'v1.2.0')).toEqual({ action: 'create' })
    expect(
      planReleaseDraft([{ id: 1, tag_name: 'v1.1.0', draft: false }], 'v1.2.0'),
    ).toEqual({ action: 'create' })
  })

  it('reuses a single existing draft (a re-run of failed legs)', () => {
    const releases = [
      { id: 1, tag_name: 'v1.1.0', draft: false },
      { id: 7, tag_name: 'v1.2.0', draft: true },
    ]
    expect(planReleaseDraft(releases, 'v1.2.0')).toEqual({ action: 'reuse', id: 7 })
  })

  it('refuses when two drafts share the tag (the split-assets race)', () => {
    const releases = [
      { id: 397704396, tag_name: 'v0.3.0', draft: true },
      { id: 397704395, tag_name: 'v0.3.0', draft: true },
    ]
    const plan = planReleaseDraft(releases, 'v0.3.0')
    expect(plan.action).toBe('error')
    expect(plan.message).toContain('2 releases exist for v0.3.0')
    expect(plan.message).toContain('397704396 (draft)')
    expect(plan.message).toContain('397704395 (draft)')
  })

  it('refuses a draft alongside a published release for the same tag', () => {
    const releases = [
      { id: 1, tag_name: 'v1.2.0', draft: false },
      { id: 2, tag_name: 'v1.2.0', draft: true },
    ]
    expect(planReleaseDraft(releases, 'v1.2.0').action).toBe('error')
  })

  it('refuses to re-publish an already published version', () => {
    const plan = planReleaseDraft([{ id: 3, tag_name: 'v1.2.0', draft: false }], 'v1.2.0')
    expect(plan.action).toBe('error')
    expect(plan.message).toContain('already published')
  })

  it('matches the tag exactly, not by prefix', () => {
    const releases = [{ id: 4, tag_name: 'v1.2.00', draft: true }]
    expect(planReleaseDraft(releases, 'v1.2.0')).toEqual({ action: 'create' })
  })
})
