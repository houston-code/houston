import { describe, expect, it } from 'vitest'
import type { AppSettings, ProviderConfig } from '@shared/types'
import { settingsPatch } from './useAutosave'

const provider: ProviderConfig = {
  id: 'anthropic',
  kind: 'anthropic',
  label: 'Anthropic',
  models: [],
  requiresKey: true,
  hasKey: false,
  builtIn: true
}
const base = {
  schemaVersion: 1,
  providers: [provider],
  selected: null,
  approvalPolicy: 'ask',
  recentWorkspaces: []
} as AppSettings

describe('settingsPatch', () => {
  it('is null when nothing the user edits changed', () => {
    expect(settingsPatch(base, { ...base })).toBeNull()
  })

  it('ignores the derived key flags main recomputes', () => {
    const keyed = { ...base, providers: [{ ...provider, hasKey: true }], searchKeyStatus: { tavily: true } }
    expect(settingsPatch(base, keyed)).toBeNull()
  })

  it('holds only the top-level settings that changed', () => {
    expect(settingsPatch(base, { ...base, theme: 'dark', approvalPolicy: 'full-auto' })).toEqual({
      theme: 'dark',
      approvalPolicy: 'full-auto'
    })
  })

  it('carries a removed setting as undefined', () => {
    const patch = settingsPatch({ ...base, compactionThreshold: 5 }, base)
    expect(patch).toEqual({ compactionThreshold: undefined })
    expect(patch && 'compactionThreshold' in patch).toBe(true)
  })

  it('carries a changed list whole', () => {
    const rules = [{ action: 'deny' as const, tool: '*', match: '*' }]
    expect(settingsPatch(base, { ...base, permissionRules: rules })).toEqual({ permissionRules: rules })
  })
})
