import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PluginHost,
  PLUGINS_DIR,
  evaluatePlugin,
  loadPlugins,
  loadTrustedPlugins,
  readPluginFiles,
  type PluginEvent
} from './plugins'

// The default warn sink is the file logger; capture it instead of touching disk.
const logged = vi.hoisted(() => ({ warns: [] as string[] }))
vi.mock('../logger', () => ({
  log: {
    info: () => {},
    warn: (m: string) => logged.warns.push(m),
    error: () => {}
  }
}))

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

  it('terminates a synchronous busy loop at the budget instead of freezing the process', async () => {
    const warn = vi.fn()
    const host = new PluginHost(
      [
        {
          plugin: 'spin.js',
          event: 'onToolStart',
          fn: () => {
            for (;;) {
              // runaway synchronous code
            }
          }
        }
      ],
      warn
    )
    const started = Date.now()
    await host.emit('onToolStart', { tool: 't', input: {} })
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(2_500)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[plugin:spin.js]'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  }, 10_000)

  it('terminates a busy loop defined in plugin source and keeps running later listeners', async () => {
    const warn = vi.fn()
    const regs = [
      ...evaluatePlugin('spin.js', `houston.on('onToolResult', () => { while (true) {} })`, warn),
      ...evaluatePlugin('ok.js', `houston.on('onToolResult', (e) => { globalThis.seen = e.tool })`, warn)
    ]
    let ran = false
    regs.push({ plugin: 'probe.js', event: 'onToolResult', fn: () => { ran = true } })
    const host = new PluginHost(regs, warn)
    const started = Date.now()
    await host.emit('onToolResult', { tool: 't', input: {}, output: 'o', ok: true })
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(ran).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[plugin:spin.js]'))
  }, 10_000)

  it('still awaits an async listener to completion', async () => {
    const seen: string[] = []
    const warn = vi.fn()
    const host = new PluginHost(
      [
        {
          plugin: 'async.js',
          event: 'onUserMessage',
          fn: async (e) => {
            await new Promise((r) => setTimeout(r, 20))
            seen.push((e as { text: string }).text)
          }
        }
      ],
      warn
    )
    await host.emit('onUserMessage', { text: 'hi' })
    expect(seen).toEqual(['hi'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports failures to the log by default and never writes to stderr', async () => {
    logged.warns.length = 0
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const host = new PluginHost([
        { plugin: 'boom.js', event: 'onToolStart', fn: () => { throw new Error('kaboom') } }
      ])
      await host.emit('onToolStart', { tool: 't', input: {} })
      expect(stderr).not.toHaveBeenCalled()
      expect(consoleWarn).not.toHaveBeenCalled()
      expect(logged.warns).toEqual([expect.stringContaining('[plugin:boom.js] onToolStart failed: kaboom')])
    } finally {
      stderr.mockRestore()
      consoleWarn.mockRestore()
    }
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

describe('readPluginFiles', () => {
  it('reads and hashes the files that would load, in sorted order, evaluating nothing', async () => {
    const ws = workspaceWith({
      'b.js': 'throw new Error("never evaluated")',
      'a.js': '// a',
      'notes.txt': 'not a plugin'
    })
    try {
      const { files, skipped } = await readPluginFiles(ws)
      expect(files.map((f) => f.name)).toEqual(['a.js', 'b.js'])
      expect(files[0]!.sha256).toBe(createHash('sha256').update('// a').digest('hex'))
      expect(files[0]!.source).toBe('// a')
      expect(skipped).toEqual([])
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('reports an oversized file as skipped instead of reading it', async () => {
    const ws = workspaceWith({ 'big.js': `// ${'x'.repeat(300 * 1024)}` })
    try {
      const { files, skipped } = await readPluginFiles(ws)
      expect(files).toEqual([])
      expect(skipped).toEqual([{ name: 'big.js', reason: expect.stringContaining('exceeds') }])
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('never follows a symlinked plugin file', async () => {
    const ws = workspaceWith({})
    const outside = mkdtempSync(join(tmpdir(), 'houston-plugin-target-'))
    writeFileSync(join(outside, 'x.js'), '// outside the project')
    symlinkSync(join(outside, 'x.js'), join(ws, PLUGINS_DIR, 'link.js'))
    try {
      expect((await readPluginFiles(ws)).files).toEqual([])
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('is empty when the workspace has no plugins folder', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'houston-plugins-none-'))
    try {
      expect(await readPluginFiles(ws)).toEqual({ files: [], skipped: [] })
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

describe('loadTrustedPlugins', () => {
  const file = (source: string): { name: string; sha256: string; source: string } => ({
    name: 'p.js',
    sha256: createHash('sha256').update(source).digest('hex'),
    source
  })
  // A plugin that registers a hook (and so would show up in `size`) if it were ever
  // evaluated.
  const probe = (): { name: string; sha256: string; source: string } =>
    file(`houston.on('onToolStart', () => {})`)

  it('does NOT evaluate plugins when the setting is off, even for a trusted folder', async () => {
    for (const enabled of [undefined, false]) {
      const host = await loadTrustedPlugins([probe()], { enabled, trusted: true })
      expect(host.size).toBe(0)
      expect(host.has('onToolStart')).toBe(false)
    }
  })

  it('does NOT evaluate plugins for an untrusted folder, even with the setting on', async () => {
    // The global switch alone must never run a repository's plugin.
    const warn = vi.fn()
    const host = await loadTrustedPlugins(
      [file(`throw new Error('evaluated an untrusted plugin')`)],
      { enabled: true, trusted: false },
      warn
    )
    expect(host.size).toBe(0)
    // Not even evaluated: a throwing top level would have warned.
    expect(warn).not.toHaveBeenCalled()
  })

  it('evaluates exactly the given sources when the setting is on and the folder is trusted', async () => {
    const host = await loadTrustedPlugins([probe()], { enabled: true, trusted: true })
    expect(host.size).toBe(1)
    expect(host.has('onToolStart')).toBe(true)
  })
})

// Exhaustiveness guard: every PluginEvent is covered above.
const _events: PluginEvent[] = ['onToolStart', 'onToolResult', 'onUserMessage']
void _events
