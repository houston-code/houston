import { describe, it, expect } from 'vitest'
import type { AppSettings } from '@shared/types'
import {
  CONFIG_KEYS,
  configPatch,
  findConfigKey,
  nextConfigValue,
  parseConfigArgs,
  renderConfigHelp,
  renderConfigValue,
  type ConfigContext,
  type ConfigLive
} from './tui-config'

const settings = (over: Partial<AppSettings> = {}): AppSettings =>
  ({
    schemaVersion: 1,
    providers: [
      { id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }], defaultModel: 'claude' },
      { id: 'ollama', requiresKey: false, hasKey: false, models: [{ id: 'llama' }] }
    ],
    selected: { providerId: 'anthropic', model: 'claude' },
    approvalPolicy: 'ask',
    recentWorkspaces: [],
    ...over
  }) as unknown as AppSettings

const ctx = (over: Partial<AppSettings> = {}): ConfigContext => ({ settings: settings(over), themes: ['default', 'light', 'mono'] })
const live: ConfigLive = {
  theme: 'default',
  verbose: false,
  reasoningDisplay: 'summary',
  notifyMode: 'auto',
  reduceMotion: false,
  screenReader: false
}

describe('findConfigKey', () => {
  it('finds a key by name or alias, ignoring case', () => {
    expect(findConfigKey('theme')?.key).toBe('theme')
    expect(findConfigKey('TuiEditor')?.key).toBe('vim')
    expect(findConfigKey('reasoningDisplay')?.key).toBe('thoughts')
    expect(findConfigKey('default-model')?.key).toBe('model')
    expect(findConfigKey('nope')).toBeNull()
    expect(findConfigKey('')).toBeNull()
  })

  it('lists no key that holds a secret', () => {
    const names = CONFIG_KEYS.flatMap((k) => [k.key, ...k.aliases]).join(' ').toLowerCase()
    for (const word of ['key', 'token', 'secret', 'header', 'password', 'env']) expect(names).not.toContain(word)
    expect(findConfigKey('providers')).toBeNull()
    expect(findConfigKey('apiKey')).toBeNull()
  })
})

describe('parseConfigArgs', () => {
  it('bare opens the picker; --help, -h and help list the keys', () => {
    expect(parseConfigArgs('', ctx())).toEqual({ op: 'picker' })
    expect(parseConfigArgs('  ', ctx())).toEqual({ op: 'picker' })
    for (const h of ['--help', '-h', 'help', 'HELP']) expect(parseConfigArgs(h, ctx())).toEqual({ op: 'help' })
  })

  it('a key alone shows it', () => {
    expect(parseConfigArgs('vim', ctx())).toEqual({ op: 'show', key: 'vim' })
    expect(parseConfigArgs('reduceMotion', ctx())).toEqual({ op: 'show', key: 'reduce-motion' })
  })

  it('key=value and key value set it, normalized', () => {
    expect(parseConfigArgs('vim=on', ctx())).toEqual({ op: 'set', key: 'vim', value: 'on' })
    expect(parseConfigArgs('vim true', ctx())).toEqual({ op: 'set', key: 'vim', value: 'on' })
    expect(parseConfigArgs('verbose = No', ctx())).toEqual({ op: 'set', key: 'verbose', value: 'off' })
    expect(parseConfigArgs('theme=LIGHT', ctx())).toEqual({ op: 'set', key: 'theme', value: 'light' })
    expect(parseConfigArgs('notify=bell', ctx())).toEqual({ op: 'set', key: 'notify', value: 'bell' })
    expect(parseConfigArgs('thoughts hide', ctx())).toEqual({ op: 'set', key: 'thoughts', value: 'hide' })
    expect(parseConfigArgs('effort=high', ctx())).toEqual({ op: 'set', key: 'effort', value: 'high' })
    // The one-word approval names work as they do as commands.
    expect(parseConfigArgs('approval=full', ctx())).toEqual({ op: 'set', key: 'approval', value: 'full-auto' })
    expect(parseConfigArgs('model=llama', ctx())).toEqual({ op: 'set', key: 'model', value: 'ollama/llama' })
    expect(parseConfigArgs('model anthropic', ctx())).toEqual({ op: 'set', key: 'model', value: 'anthropic/claude' })
  })

  it('an unknown key or value is an error naming what it accepts', () => {
    const unknown = parseConfigArgs('colour=red', ctx())
    expect(unknown).toEqual({ op: 'error', message: expect.stringContaining('no setting "colour"') })
    expect(unknown.op === 'error' && unknown.message).toContain('/config --help')
    const bad = parseConfigArgs('theme=neon', ctx())
    expect(bad).toEqual({ op: 'error', message: expect.stringContaining('default | light | mono') })
    expect(parseConfigArgs('vim=maybe', ctx())).toEqual({ op: 'error', message: expect.stringContaining('on | off') })
    expect(parseConfigArgs('effort=extreme', ctx())).toEqual({ op: 'error', message: expect.stringContaining('xhigh') })
    expect(parseConfigArgs('model=gpt-x', ctx())).toEqual({ op: 'error', message: expect.stringContaining('no configured model') })
    // A known provider with a model it does not list: saving would re-point it to the
    // provider's default, so it is refused rather than confirmed.
    expect(parseConfigArgs('model=anthropic/claude-sonet-5', ctx())).toEqual({
      op: 'error',
      message: expect.stringContaining('no configured model')
    })
    expect(parseConfigArgs('model=anthropic/claude', ctx())).toEqual({ op: 'set', key: 'model', value: 'anthropic/claude' })
    expect(parseConfigArgs('vim=', ctx())).toEqual({ op: 'error', message: expect.stringContaining('give vim a value') })
  })

  it('never echoes control characters from what was typed', () => {
    const r = parseConfigArgs('x\u001b[31m=1', ctx())
    expect(r.op === 'error' && r.message).not.toContain('\u001b')
    const v = parseConfigArgs('theme=\u001b]0;x\u0007', ctx())
    expect(v.op === 'error' && v.message).not.toContain('\u001b')
    expect(v.op === 'error' && v.message).not.toContain('\u0007')
  })
})

describe('nextConfigValue', () => {
  it('steps through the values and wraps', () => {
    const vim = findConfigKey('vim')!
    expect(nextConfigValue(vim, 'off', ctx())).toBe('on')
    expect(nextConfigValue(vim, 'on', ctx())).toBe('off')
    const thoughts = findConfigKey('thoughts')!
    expect(nextConfigValue(thoughts, 'hide', ctx())).toBe('show')
    expect(nextConfigValue(findConfigKey('theme')!, 'mono', ctx())).toBe('default')
  })

  it('has no next value for the model (it is picked from a list)', () => {
    expect(nextConfigValue(findConfigKey('model')!, 'anthropic/claude', ctx())).toBeNull()
  })
})

describe('configPatch', () => {
  const s = settings()
  it('saves the defaults for new chats', () => {
    expect(configPatch('model', 'ollama/llama', s)?.patch).toEqual({ selected: { providerId: 'ollama', model: 'llama' } })
    expect(configPatch('effort', 'low', s)?.patch).toEqual({ reasoningEffort: 'low' })
    expect(configPatch('approval', 'auto-edit', s)?.patch).toEqual({ approvalPolicy: 'auto-edit' })
    expect(configPatch('approval', 'auto-edit', s)?.note).toContain('new chats')
  })

  it('saves the plain switches', () => {
    expect(configPatch('desktop-notifications', 'off', s)?.patch).toEqual({ desktopNotifications: false })
    expect(configPatch('background-wake', 'on', s)?.patch).toEqual({ backgroundWake: true })
    expect(configPatch('memory', 'off', s)?.patch).toEqual({ memoryEnabled: false })
  })

  it('leaves the terminal keys to their own commands, and refuses bad values', () => {
    expect(configPatch('theme', 'light', s)).toBeNull()
    expect(configPatch('vim', 'on', s)).toBeNull()
    expect(configPatch('model', 'nowhere/x', s)).toBeNull()
    expect(configPatch('effort', 'huge', s)).toBeNull()
  })
})

describe('rendering', () => {
  it('/config --help lists every key with its value now', () => {
    const text = renderConfigHelp(settings({ tuiEditor: 'vim', memoryEnabled: false }), live, ctx())
    for (const k of CONFIG_KEYS) expect(text).toContain(k.key)
    expect(text).toMatch(/vim\s+on/)
    expect(text).toMatch(/memory\s+off/)
    expect(text).toMatch(/model\s+anthropic\/claude/)
    expect(text).toContain('/login')
    expect(text).not.toContain('—')
  })

  it('/config <key> shows the value and what it takes', () => {
    const text = renderConfigValue(findConfigKey('notify')!, settings(), { ...live, notifyMode: 'bell' }, ctx())
    expect(text).toContain('notify: bell')
    expect(text).toContain('auto | osc | bell | off')
  })
})
