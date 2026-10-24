import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import { memoryStore, type MemoryStore, type SaveMemoryInput } from './agent/memoryStore'
import { makePainter, parseSlashCommand } from './tui'
import {
  numberedMemories,
  parseMemoryAction,
  renderMemoryList,
  runMemoryCommand,
  type MemoryCommandDeps,
  type MemoryCommandState
} from './tui-memory'

let tmp: string
let store: MemoryStore
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'houston-tuimem-')))
  const ws = join(tmp, 'app')
  mkdirSync(join(ws, '.git'), { recursive: true })
  store = memoryStore({ root: join(tmp, 'store'), workspace: ws })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const paint = makePainter(false)
const input = (over: Partial<SaveMemoryInput> = {}): SaveMemoryInput => ({
  scope: 'repo',
  type: 'project',
  name: 'tests-need-rg',
  description: 'Set HOUSTON_RG',
  body: 'The search tests need it.',
  origin: 'agent',
  ...over
})

function harness(over: Partial<MemoryCommandDeps> = {}) {
  const out: string[] = []
  const settings = { memoryEnabled: true } as AppSettings
  const deps: MemoryCommandDeps = {
    store: () => store,
    getSettings: () => settings,
    updateSettings: vi.fn((patch: Partial<AppSettings>) => Object.assign(settings, patch)),
    out: (t) => out.push(t),
    ...over
  }
  const state: MemoryCommandState = {}
  const run = (arg: string) => runMemoryCommand(parseMemoryAction(arg), deps, state, paint)
  return { out, deps, settings, run, text: () => out.join('') }
}

describe('parseMemoryAction', () => {
  it('reads each verb and its number', () => {
    expect(parseMemoryAction('')).toEqual({ op: 'list' })
    expect(parseMemoryAction('show 2')).toEqual({ op: 'show', index: 2 })
    expect(parseMemoryAction('rm 1')).toEqual({ op: 'forget', index: 1 })
    expect(parseMemoryAction('Forget 3')).toEqual({ op: 'forget', index: 3 })
    expect(parseMemoryAction('pin 1')).toEqual({ op: 'pin', index: 1 })
    expect(parseMemoryAction('off')).toEqual({ op: 'enable', on: false })
    expect(parseMemoryAction('undo')).toEqual({ op: 'undo' })
    expect(parseMemoryAction('folder')).toEqual({ op: 'folder' })
    for (const bad of ['show', 'show 0', 'edit x', 'explode 1']) expect(parseMemoryAction(bad), bad).toEqual({ op: 'usage' })
  })

  it('is what /memory parses to', () => {
    expect(parseSlashCommand('/memory pin 2', {} as AppSettings)).toEqual({ kind: 'memory', action: { op: 'pin', index: 2 } })
  })
})

describe('/memory', () => {
  it('lists this repository first, then all projects, numbered across both', async () => {
    await store.save(input({ scope: 'global', type: 'user', name: 'short-prs', description: 'Small PRs' }))
    await store.save(input({ pinned: true }))
    const h = harness()
    await h.run('')
    const text = h.text()
    expect(text).toContain('This repository (app)')
    expect(text.indexOf(' 1) tests-need-rg [project] (pinned)')).toBeLessThan(text.indexOf(' 2) short-prs [user]'))
    expect(text).toContain('All projects')
    expect(numberedMemories(store).map((m) => m.name)).toEqual(['tests-need-rg', 'short-prs'])
  })

  it('says when nothing is saved, and when memory is off', () => {
    expect(renderMemoryList(store, false, paint)).toContain('Memory (off: /memory on to use it)')
    expect(renderMemoryList(store, true, paint)).toContain('Nothing saved yet.')
  })

  it('shows a memory in full, with control characters stripped', async () => {
    await store.save(input({ body: 'line one\n\u001b[31mred\u001b[0m line two' }))
    const h = harness()
    await h.run('show 1')
    expect(h.text()).toContain('tests-need-rg [project, this repository, updated ')
    expect(h.text()).toContain('line one')
    expect(h.text()).not.toContain('\u001b[31m')
  })

  it('forgets with an undo, once', async () => {
    const m = (await store.save(input())).record
    const h = harness()
    await h.run('forget 1')
    expect(h.text()).toContain('forgot tests-need-rg (/memory undo brings it back)')
    expect(store.get('repo', m.id)).toBeNull()
    await h.run('undo')
    expect(store.get('repo', m.id)?.name).toBe('tests-need-rg')
    await h.run('undo')
    expect(h.text()).toContain('nothing to undo')
  })

  it('pins and unpins', async () => {
    const m = (await store.save(input())).record
    const h = harness()
    await h.run('pin 1')
    expect(store.get('repo', m.id)?.pinned).toBe(true)
    await h.run('unpin 1')
    expect(store.get('repo', m.id)?.pinned).toBe(false)
  })

  it('edits the text in the editor as the user', async () => {
    const m = (await store.save(input())).record
    const editText = vi.fn(async (initial: string) => `${initial}\nAlso run it with --silent.`)
    const h = harness({ editText })
    await h.run('edit 1')
    expect(editText).toHaveBeenCalledWith('The search tests need it.')
    expect(store.get('repo', m.id)).toMatchObject({ origin: 'user', body: 'The search tests need it.\nAlso run it with --silent.' })
    expect(h.text()).toContain('saved tests-need-rg')
  })

  it('leaves a memory alone when the edit is cancelled, unchanged, or refused', async () => {
    const m = (await store.save(input())).record
    await harness({ editText: async () => null }).run('edit 1')
    await harness({ editText: async (s) => s }).run('edit 1')
    const refused = harness({ editText: async () => `ghp_${'a'.repeat(36)}` })
    await refused.run('edit 1')
    expect(refused.text()).toMatch(/looks like a credential/)
    expect(store.get('repo', m.id)?.body).toBe('The search tests need it.')
    const noEditor = harness({ editText: undefined })
    await noEditor.run('edit 1')
    expect(noEditor.text()).toContain('set $EDITOR')
  })

  it('turns memory on and off through the settings', async () => {
    const h = harness()
    await h.run('off')
    expect(h.settings.memoryEnabled).toBe(false)
    expect(h.text()).toContain('nothing is deleted')
    await h.run('on')
    expect(h.settings.memoryEnabled).toBe(true)
  })

  it('handles a missing number, a missing store, and usage', async () => {
    const h = harness()
    await h.run('show 4')
    expect(h.text()).toContain('no memory #4 (there are 0; /memory lists them)')
    await h.run('explode')
    expect(h.text()).toContain('usage: /memory')
    const none = harness({ store: undefined })
    await none.run('')
    expect(none.text()).toContain('memory is unavailable here')
    await h.run('folder')
    expect(h.text()).toContain(`memories live in ${store.root}`)
  })
})
