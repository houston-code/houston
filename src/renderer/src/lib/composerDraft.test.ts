import { describe, it, expect, beforeEach } from 'vitest'
import type { ContextAttachment } from '@shared/composerContext'
import {
  loadComposerContext,
  loadComposerDraft,
  MAX_SAVED_CONTEXT_CHARS,
  saveComposerDraft
} from './composerDraft'

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

  it('round-trips context chips with the draft and clears them with it', () => {
    const chip: ContextAttachment = {
      id: 'a1',
      kind: 'paste',
      label: 'Pasted text',
      detail: '60 lines',
      text: 'big paste'
    }
    saveComposerDraft('c1', 'see this', [chip])
    expect(loadComposerContext('c1')).toEqual([chip])
    expect(loadComposerContext('c2')).toEqual([])
    saveComposerDraft('c1', '', [])
    expect(loadComposerContext('c1')).toEqual([])
    expect(localStorage.getItem('houston.composerDraftContext:c1')).toBeNull()
  })

  it('inlines chip content into the saved text when the chips are over the cap', () => {
    const big = 'y'.repeat(MAX_SAVED_CONTEXT_CHARS + 1)
    saveComposerDraft('c1', 'see this', [{ id: 'a1', kind: 'file', label: 'f.txt', text: big }])
    expect(loadComposerContext('c1')).toEqual([])
    expect(loadComposerDraft('c1')).toBe(`see this\n\n${big}`)
  })

  it('ignores malformed saved chips', () => {
    localStorage.setItem('houston.composerDraftContext:c1', '{not json')
    expect(loadComposerContext('c1')).toEqual([])
    localStorage.setItem(
      'houston.composerDraftContext:c1',
      JSON.stringify([{ id: 'a', kind: 'bogus', label: 'x', text: 'y' }, 5, null])
    )
    expect(loadComposerContext('c1')).toEqual([])
  })

  it('preserves whitespace-only drafts (still text the user typed)', () => {
    saveComposerDraft('c1', '  ')
    expect(loadComposerDraft('c1')).toBe('  ')
  })
})
