import { describe, it, expect } from 'vitest'
import type { ProviderConfig } from '@shared/types'
import { comeBackHint, parseForkArg, reconcileChatModel } from './tui-chat-handoff'

const provider = (id: string, models: string[], defaultModel?: string): ProviderConfig =>
  ({
    id,
    name: id,
    kind: 'openai-compatible',
    models: models.map((m) => ({ id: m })),
    ...(defaultModel ? { defaultModel } : {})
  }) as unknown as ProviderConfig

describe('reconcileChatModel', () => {
  const providers = [provider('a', ['a1', 'a2'], 'a2'), provider('b', ['b1'])]
  const session = { providerId: 'b', model: 'b1' }

  it('keeps a chat model that is still set up, silently', () => {
    expect(reconcileChatModel(providers, { providerId: 'a', model: 'a1' }, session)).toEqual({
      providerId: 'a',
      model: 'a1'
    })
  })

  it('moves a removed model to another of its provider, and says so', () => {
    const r = reconcileChatModel(providers, { providerId: 'a', model: 'gone' }, session)
    expect(r).toMatchObject({ providerId: 'a', model: 'a2' })
    expect(r?.note).toBe("this chat's model (gone) is no longer set up, so it now uses a2")
  })

  it('falls back to the session model when the provider is gone, and says so', () => {
    const r = reconcileChatModel(providers, { providerId: 'zz', model: 'z1' }, session)
    expect(r).toMatchObject({ providerId: 'b', model: 'b1' })
    expect(r?.note).toContain('no longer set up, so it now uses b1')
  })

  it('asks for a model when there is nothing to fall back to', () => {
    const r = reconcileChatModel(providers, { providerId: 'zz', model: 'z1' }, { providerId: '', model: '' })
    expect(r?.note).toContain('pick one with /model')
  })

  it('a chat with no stored model has nothing to reconcile', () => {
    expect(reconcileChatModel(providers, {}, session)).toBeNull()
  })
})

describe('comeBackHint', () => {
  it('names --resume and --continue when the session stayed where it started', () => {
    const h = comeBackHint('abc', '/p', '/p/')
    expect(h).toContain('houston --resume abc\n')
    expect(h).toContain('houston --continue')
    expect(comeBackHint('abc', '/p')).toContain('houston --continue')
  })

  it('names the folder when the chat lives elsewhere, and drops --continue', () => {
    const h = comeBackHint('abc', '/repo/.houston/worktrees/my wt', '/repo')
    // Quoted the way this platform's shell reads it (double quotes on Windows).
    const q = process.platform === 'win32' ? '"' : "'"
    expect(h).toContain(`houston --resume abc -C ${q}/repo/.houston/worktrees/my wt${q}`)
    expect(h).not.toContain('--continue')
  })
})

describe('parseForkArg', () => {
  it('reads a message number, 1-based', () => {
    expect(parseForkArg('')).toEqual({})
    expect(parseForkArg(' 3 ')).toEqual({ turn: 2 })
    expect(parseForkArg('0')).toEqual({ bad: true })
    expect(parseForkArg('x')).toEqual({ bad: true })
    expect(parseForkArg('1.5')).toEqual({ bad: true })
  })
})
