import { describe, it, expect, beforeEach } from 'vitest'
import { loadComposerDraft, saveComposerDraft } from './composerDraft'

beforeEach(() => {
  localStorage.clear()
})

describe('composerDraft', () => {
  it('returns an empty string when nothing is saved', () => {
    expect(loadComposerDraft('c1')).toBe('')
  })

  it('round-trips a saved draft for a conversation', () => {
    saveComposerDraft('c1', 'a half-written thought')
    expect(loadComposerDraft('c1')).toBe('a half-written thought')
  })

  it('keeps each conversation’s draft isolated from the others', () => {
    saveComposerDraft('c1', 'draft for one')
    saveComposerDraft('c2', 'draft for two')
    expect(loadComposerDraft('c1')).toBe('draft for one')
    expect(loadComposerDraft('c2')).toBe('draft for two')
    expect(loadComposerDraft('c3')).toBe('') // an untouched chat has no draft
  })

  it('gives the new-chat composer (null id) its own slot', () => {
    saveComposerDraft(null, 'unsent new chat')
    expect(loadComposerDraft(null)).toBe('unsent new chat')
    expect(loadComposerDraft('c1')).toBe('') // not shared with real conversations
  })

  it('clears only that conversation’s draft when saving empty text', () => {
    saveComposerDraft('c1', 'something')
    saveComposerDraft('c2', 'keep me')
    saveComposerDraft('c1', '')
    expect(loadComposerDraft('c1')).toBe('')
    expect(localStorage.getItem('houston.composerDraft:c1')).toBeNull()
    expect(loadComposerDraft('c2')).toBe('keep me')
  })

  it('preserves whitespace-only drafts (still text the user typed)', () => {
    saveComposerDraft('c1', '  ')
    expect(loadComposerDraft('c1')).toBe('  ')
  })
})
