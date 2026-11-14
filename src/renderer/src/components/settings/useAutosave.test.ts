import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, ProviderConfig } from '@shared/types'
import { mergeList, settingsPatch, useAutosave, withDerivedFlags } from './useAutosave'

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

describe('mergeList', () => {
  it("keeps the user's list as is when nothing else changed it", () => {
    expect(mergeList(['a', 'b', 'c'], ['c', 'a'], ['a', 'b', 'c'])).toEqual(['c', 'a'])
  })

  it('keeps entries added elsewhere and drops ones removed elsewhere, alongside the user edit', () => {
    // The user removed b and added d; meanwhile another writer added x and removed c.
    expect(mergeList(['a', 'b', 'c'], ['a', 'c', 'd'], ['a', 'b', 'x'])).toEqual(['a', 'd', 'x'])
    expect(mergeList(undefined, ['d'], ['x'])).toEqual(['d', 'x'])
  })

  it('matches providers without the derived key flag', () => {
    const p = { ...provider, hasKey: false }
    expect(mergeList([p], [{ ...p, label: 'Renamed' }], [{ ...p, hasKey: true }])).toEqual([{ ...p, label: 'Renamed' }])
  })
})

describe('withDerivedFlags', () => {
  it("takes the key and sign-in flags from the current copy, the rest from the target", () => {
    const server = { id: 'linear', command: '', url: 'https://x', transport: 'http' as const, enabled: true }
    const older = {
      ...base,
      theme: 'dark',
      providers: [{ ...provider, hasKey: false }],
      searchKeyStatus: { tavily: false },
      mcpServers: [{ ...server, hasOAuth: false }]
    } as AppSettings
    const current = {
      ...base,
      theme: 'light',
      providers: [{ ...provider, hasKey: true }],
      searchKeyStatus: { tavily: true },
      mcpServers: [{ ...server, hasOAuth: true }]
    } as AppSettings
    const undone = withDerivedFlags(older, current)
    expect(undone.theme).toBe('dark')
    expect(undone.providers[0].hasKey).toBe(true)
    expect(undone.searchKeyStatus).toEqual({ tavily: true })
    expect(undone.mcpServers?.[0].hasOAuth).toBe(true)
  })
})

describe('useAutosave', () => {
  it('clears a failed save once a later save lands', async () => {
    const saveSettings = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation(async (s: AppSettings) => s)
    window.api = { getSettings: vi.fn().mockResolvedValue(base), saveSettings } as unknown as typeof window.api
    const { result, rerender } = renderHook((p: { settings: AppSettings }) =>
      useAutosave({
        settings: p.settings,
        setSettings: vi.fn(),
        initial: base,
        containerRef: { current: null },
        onSaved: vi.fn(),
        delayMs: 60_000
      }),
      { initialProps: { settings: base } }
    )
    rerender({ settings: { ...base, theme: 'dark' } })
    await act(() => result.current.flush())
    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('Could not save settings: disk full')
    await act(() => result.current.flush())
    expect(result.current.status).toBe('saved')
    expect(result.current.error).toBeNull()
  })

  it('saves a rule edit without dropping a rule saved elsewhere meanwhile', async () => {
    const keep = { action: 'allow' as const, tool: 'read_file', match: '*' }
    const drop = { action: 'deny' as const, tool: 'run_shell', match: 'rm *' }
    const added = { action: 'allow' as const, tool: 'run_shell', match: 'npm test' }
    const opened = { ...base, permissionRules: [keep, drop] }
    // While Settings is open, an approval prompt's "Always allow" stores another rule.
    const getSettings = vi.fn().mockResolvedValue({ ...opened, permissionRules: [keep, drop, added] })
    const saveSettings = vi.fn(async (s: AppSettings) => s)
    window.api = { getSettings, saveSettings } as unknown as typeof window.api
    const { result, rerender } = renderHook((p: { settings: AppSettings }) =>
      useAutosave({
        settings: p.settings,
        setSettings: vi.fn(),
        initial: opened,
        containerRef: { current: null },
        onSaved: vi.fn(),
        onError: vi.fn(),
        delayMs: 60_000
      }),
      { initialProps: { settings: opened } }
    )
    // The user deletes a rule from the (stale) list.
    rerender({ settings: { ...opened, permissionRules: [keep] } })
    await act(() => result.current.flush())
    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings.mock.calls[0][0].permissionRules).toEqual([keep, added])
  })
})

