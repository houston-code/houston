import { describe, it, expect, beforeEach } from 'vitest'
import { loadComposerDraft, saveComposerDraft } from './composerDraft'

beforeEach(() => {
  localStorage.clear()
})

describe('composerDraft', () => {
  it('returns an empty string when nothing is saved', () => {
    expect(loadComposerDraft()).toBe('')
  })

  it('round-trips a saved draft', () => {
    saveComposerDraft('a half-written thought')
    expect(loadComposerDraft()).toBe('a half-written thought')
  })

  it('clears the stored draft when saving empty text', () => {
    saveComposerDraft('something')
    saveComposerDraft('')
    expect(loadComposerDraft()).toBe('')
    expect(localStorage.getItem('houston.composerDraft')).toBeNull()
  })

  it('preserves whitespace-only drafts (still text the user typed)', () => {
    saveComposerDraft('  ')
    expect(loadComposerDraft()).toBe('  ')
  })
})
