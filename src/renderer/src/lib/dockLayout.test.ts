import { afterEach, describe, expect, it } from 'vitest'
import { afterPlan, forgetDockTab, readDockTab, rememberDockTab } from './dockLayout'

describe('dockLayout', () => {
  afterEach(() => localStorage.clear())

  it('remembers the last tab, never the plan review, and forgets on reset', () => {
    expect(readDockTab()).toBe('preview')
    rememberDockTab('files')
    expect(readDockTab()).toBe('files')
    rememberDockTab('plan')
    expect(readDockTab()).toBe('files')
    forgetDockTab()
    expect(readDockTab()).toBe('preview')
    localStorage.setItem('houston.dockTab', 'bogus')
    expect(readDockTab()).toBe('preview')
  })

  it('puts the dock back as it was once a plan leaves it', () => {
    const onPlan = { open: true, tab: 'plan' as const }
    expect(afterPlan(onPlan, { open: false, tab: 'preview' })).toEqual({ open: false, tab: 'preview' })
    expect(afterPlan(onPlan, { open: true, tab: 'files' })).toEqual({ open: true, tab: 'files' })
    expect(afterPlan(onPlan, null)).toEqual({ open: false, tab: 'preview' })
    // The user moved off the plan tab already: leave the dock alone.
    const elsewhere = { open: true, tab: 'tasks' as const }
    expect(afterPlan(elsewhere, { open: false, tab: 'preview' })).toBe(elsewhere)
  })
})
