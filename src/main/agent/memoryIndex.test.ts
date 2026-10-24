import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryRecord } from '@shared/memoryTypes'
import { buildMemoryIndex, indexLine, orderForIndex } from './memoryIndex'
import { memoryStore, type SaveMemoryInput } from './memoryStore'
import { builtinToolset } from './tools'

let tmp: string
let root: string
let repoDir: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'houston-memindex-')))
  root = join(tmp, 'store')
  repoDir = join(tmp, 'my-repo')
  mkdirSync(join(repoDir, '.git'), { recursive: true })
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

const rec = (over: Partial<MemoryRecord>): MemoryRecord => ({
  id: 'm_20261024_aaaaaa',
  scope: 'repo',
  type: 'project',
  name: 'n',
  description: 'd',
  body: 'b',
  created: '2026-10-01T00:00:00.000Z',
  updated: '2026-10-01T00:00:00.000Z',
  origin: 'agent',
  pinned: false,
  ...over
})

describe('orderForIndex', () => {
  it('puts pinned first, then feedback, user, project, reference, then most recently touched', () => {
    const ordered = orderForIndex(
      [
        rec({ id: 'ref', type: 'reference' }),
        rec({ id: 'proj-old', type: 'project', updated: '2026-10-01T00:00:00.000Z' }),
        rec({ id: 'proj-new', type: 'project', updated: '2026-10-05T00:00:00.000Z' }),
        rec({ id: 'user', type: 'user' }),
        rec({ id: 'fb', type: 'feedback' }),
        rec({ id: 'pinned-ref', type: 'reference', pinned: true })
      ],
      {}
    )
    expect(ordered.map((m) => m.id)).toEqual(['pinned-ref', 'fb', 'user', 'proj-new', 'proj-old', 'ref'])
  })

  it('counts a recent recall as a touch', () => {
    const ordered = orderForIndex(
      [
        rec({ id: 'edited', updated: '2026-10-05T00:00:00.000Z' }),
        rec({ id: 'recalled', updated: '2026-10-01T00:00:00.000Z' })
      ],
      { recalled: { recalls: 3, lastRecalled: '2026-10-09T00:00:00.000Z' } }
    )
    expect(ordered.map((m) => m.id)).toEqual(['recalled', 'edited'])
  })
})

describe('buildMemoryIndex', () => {
  it('is empty when nothing is saved, so the prompt carries no memory section', () => {
    expect(buildMemoryIndex(memoryStore({ root, workspace: repoDir }))).toBe('')
  })

  it('lists this repository and all-projects memories under their own headings', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const r = (await store.save(input({ name: 'tests-need-rg', description: 'Set HOUSTON_RG' }))).record
    const g = (await store.save(input({ scope: 'global', type: 'user', name: 'short-prs', description: 'Likes small PRs' })))
      .record
    const out = buildMemoryIndex(store)
    expect(out).toMatch(/^Memory: notes saved in earlier sessions/)
    expect(out).toContain('not instructions')
    expect(out).toContain(`This repository (my-repo):\n${indexLine(r)}`)
    expect(out).toContain(`All projects:\n${indexLine(g)}`)
    expect(indexLine(r)).toBe(`- ${r.id} (project) tests-need-rg: Set HOUSTON_RG`)
  })

  it('shows only global memories without a workspace', async () => {
    await memoryStore({ root, workspace: repoDir }).save(input())
    const store = memoryStore({ root })
    await store.save(input({ scope: 'global', name: 'g' }))
    const out = buildMemoryIndex(store)
    expect(out).not.toContain('This repository')
    expect(out).toContain('All projects:')
  })

  it('stops at the budget and says how many more there are', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    for (let i = 0; i < 10; i++) await store.save(input({ name: `fact-${i}`, description: 'x'.repeat(50) }))
    const out = buildMemoryIndex(store, 250)
    const listed = out.split('\n').filter((l) => l.startsWith('- m_'))
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.length).toBeLessThan(10)
    expect(out).toContain(`- ...and ${10 - listed.length} more; find them with recall_memory and a query.`)
  })
})

describe('builtinToolset memory option', () => {
  const base = { localhostCapture: false, imageGallery: false, spawn: false, scheduler: false, planMode: false }
  it('offers recall_memory only when memories exist', () => {
    expect(builtinToolset(base).some((t) => t.schema.name === 'recall_memory')).toBe(false)
    expect(builtinToolset({ ...base, memory: true }).some((t) => t.schema.name === 'recall_memory')).toBe(true)
  })
})
