import { describe, expect, it } from 'vitest'
import { builtinCommands } from '@shared/commands'
import { desktopCommandAction } from './desktopCommands'

describe('desktopCommandAction', () => {
  it('opens the matching Settings section', () => {
    expect(desktopCommandAction('theme', '')).toEqual({ kind: 'settings', section: 'appearance' })
    expect(desktopCommandAction('mcp', 'add')).toEqual({ kind: 'settings', section: 'mcp' })
    expect(desktopCommandAction('hooks', '')).toEqual({ kind: 'settings', section: 'hooks' })
    expect(desktopCommandAction('settings', '')).toEqual({ kind: 'settings', section: 'models' })
    expect(desktopCommandAction('settings', 'Permissions')).toEqual({ kind: 'settings', section: 'permissions' })
    expect(desktopCommandAction('settings', 'agent behavior')).toEqual({ kind: 'settings', section: 'agent' })
    expect(desktopCommandAction('settings', 'providers & models')).toEqual({ kind: 'settings', section: 'models' })
    expect(desktopCommandAction('settings', 'proxy')).toEqual({ kind: 'settings', section: 'models', query: 'proxy' })
    expect(desktopCommandAction('trust', '')).toEqual({ kind: 'settings', section: 'permissions' })
    expect(desktopCommandAction('login', '')).toEqual({ kind: 'settings', section: 'models' })
  })

  it('reads approval and thinking arguments, flagging words that name nothing', () => {
    expect(desktopCommandAction('approval', 'full')).toEqual({ kind: 'approval', policy: 'full-auto' })
    expect(desktopCommandAction('approval', '')).toEqual({ kind: 'approval' })
    expect(desktopCommandAction('approval', 'yolo')).toEqual({ kind: 'approval', invalid: 'yolo' })
    expect(desktopCommandAction('reasoning', 'HIGH')).toEqual({ kind: 'reasoning', effort: 'high' })
    expect(desktopCommandAction('reasoning', 'max')).toEqual({ kind: 'reasoning', invalid: 'max' })
  })

  it('splits /btw into a question or a clear', () => {
    expect(desktopCommandAction('btw', 'why this approach?')).toEqual({ kind: 'btw', question: 'why this approach?' })
    expect(desktopCommandAction('btw', 'clear')).toEqual({ kind: 'btw-clear' })
  })

  it('passes a model or session search through', () => {
    expect(desktopCommandAction('model', ' opus ')).toEqual({ kind: 'model', query: 'opus' })
    expect(desktopCommandAction('resume', 'auth')).toEqual({ kind: 'resume', query: 'auth' })
  })

  it('has an action for every shared command the app does not handle elsewhere', () => {
    // App handles these directly (chat lifecycle, listings, policy words, templates).
    const handledInApp = new Set(['new', 'clear', 'compact', 'rewind', 'plan', 'ask', 'auto', 'full', 'doctor', 'help', 'skills', 'agents', 'agent', 'review'])
    for (const c of builtinCommands('gui')) {
      if (handledInApp.has(c.name)) continue
      expect(desktopCommandAction(c.name, ''), `/${c.name}`).not.toBeNull()
    }
  })
})
