import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryStore, type SaveMemoryInput } from './agent/memoryStore'
import { handleMemoryRequest, parseMemoryRequest } from './memoryIpc'

let tmp: string
let root: string
let ws: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'houston-memipc-')))
  root = join(tmp, 'store')
  ws = join(tmp, 'app')
  mkdirSync(join(ws, '.git'), { recursive: true })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const input = (over: Partial<SaveMemoryInput> = {}): SaveMemoryInput => ({
  scope: 'repo',
  type: 'project',
  name: 'a-fact',
  description: 'A fact',
  body: 'Body.',
  origin: 'agent',
  ...over
})

describe('parseMemoryRequest', () => {
  it('accepts each well-formed request', () => {
    expect(parseMemoryRequest({ op: 'list', workspace: '' })).toEqual({ op: 'list', workspace: '' })
    expect(parseMemoryRequest({ op: 'remove', workspace: ws, scope: 'repo', id: 'm_1' })).toMatchObject({ op: 'remove' })
    expect(parseMemoryRequest({ op: 'pin', workspace: ws, scope: 'global', id: 'm_1', pinned: true })).toMatchObject({
      pinned: true
    })
    expect(parseMemoryRequest({ op: 'adoptRepo', workspace: ws, key: 'k' })).toMatchObject({ key: 'k' })
  })

  it('refuses malformed requests', () => {
    for (const raw of [
      null,
      'list',
      { op: 'list' },
      { op: 'nuke', workspace: ws },
      { op: 'remove', workspace: ws, scope: 'everywhere', id: 'm_1' },
      { op: 'pin', workspace: ws, scope: 'repo', id: 'm_1', pinned: 'yes' },
      { op: 'update', workspace: ws, scope: 'repo', id: 'm_1', type: 'instruction', name: 'n', description: 'd', body: 'b', expectedUpdated: 'x' },
      { op: 'update', workspace: ws, scope: 'repo', id: 'm_1', type: 'project', name: 'n', description: 'd', body: 'b' },
      { op: 'removeRepo', workspace: ws, key: 5 }
    ]) {
      expect(parseMemoryRequest(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe('handleMemoryRequest', () => {
  it('lists this repository, all projects, and other repositories with memories', async () => {
    const other = join(tmp, 'old-clone')
    mkdirSync(join(other, '.git'), { recursive: true })
    await memoryStore({ root, workspace: ws }).save(input())
    await memoryStore({ root }).save(input({ scope: 'global', name: 'g' }))
    await memoryStore({ root, workspace: other }).save(input({ name: 'elsewhere' }))
    const res = await handleMemoryRequest({ op: 'list', workspace: ws }, root)
    expect(res.ok).toBe(true)
    expect(res.overview.repo).toMatchObject({ label: 'app' })
    expect(res.overview.repoMemories.map((m) => m.name)).toEqual(['a-fact'])
    expect(res.overview.globalMemories.map((m) => m.name)).toEqual(['g'])
    expect(res.overview.otherRepos).toMatchObject([{ label: 'old-clone', count: 1 }])
  })

  it('has no repository section without an open project', async () => {
    const res = await handleMemoryRequest({ op: 'list', workspace: '' }, root)
    expect(res.overview.repo).toBeNull()
    expect(res.overview.repoMemories).toEqual([])
  })

  it('edits a memory as the user, and refuses a stale edit', async () => {
    const m = (await memoryStore({ root, workspace: ws }).save(input())).record
    const edit = { op: 'update', workspace: ws, scope: 'repo', id: m.id, type: 'feedback', name: 'renamed', description: 'New', body: 'New body', expectedUpdated: m.updated }
    const res = await handleMemoryRequest(edit, root)
    expect(res.ok).toBe(true)
    expect(res.overview.repoMemories[0]).toMatchObject({ name: 'renamed', type: 'feedback', origin: 'user', body: 'New body' })
    const stale = await handleMemoryRequest({ ...edit, body: 'again' }, root)
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/changed since it was read/) })
    expect(stale.overview.repoMemories[0].body).toBe('New body')
  })

  it('refuses an edit that would store a credential', async () => {
    const m = (await memoryStore({ root, workspace: ws }).save(input())).record
    const res = await handleMemoryRequest(
      { op: 'update', workspace: ws, scope: 'repo', id: m.id, type: 'project', name: 'x', description: 'd', body: `ghp_${'a'.repeat(36)}`, expectedUpdated: m.updated },
      root
    )
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/credential/) })
  })

  it('deletes, restores, and pins', async () => {
    const m = (await memoryStore({ root, workspace: ws }).save(input())).record
    const del = await handleMemoryRequest({ op: 'remove', workspace: ws, scope: 'repo', id: m.id }, root)
    expect(del.overview.repoMemories).toEqual([])
    const again = await handleMemoryRequest({ op: 'remove', workspace: ws, scope: 'repo', id: m.id }, root)
    expect(again).toMatchObject({ ok: true, note: 'That memory was already deleted.' })
    const back = await handleMemoryRequest({ op: 'restore', workspace: ws, scope: 'repo', id: m.id }, root)
    expect(back.overview.repoMemories.map((r) => r.id)).toEqual([m.id])
    const pinned = await handleMemoryRequest({ op: 'pin', workspace: ws, scope: 'repo', id: m.id, pinned: true }, root)
    expect(pinned.overview.repoMemories[0].pinned).toBe(true)
  })

  it('moves another repository’s memories here, or deletes them', async () => {
    const other = join(tmp, 'old-clone')
    mkdirSync(join(other, '.git'), { recursive: true })
    const old = memoryStore({ root, workspace: other })
    await old.save(input({ name: 'carried' }))
    await old.save(input({ name: 'a-fact' })) // same name as one here: stays behind
    await memoryStore({ root, workspace: ws }).save(input())
    const key = old.currentRepoKey!
    const adopt = await handleMemoryRequest({ op: 'adoptRepo', workspace: ws, key }, root)
    expect(adopt).toMatchObject({ ok: true, note: 'Moved 1 memory; 1 stayed behind (same name here, or this repository is full).' })
    expect(adopt.overview.repoMemories.map((m) => m.name).sort()).toEqual(['a-fact', 'carried'])
    const removed = await handleMemoryRequest({ op: 'removeRepo', workspace: ws, key }, root)
    expect(removed).toMatchObject({ ok: true, note: expect.stringMatching(/^Deleted 1 memory/) })
    expect(removed.overview.otherRepos).toEqual([])
  })

  it('answers a malformed request or a bad key with an error and the current list', async () => {
    expect(await handleMemoryRequest({ op: 'bogus', workspace: ws }, root)).toMatchObject({
      ok: false,
      error: 'That request was malformed.'
    })
    expect(await handleMemoryRequest({ op: 'removeRepo', workspace: ws, key: '../../x' }, root)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a repository key/)
    })
  })
})
