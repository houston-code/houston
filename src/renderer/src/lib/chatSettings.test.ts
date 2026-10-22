import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/types'
import { DEFAULT_REASONING_EFFORT } from '@shared/defaults'
import { chatSettingsFor, defaultChatSettings, differsFromDefaults, withChatSettings } from './chatSettings'

const saved = (over: Partial<AppSettings> = {}): AppSettings =>
  ({
    providers: [
      { id: 'anthropic', kind: 'anthropic', label: 'A', models: [{ id: 'opus' }, { id: 'haiku' }], defaultModel: 'opus' },
      { id: 'local', kind: 'openai-compatible', label: 'L', models: [{ id: 'llama' }] }
    ],
    selected: { providerId: 'anthropic', model: 'opus' },
    approvalPolicy: 'ask',
    reasoningEffort: 'high',
    ...over
  }) as unknown as AppSettings

describe('defaultChatSettings', () => {
  it('is the saved defaults, with the built-in effort when none is saved', () => {
    expect(defaultChatSettings(saved({ reasoningEffort: undefined }))).toEqual({
      selected: { providerId: 'anthropic', model: 'opus' },
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      approvalPolicy: 'ask'
    })
  })
})

describe('chatSettingsFor', () => {
  it("uses the chat's own settings over the defaults", () => {
    const { settings, modelChanged } = chatSettingsFor(
      { providerId: 'local', model: 'llama', reasoningEffort: 'low', approvalPolicy: 'plan' },
      saved()
    )
    expect(settings).toEqual({
      selected: { providerId: 'local', model: 'llama' },
      reasoningEffort: 'low',
      approvalPolicy: 'plan'
    })
    expect(modelChanged).toBe(false)
  })

  it('fills an older chat that never stored effort or policy from the defaults', () => {
    const { settings } = chatSettingsFor({ providerId: 'anthropic', model: 'haiku' }, saved())
    expect(settings).toEqual({
      selected: { providerId: 'anthropic', model: 'haiku' },
      reasoningEffort: 'high',
      approvalPolicy: 'ask'
    })
  })

  it("moves to the provider's default model when the chat's model was removed", () => {
    const { settings, modelChanged } = chatSettingsFor({ providerId: 'anthropic', model: 'gone' }, saved())
    expect(settings.selected).toEqual({ providerId: 'anthropic', model: 'opus' })
    expect(modelChanged).toBe(true)
  })

  it('moves to the default model when the whole provider is gone', () => {
    const { settings, modelChanged } = chatSettingsFor({ providerId: 'removed', model: 'x' }, saved())
    expect(settings.selected).toEqual({ providerId: 'anthropic', model: 'opus' })
    expect(modelChanged).toBe(true)
  })

  it('has no model when neither the chat nor the defaults have a usable one', () => {
    const { settings, modelChanged } = chatSettingsFor({ providerId: 'removed', model: 'x' }, saved({ selected: null }))
    expect(settings.selected).toBeNull()
    expect(modelChanged).toBe(true)
  })
})

describe('withChatSettings', () => {
  it("lays the chat's settings over the saved ones without changing them", () => {
    const base = saved()
    const view = withChatSettings(base, {
      selected: { providerId: 'local', model: 'llama' },
      reasoningEffort: 'off',
      approvalPolicy: 'full-auto'
    })
    expect(view).toMatchObject({
      selected: { providerId: 'local', model: 'llama' },
      reasoningEffort: 'off',
      approvalPolicy: 'full-auto',
      providers: base.providers
    })
    expect(base).toMatchObject({ selected: { providerId: 'anthropic', model: 'opus' }, approvalPolicy: 'ask' })
  })

  it('is the saved settings themselves on the new-chat screen', () => {
    const base = saved()
    expect(withChatSettings(base, null)).toBe(base)
  })
})

describe('differsFromDefaults', () => {
  it('is false for a chat on the defaults and true once any one differs', () => {
    const base = saved()
    const d = defaultChatSettings(base)
    expect(differsFromDefaults(d, base)).toBe(false)
    expect(differsFromDefaults({ ...d, approvalPolicy: 'plan' }, base)).toBe(true)
    expect(differsFromDefaults({ ...d, reasoningEffort: 'low' }, base)).toBe(true)
    expect(differsFromDefaults({ ...d, selected: { providerId: 'anthropic', model: 'haiku' } }, base)).toBe(true)
  })
})
