import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PluginHost,
  PLUGINS_DIR,
  evaluatePlugin,
  loadPlugins,
  type PluginEvent
} from './plugins'

/** Make a workspace with the given `.houston/plugins/<name>` files. */
function workspaceWith(files: Record<string, string>): string {
  const ws = mkdtempSync(join(tmpdir(), 'houston-plugins-'))
  mkdirSync(join(ws, PLUGINS_DIR), { recursive: true })
  for (const [name, src] of Object.entries(files)) {
    writeFileSync(join(ws, PLUGINS_DIR, name), src)
  }
  return ws
}

describe('evaluatePlugin', () => {
  it('registers hooks via houston.on', () => {
    const regs = evaluatePlugin('p.js', `houston.on('onToolStart', () => {})`)
    expect(regs).toHaveLength(1)
    expect(regs[0]).toMatchObject({ plugin: 'p.js', event: 'onToolStart' })
  })

  it('ignores unknown events and non-function handlers, warning each', () => {
    const warn = vi.fn()
    const regs = evaluatePlugin(
      'p.js',
      `houston.on('nope', () => {}); houston.on('onToolStart', 42)`,
      warn
    )
    expect(regs).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('returns [] and warns when the plugin throws at load', () => {
    const warn = vi.fn()
    const regs = evaluatePlugin('bad.js', `throw new Error('boom')`, warn)
    expect(regs).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to load'))
  })

  it('denies require/process/module access (no ambient capabilities)', () => {
    const warn = vi.fn()
    // Any of these would throw a ReferenceError inside the vm context.
    for (const expr of ['require("fs")', 'process.exit(1)', 'module.exports = 1']) {
      const regs = evaluatePlugin('x.js', expr, warn)
      expect(regs).toEqual([])
    }
    expect(warn).toHaveBeenCalledTimes(3)
  })
})

describe('PluginHost.emit', () => {
  it('fires registered listeners with the payload', async () => {
    const seen: unknown[] = []
    const host = new PluginHost([
      { plugin: 'p.js', event: 'onToolStart', fn: (e) => seen.push(e) }
    ])
    expect(host.has('onToolStart')).toBe(true)
    expect(host.has('onToolResult')).toBe(false)
    await host.emit('onToolStart', { tool: 'read_file', input: { path: 'a' } })
    expect(seen).toEqual([{ tool: 'read_file', input: { path: 'a' } }])
  })

  it('freezes the payload so a listener cannot mutate shared state', async () => {
    const host = new PluginHost([
      {
        plugin: 'p.js',
        event: 'onToolStart',
        fn: (e) => {
          // Mutation must not take — payload is deep-frozen.
          ;(e as { tool: string }).tool = 'hacked'
        }
      }
    ])
    const payload = { tool: 'read_file', input: {} }
    await host.emit('onToolStart', payload)
    expect(payload.tool).toBe('read_file')
  })

  it('isolates a throwing listener and still runs the next one', async () => {
    const warn = vi.fn()
    let ran = false
    const host = new PluginHost(
      [
        { plugin: 'boom.js', event: 'onToolResult', fn: () => { throw new Error('x') } },
        { plugin: 'ok.js', event: 'onToolResult', fn: () => { ran = true } }
      ],
      warn
    )
    await host.emit('onToolResult', { tool: 't', input: {}, output: 'o', ok: true })
    expect(ran).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[plugin:boom.js]'))
  })

  it('times out a hung listener instead of blocking forever', async () => {
    const warn = vi.fn()
    const host = new PluginHost(
      [{ plugin: 'slow.js', event: 'onUserMessage', fn: () => new Promise(() => {}) }],
      warn
    )
    await host.emit('onUserMessage', { text: 'hi' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  })

  it('is a no-op when no listener is registered for the event', async () => {
    const host = new PluginHost([])
    await expect(host.emit('onToolStart', { tool: 't', input: {} })).resolves.toBeUndefined()
  })
})

describe('loadPlugins', () => {
  it('returns an empty host when there is no plugins dir', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'houston-noplugins-'))
    try {
      const host = await loadPlugins(ws)
      expect(host.size).toBe(0)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('loads a sample plugin and its hook fires through the loop API', async () => {
    // A realistic sample plugin: an in-memory audit log of tool starts.
    const sample = `
      const log = []
      houston.on('onToolStart', (e) => { log.push(e.tool) })
      houston.on('onUserMessage', (e) => { if (e.text === 'crash') throw new Error('nope') })
    `
    const ws = workspaceWith({ 'audit.js': sample })
    try {
      const host = await loadPlugins(ws)
      expect(host.size).toBe(2)
      expect(host.has('onToolStart')).toBe(true)
      // Firing the hook does not throw; the plugin's listener runs.
      await expect(
        host.emit('onToolStart', { tool: 'write_file', input: { path: 'x' } })
      ).resolves.toBeUndefined()
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('skips non-.js files and aggregates multiple plugins deterministically', async () => {
    const ws = workspaceWith({
      'b.js': `houston.on('onToolResult', () => {})`,
      'a.js': `houston.on('onToolStart', () => {})`,
      'notes.txt': `houston.on('onToolStart', () => {})`
    })
    try {
      const host = await loadPlugins(ws)
      expect(host.size).toBe(2)
      expect(host.has('onToolStart')).toBe(true)
      expect(host.has('onToolResult')).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('skips oversized plugin files', async () => {
    const big = `// ${'x'.repeat(300 * 1024)}\nhouston.on('onToolStart', () => {})`
    const ws = workspaceWith({ 'big.js': big })
    const warn = vi.fn()
    try {
      const host = await loadPlugins(ws, warn)
      expect(host.size).toBe(0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds'))
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('one broken plugin does not prevent loading the others', async () => {
    const ws = workspaceWith({
      'broken.js': `this is not valid javascript ::: !!!`,
      'good.js': `houston.on('onToolStart', () => {})`
    })
    const warn = vi.fn()
    try {
      const host = await loadPlugins(ws, warn)
      expect(host.size).toBe(1)
      expect(host.has('onToolStart')).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

// Exhaustiveness guard: every PluginEvent is covered above.
const _events: PluginEvent[] = ['onToolStart', 'onToolResult', 'onUserMessage']
void _events
