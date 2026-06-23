import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { McpServerConfig } from '@shared/types'
import { mcpToolName } from '@shared/mcp'
import { McpClient, type SpawnFn } from './client'
import { _setMcpClientFactory, disconnectAllMcp, getMcpToolDefs } from './manager'

/** A fake stdio server exposing one tool — a fresh child per spawn call. */
function okSpawn(toolName = 'echo'): SpawnFn {
  return (() => {
    const stdout = new EventEmitter()
    const stdin = {
      write(line: string): boolean {
        const msg = JSON.parse(line.trim()) as { id?: number; method: string }
        if (msg.id === undefined) return true
        const result = msg.method === 'tools/list' ? { tools: [{ name: toolName }] } : {}
        queueMicrotask(() =>
          stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`))
        )
        return true
      }
    }
    return Object.assign(new EventEmitter(), { stdout, stdin, stderr: new EventEmitter(), kill: () => {} })
  }) as unknown as SpawnFn
}

/** A spawn whose process errors right after start, so connect() rejects fast. The
 * child is created per call (inside connect), so the error fires after connect's
 * 'error' listener is attached. */
function failingSpawn(): SpawnFn {
  return (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stdin: { write: () => true },
      stderr: new EventEmitter(),
      kill: () => {}
    })
    queueMicrotask(() => child.emit('error', new Error('boom')))
    return child
  }) as unknown as SpawnFn
}

let created: McpClient[] = []
function useFactory(spawn: SpawnFn): void {
  created = []
  _setMcpClientFactory(() => {
    const c = new McpClient(spawn)
    created.push(c)
    return c
  })
}

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'srv',
  name: 'Srv',
  command: 'fake',
  args: [],
  enabled: true,
  ...over
})

afterEach(() => {
  disconnectAllMcp()
  _setMcpClientFactory(null)
})

describe('mcp manager', () => {
  it('namespaces each server tool as mcp__<id>__<tool>', async () => {
    useFactory(okSpawn('echo'))
    const defs = await getMcpToolDefs([cfg()])
    expect(defs.map((d) => d.schema.name)).toEqual([mcpToolName('srv', 'echo')])
    expect(defs[0].kind).toBe('mcp')
  })

  it('reuses an unchanged connection across calls (no reconnect)', async () => {
    useFactory(okSpawn())
    await getMcpToolDefs([cfg()])
    await getMcpToolDefs([cfg()])
    expect(created).toHaveLength(1)
    expect(created[0].isClosed).toBe(false)
  })

  it('reconnects when the config changes, closing the old client', async () => {
    useFactory(okSpawn())
    await getMcpToolDefs([cfg()])
    await getMcpToolDefs([cfg({ args: ['--flag'] })])
    expect(created).toHaveLength(2)
    expect(created[0].isClosed).toBe(true)
    expect(created[1].isClosed).toBe(false)
  })

  it('closes and drops a server that is removed', async () => {
    useFactory(okSpawn())
    await getMcpToolDefs([cfg()])
    const defs = await getMcpToolDefs([])
    expect(defs).toEqual([])
    expect(created[0].isClosed).toBe(true)
  })

  it('skips a server that fails to connect (no throw, no tools)', async () => {
    useFactory(failingSpawn())
    const defs = await getMcpToolDefs([cfg()])
    expect(defs).toEqual([])
  })

  it('returns [] when no servers are configured', async () => {
    expect(await getMcpToolDefs(undefined)).toEqual([])
    expect(await getMcpToolDefs([])).toEqual([])
  })
})
