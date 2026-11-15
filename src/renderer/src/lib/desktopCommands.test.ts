import { describe, expect, it } from 'vitest'
import { builtinCommands } from '@shared/commands'
import { desktopCommandAction, splitDefaultFlag } from './desktopCommands'

describe('desktopCommandAction', () => {
  it('opens the matching Settings section', () => {
    expect(desktopCommandAction('theme', '')).toEqual({ kind: 'settings', section: 'appearance' })
    expect(desktopCommandAction('mcp', '')).toEqual({ kind: 'settings', section: 'mcp' })
    expect(desktopCommandAction('hooks', '')).toEqual({ kind: 'settings', section: 'hooks' })
    expect(desktopCommandAction('memory', '')).toEqual({ kind: 'settings', section: 'memory' })
    expect(desktopCommandAction('settings', '')).toEqual({ kind: 'settings', section: 'models' })
    expect(desktopCommandAction('context', '')).toEqual({ kind: 'context' })
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

  it('reads --default on /model, /reasoning and /approval, wherever it sits', () => {
    expect(desktopCommandAction('model', 'opus --default')).toEqual({ kind: 'model', query: 'opus', asDefault: true })
    expect(desktopCommandAction('model', '--default')).toEqual({ kind: 'model', query: '', asDefault: true })
    expect(desktopCommandAction('reasoning', '--default high')).toEqual({ kind: 'reasoning', effort: 'high', asDefault: true })
    expect(desktopCommandAction('reasoning', '--default')).toEqual({ kind: 'reasoning', asDefault: true })
    expect(desktopCommandAction('approval', 'ask --default')).toEqual({ kind: 'approval', policy: 'ask', asDefault: true })
    // A bad word is still reported, never saved as the default.
    expect(desktopCommandAction('approval', 'yolo --default')).toEqual({ kind: 'approval', invalid: 'yolo', asDefault: true })
    // Without the flag nothing changes.
    expect(desktopCommandAction('reasoning', 'low')).toEqual({ kind: 'reasoning', effort: 'low' })
  })

  it('reads /changes last [n]', () => {
    expect(desktopCommandAction('changes', '')).toEqual({ kind: 'changes' })
    expect(desktopCommandAction('changes', 'last')).toEqual({ kind: 'changes', last: 1 })
    expect(desktopCommandAction('changes', 'LAST 3')).toEqual({ kind: 'changes', last: 3 })
    expect(desktopCommandAction('changes', 'last 0')).toEqual({ kind: 'changes', last: 1 })
    expect(desktopCommandAction('changes', 'staged')).toEqual({ kind: 'changes' })
  })

  it('reads /rewind <n> [mode] and /rewind undo without opening the picker', () => {
    expect(desktopCommandAction('rewind', '')).toEqual({ kind: 'rewind' })
    expect(desktopCommandAction('rewind', 'undo')).toEqual({ kind: 'rewind', undo: true })
    expect(desktopCommandAction('rewind', '2')).toEqual({ kind: 'rewind', turn: 1 })
    expect(desktopCommandAction('rewind', '2 code')).toEqual({ kind: 'rewind', turn: 1, mode: 'code' })
    expect(desktopCommandAction('rewind', '1 chat')).toEqual({ kind: 'rewind', turn: 0, mode: 'conversation' })
    expect(desktopCommandAction('rewind', '3 2')).toEqual({ kind: 'rewind', turn: 2, mode: 'conversation' })
    expect(desktopCommandAction('rewind', '0')).toEqual({ kind: 'rewind', invalid: '0' })
    expect(desktopCommandAction('rewind', '2 files')).toEqual({ kind: 'rewind', invalid: '2 files' })
    expect(desktopCommandAction('rewind', 'undo 2')).toEqual({ kind: 'rewind', invalid: 'undo 2' })
  })

  it('switches the app theme by name, and flags names the app has no theme for', () => {
    expect(desktopCommandAction('theme', 'Dark')).toEqual({ kind: 'theme', theme: 'dark' })
    expect(desktopCommandAction('theme', 'light')).toEqual({ kind: 'theme', theme: 'light' })
    expect(desktopCommandAction('theme', 'auto')).toEqual({ kind: 'theme', theme: 'system' })
    expect(desktopCommandAction('theme', 'colorblind')).toEqual({ kind: 'theme', invalid: 'colorblind' })
  })

  it('runs /trust forget, and opens the page naming any other words', () => {
    expect(desktopCommandAction('trust', 'forget')).toEqual({ kind: 'trust-forget' })
    expect(desktopCommandAction('trust', 'maybe')).toEqual({ kind: 'settings', section: 'permissions', ignored: 'maybe' })
  })

  it('does the /memory verbs the app can, and says which words the page took over', () => {
    expect(desktopCommandAction('memory', 'off')).toEqual({ kind: 'memory-enable', on: false })
    expect(desktopCommandAction('memory', 'ON')).toEqual({ kind: 'memory-enable', on: true })
    expect(desktopCommandAction('memory', 'folder')).toEqual({ kind: 'memory-folder' })
    expect(desktopCommandAction('memory', 'list')).toEqual({ kind: 'settings', section: 'memory' })
    expect(desktopCommandAction('memory', 'show 1')).toEqual({ kind: 'settings', section: 'memory', ignored: 'show 1' })
  })

  it('opens MCP servers for /mcp, naming a verb the page does instead', () => {
    expect(desktopCommandAction('mcp', 'list')).toEqual({ kind: 'settings', section: 'mcp' })
    expect(desktopCommandAction('mcp', 'enable 2')).toEqual({ kind: 'settings', section: 'mcp', ignored: 'enable 2' })
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
    const handledInApp = new Set(['new', 'clear', 'compact', 'plan', 'ask', 'auto', 'full', 'doctor', 'usage', 'help', 'skills', 'agents', 'agent', 'review', 'init'])
    for (const c of builtinCommands('gui')) {
      if (handledInApp.has(c.name)) continue
      expect(desktopCommandAction(c.name, ''), `/${c.name}`).not.toBeNull()
    }
  })

  it('splits --default off like the terminal does', () => {
    expect(splitDefaultFlag('  high   --default ')).toEqual({ rest: 'high', asDefault: true })
    expect(splitDefaultFlag('high')).toEqual({ rest: 'high', asDefault: false })
  })
})
