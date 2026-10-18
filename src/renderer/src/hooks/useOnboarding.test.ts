import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import type { OnboardingState } from '@shared/onboarding'
import { useOnboarding } from './useOnboarding'

/**
 * A fake main process: getSettings/saveSettings over one stored object, with each
 * save resolving only when the test releases it, so ordering can be controlled.
 */
function installApi(initial: OnboardingState | undefined) {
  let stored: AppSettings = { ...defaultSettings(), onboarding: initial }
  const pending: Array<() => void> = []
  const saves: Array<OnboardingState | undefined> = []
  const api = {
    getSettings: vi.fn(async () => stored),
    saveSettings: vi.fn(
      (next: AppSettings) =>
        new Promise<AppSettings>((resolve) => {
          pending.push(() => {
            stored = next
            saves.push(next.onboarding)
            resolve(next)
          })
        })
    )
  }
  window.api = api as unknown as typeof window.api
  /** Let every queued save finish, including ones queued while releasing. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        while (pending.length) pending.shift()!()
        await new Promise((r) => setTimeout(r, 0))
      })
    }
  }
  return { api, saves, flush, stored: () => stored }
}

function setup(
  onboarding: OnboardingState | undefined,
  opts: { conversationsLoaded?: boolean; hasConversation?: boolean } = {}
) {
  return renderHook(
    (p: { hasConversation: boolean }) => {
      const [settings, setSettings] = useState<AppSettings | null>({
        ...defaultSettings(),
        onboarding
      })
      const hook = useOnboarding({
        settings,
        setSettings,
        conversationsLoaded: opts.conversationsLoaded ?? true,
        hasConversation: p.hasConversation
      })
      return { hook, settings, setSettings }
    },
    { initialProps: { hasConversation: opts.hasConversation ?? false } }
  )
}

describe('useOnboarding', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads the persisted state from the first render', () => {
    installApi({ tourInvite: 'pending' })
    const { result } = setup({ tourInvite: 'pending' })
    expect(result.current.hook.state).toEqual({ tourInvite: 'pending' })
  })

  it('composes quick successive changes instead of dropping one', async () => {
    const env = installApi({})
    const { result } = setup({})
    act(() => {
      result.current.hook.update((s) => ({ ...s, seenTips: ['approval'] }))
      result.current.hook.update((s) => ({ ...s, seenTips: [...(s.seenTips ?? []), 'worktree'] }))
    })
    expect(result.current.hook.state.seenTips).toEqual(['approval', 'worktree'])
    await env.flush()
    expect(env.stored().onboarding?.seenTips).toEqual(['approval', 'worktree'])
  })

  it('saves one at a time, each with the newest state, so a slow save cannot roll back', async () => {
    const env = installApi({})
    const { result } = setup({})
    act(() => result.current.hook.update({ seenTips: ['approval'] }))
    act(() => result.current.hook.update((s) => ({ ...s, tourInvite: 'done' })))
    await env.flush()
    expect(env.saves.at(-1)).toEqual({ seenTips: ['approval'], tourInvite: 'done' })
    expect(result.current.hook.state).toEqual({ seenTips: ['approval'], tourInvite: 'done' })
  })

  it('is not rolled back when the app adopts older settings from main', async () => {
    installApi({})
    const { result } = setup({})
    act(() => result.current.hook.update({ checklistDone: true }))
    // Another handler (e.g. a model switch) replaces settings with a copy fetched
    // before the onboarding save landed.
    act(() => result.current.setSettings((s) => (s ? { ...s, onboarding: {} } : s)))
    expect(result.current.hook.state).toEqual({ checklistDone: true })
  })

  it('patches the app settings copy so whole-settings saves carry it', () => {
    installApi({})
    const { result } = setup({})
    act(() => result.current.hook.update({ checklistDone: true }))
    expect(result.current.settings?.onboarding).toEqual({ checklistDone: true })
  })

  it('latches the checklist done once a conversation exists, and persists it', async () => {
    const env = installApi({})
    const { result, rerender } = setup({})
    expect(result.current.hook.state.checklistDone).toBeUndefined()
    rerender({ hasConversation: true })
    expect(result.current.hook.state.checklistDone).toBe(true)
    await env.flush()
    expect(env.stored().onboarding?.checklistDone).toBe(true)
  })

  it('does not latch before conversations have loaded', () => {
    installApi({})
    const { result } = setup({}, { conversationsLoaded: false, hasConversation: true })
    expect(result.current.hook.state.checklistDone).toBeUndefined()
  })

  it('startTour clears seen tips, settles the invite, and starts touring; endTour stops', async () => {
    installApi({ seenTips: ['approval', 'worktree', 'changes', 'revert'], tourInvite: 'pending' })
    const { result } = setup({
      seenTips: ['approval', 'worktree', 'changes', 'revert'],
      tourInvite: 'pending'
    })
    act(() => result.current.hook.startTour())
    expect(result.current.hook.touring).toBe(true)
    expect(result.current.hook.state).toEqual({ seenTips: [], tourInvite: 'done' })
    act(() => result.current.hook.endTour())
    expect(result.current.hook.touring).toBe(false)
    await waitFor(() => expect(window.api.saveSettings).toHaveBeenCalled())
  })
})
