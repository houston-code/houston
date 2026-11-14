import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const shell = vi.hoisted(() => ({
  openPath: vi.fn(async (_p: string) => ''),
  trashItem: vi.fn(async (_p: string) => undefined)
}))
vi.mock('electron', () => ({ shell }))

import { IPC } from '@shared/constants'
import { registerCustomizeIpc, workspaceArg } from './customizeIpc'

let ws: string
beforeEach(() => {
  vi.clearAllMocks()
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'houston-cusipc-')))
  mkdirSync(join(ws, '.houston', 'commands'), { recursive: true })
  writeFileSync(join(ws, '.houston', 'commands', 'deploy.md'), 'Ship it')
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

function register(known: (w: string) => boolean): Map<string, (...args: unknown[]) => unknown> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const handle = ((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)) as never
  registerCustomizeIpc(handle, known)
  return handlers
}

describe('workspaceArg', () => {
  it('takes only a project the app knows, as its real path', () => {
    expect(workspaceArg(ws, () => true)).toBe(ws)
    expect(workspaceArg(ws, () => false)).toBeNull()
    expect(workspaceArg('', () => true)).toBeNull()
    expect(workspaceArg(42, () => true)).toBeNull()
    expect(workspaceArg(join(ws, 'missing'), () => true)).toBeNull()
  })
})

describe('registerCustomizeIpc', () => {
  it('treats an unknown folder as no project: nothing in it is opened, created or listed', async () => {
    const h = register(() => false)
    expect(await h.get(IPC.customizeOpen)!({}, ws, 'command:project:deploy')).toMatchObject({ ok: false })
    expect(await h.get(IPC.customizeCreate)!({}, ws, 'command', 'project', 'x')).toEqual({
      ok: false,
      error: 'Open a project first.'
    })
    const overview = (await h.get(IPC.customizeList)!({}, ws)) as { items: { scope: string }[] }
    expect(overview.items.filter((i) => i.scope === 'project')).toEqual([])
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('opens an item in a known project by its real path', async () => {
    const h = register((w) => w === ws)
    expect(await h.get(IPC.customizeOpen)!({}, ws, 'command:project:deploy')).toEqual({ ok: true })
    expect(shell.openPath).toHaveBeenCalledWith(join(ws, '.houston', 'commands', 'deploy.md'))
  })
})
