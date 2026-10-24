import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_MEMORIES_PER_SCOPE, MAX_MEMORY_BODY, MAX_MEMORY_DESCRIPTION } from '@shared/memoryTypes'
import { MEMORY_TRASH_TTL_MS, MemoryError, defaultMemoryRoot, memoryStore, type SaveMemoryInput } from './memoryStore'

let tmp: string
let root: string
let repoDir: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'houston-memstore-')))
  root = join(tmp, 'store')
  repoDir = join(tmp, 'repo')
  mkdirSync(join(repoDir, '.git'), { recursive: true })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const input = (over: Partial<SaveMemoryInput> = {}): SaveMemoryInput => ({
  scope: 'repo',
  type: 'project',
  name: 'tests-need-rg',
  description: 'Search tests fail unless HOUSTON_RG points at rg',
  body: 'Set HOUSTON_RG before running search.test.ts.',
  origin: 'agent',
  ...over
})

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof MemoryError) return err.code
    throw err
  }
  return 'ok'
}

describe('memoryStore save and read', () => {
  it('round-trips a memory through its file', async () => {
    const store = memoryStore({ root, workspace: repoDir, now: () => new Date('2026-10-24T18:02:11.000Z') })
    const { record, created } = await store.save(input({ conversation: 'conv_1' }))
    expect(created).toBe(true)
    expect(record.id).toMatch(/^m_20261024_[a-z2-7]{6}$/)
    expect(record).toMatchObject({
      scope: 'repo',
      type: 'project',
      name: 'tests-need-rg',
      created: '2026-10-24T18:02:11.000Z',
      updated: '2026-10-24T18:02:11.000Z',
      origin: 'agent',
      conversation: 'conv_1',
      pinned: false
    })
    expect(store.get('repo', record.id)).toEqual(record)
    expect(store.list('repo')).toEqual([record])

    const file = join(root, 'repos', store.currentRepoKey!, `${record.id}.md`)
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith('---\nv: 1\n')).toBe(true)
    expect(text).toContain('\n---\n\nSet HOUSTON_RG before running search.test.ts.\n')
  })

  it('keeps the global scope separate and needs no workspace for it', async () => {
    const store = memoryStore({ root })
    await store.save(input({ scope: 'global', type: 'user', name: 'prefers-short-prs' }))
    expect(store.list('global')).toHaveLength(1)
    expect(existsSync(join(root, 'global'))).toBe(true)
    await expect(code(store.save(input()))).resolves.toBe('invalid')
  })

  it('normalizes the name to kebab-case and the description to one line', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const { record } = await store.save(input({ name: '  Tests Need RG!! ', description: 'line one\n  line two' }))
    expect(record.name).toBe('tests-need-rg')
    expect(record.description).toBe('line one line two')
  })

  it('survives quotes and colons in the description and a --- line in the body', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const description = '"quoted": a: b "end"'
    const body = 'before\n---\nafter: x'
    const { record } = await store.save(input({ description, body }))
    expect(store.get('repo', record.id)).toMatchObject({ description, body })
  })

  it('strips bidi controls from every field', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const { record } = await store.save(input({ description: 'safe‮txt.exe', body: 'a⁦b' }))
    expect(record.description).toBe('safetxt.exe')
    expect(record.body).toBe('ab')
  })

  it('drops a conversation id that is not a plain token', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const { record } = await store.save(input({ conversation: '../../etc\nv: 2' }))
    expect(record.conversation).toBeUndefined()
    expect(readFileSync(join(root, 'repos', store.currentRepoKey!, `${record.id}.md`), 'utf8')).not.toContain(
      'conversation:'
    )
  })
})

describe('memoryStore updates', () => {
  it('updates by id, keeping created and pinned', async () => {
    let t = new Date('2026-10-24T00:00:00.000Z')
    const store = memoryStore({ root, workspace: repoDir, now: () => t })
    const first = (await store.save(input({ pinned: true }))).record
    t = new Date('2026-10-25T00:00:00.000Z')
    const { record, created } = await store.save(input({ id: first.id, body: 'new body' }))
    expect(created).toBe(false)
    expect(record).toMatchObject({ id: first.id, body: 'new body', created: first.created, pinned: true })
    expect(record.updated).toBe('2026-10-25T00:00:00.000Z')
    expect(store.list('repo')).toHaveLength(1)
  })

  it('updates the memory already holding a name instead of duplicating it (retried saves)', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const a = (await store.save(input())).record
    const b = await store.save(input({ body: 'second' }))
    expect(b.created).toBe(false)
    expect(b.record.id).toBe(a.id)
    expect(store.list('repo').map((m) => m.body)).toEqual(['second'])
  })

  it('refuses renaming onto a name another memory holds', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    await store.save(input({ name: 'one' }))
    const two = (await store.save(input({ name: 'two' }))).record
    await expect(code(store.save(input({ id: two.id, name: 'one' })))).resolves.toBe('invalid')
  })

  it('refuses an unknown or malformed id', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    await expect(code(store.save(input({ id: 'm_20261024_aaaaaa' })))).resolves.toBe('not-found')
    await expect(code(store.save(input({ id: '../../x' })))).resolves.toBe('invalid')
    expect(store.get('repo', '../../x')).toBeNull()
  })

  it('refuses a stale edit', async () => {
    let t = new Date('2026-10-24T00:00:00.000Z')
    const store = memoryStore({ root, workspace: repoDir, now: () => t })
    const first = (await store.save(input())).record
    t = new Date('2026-10-24T00:00:01.000Z')
    await store.save(input({ id: first.id, body: 'someone else' }))
    await expect(
      code(store.save(input({ id: first.id, body: 'mine', expectedUpdated: first.updated })))
    ).resolves.toBe('stale')
    expect(store.get('repo', first.id)?.body).toBe('someone else')
  })

  it('pins and unpins', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const m = (await store.save(input({ conversation: 'c1' }))).record
    expect((await store.setPinned('repo', m.id, true)).pinned).toBe(true)
    const after = store.get('repo', m.id)!
    expect(after).toMatchObject({ pinned: true, body: m.body, conversation: 'c1', origin: 'agent' })
    await expect(code(store.setPinned('repo', 'm_20261024_aaaaaa', true))).resolves.toBe('not-found')
  })
})

describe('memoryStore limits', () => {
  it('refuses empty or oversized fields and unknown enums', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const cases: Partial<SaveMemoryInput>[] = [
      { name: '!!!' },
      { name: 'a'.repeat(65) },
      { description: '   ' },
      { description: 'd'.repeat(MAX_MEMORY_DESCRIPTION + 1) },
      { body: '\n\n' },
      { body: 'b'.repeat(MAX_MEMORY_BODY + 1) },
      { type: 'instruction' as never },
      { origin: 'web' as never }
    ]
    for (const c of cases) await expect(code(store.save(input(c)))).resolves.toBe('invalid')
    expect(store.list('repo')).toEqual([])
  })

  it('refuses credentials in any field, by format and by known value', async () => {
    const store = memoryStore({ root, workspace: repoDir, knownSecrets: ['correct-horse-battery-staple'] })
    await expect(code(store.save(input({ body: `token ghp_${'a'.repeat(36)}` })))).resolves.toBe('secret')
    await expect(code(store.save(input({ description: 'uses correct-horse-battery-staple' })))).resolves.toBe(
      'secret'
    )
    expect(store.list('repo')).toEqual([])
  })

  it('caps a scope but still allows updates when full', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    for (let i = 0; i < MAX_MEMORIES_PER_SCOPE; i++) await store.save(input({ name: `m-${i}` }))
    await expect(code(store.save(input({ name: 'one-more' })))).resolves.toBe('cap')
    const { created } = await store.save(input({ name: 'm-0', body: 'still editable' }))
    expect(created).toBe(false)
  }, 30_000)
})

describe('memoryStore files on disk', () => {
  it.skipIf(process.platform === 'win32')('writes owner-only folders and files', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const { record } = await store.save(input())
    const dir = join(root, 'repos', store.currentRepoKey!)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, `${record.id}.md`)).mode & 0o777).toBe(0o600)
  })

  it('skips corrupt, mismatched, and newer-format files instead of failing', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const good = (await store.save(input())).record
    const dir = join(root, 'repos', store.currentRepoKey!)
    const text = readFileSync(join(dir, `${good.id}.md`), 'utf8')
    writeFileSync(join(dir, 'm_20261024_bbbbbb.md'), 'not front matter at all')
    writeFileSync(join(dir, 'm_20261024_cccccc.md'), text.replace('v: 1', 'v: 2').replace(good.id, 'm_20261024_cccccc'))
    writeFileSync(join(dir, 'm_20261024_dddddd.md'), text) // id doesn't match its file name
    writeFileSync(join(dir, 'notes.txt'), 'ignored')
    expect(store.list('repo').map((m) => m.id)).toEqual([good.id])
  })

  it.skipIf(process.platform === 'win32')('never reads or writes through a symlinked memory file', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const m = (await store.save(input())).record
    const dir = join(root, 'repos', store.currentRepoKey!)
    const outside = join(tmp, 'outside.md')
    writeFileSync(outside, readFileSync(join(dir, `${m.id}.md`), 'utf8').replace(m.id, 'm_20261024_eeeeee'))
    symlinkSync(outside, join(dir, 'm_20261024_eeeeee.md'))
    expect(store.list('repo').map((r) => r.id)).toEqual([m.id])
    expect(store.get('repo', 'm_20261024_eeeeee')).toBeNull()

    // A memory swapped for a symlink is invisible, so an update by its id can't write through it.
    rmSync(join(dir, `${m.id}.md`))
    symlinkSync(outside, join(dir, `${m.id}.md`))
    const before = readFileSync(outside, 'utf8')
    await expect(code(store.save(input({ id: m.id, body: 'through the link' })))).resolves.toBe('not-found')
    expect(readFileSync(outside, 'utf8')).toBe(before)
  })

  it.skipIf(process.platform === 'win32')('refuses to write through a symlinked meta.json', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    await store.save(input())
    const dir = join(root, 'repos', store.currentRepoKey!)
    const outside = join(tmp, 'outside.json')
    writeFileSync(outside, 'keep')
    rmSync(join(dir, 'meta.json'))
    symlinkSync(outside, join(dir, 'meta.json'))
    await expect(code(store.save(input({ name: 'second' })))).resolves.toBe('symlink')
    expect(readFileSync(outside, 'utf8')).toBe('keep')
    expect(store.list('repo').map((r) => r.name)).toEqual(['tests-need-rg'])
    expect(store.listRepos()[0]).toMatchObject({ label: store.currentRepoKey, root: '' })
  })

  it('serializes concurrent saves (no lost or duplicated memories)', async () => {
    const a = memoryStore({ root, workspace: repoDir })
    const b = memoryStore({ root, workspace: repoDir })
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => a.save(input({ name: `a-${i}` }))),
      ...Array.from({ length: 10 }, (_, i) => b.save(input({ name: `b-${i}` }))),
      a.save(input({ name: 'same', body: 'from a' })),
      b.save(input({ name: 'same', body: 'from b' }))
    ])
    const names = a.list('repo').map((m) => m.name)
    expect(names).toHaveLength(21)
    expect(names.filter((n) => n === 'same')).toHaveLength(1)
  })
})

describe('memoryStore repository identity', () => {
  it('shares one folder between a checkout and its linked worktree', async () => {
    const wt = join(tmp, 'wt')
    const wtGitDir = join(repoDir, '.git', 'worktrees', 'wt')
    mkdirSync(wtGitDir, { recursive: true })
    writeFileSync(join(wtGitDir, 'commondir'), '../..\n')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGitDir}\n`)

    const main = memoryStore({ root, workspace: repoDir })
    const linked = memoryStore({ root, workspace: join(wt) })
    expect(linked.currentRepoKey).toBe(main.currentRepoKey)
    const { record } = await main.save(input())
    expect(linked.get('repo', record.id)?.name).toBe('tests-need-rg')
  })

  it('keeps different repositories apart and lists them with labels', async () => {
    const other = join(tmp, 'other-repo')
    mkdirSync(join(other, '.git'), { recursive: true })
    const a = memoryStore({ root, workspace: repoDir })
    const b = memoryStore({ root, workspace: other })
    expect(a.currentRepoKey).not.toBe(b.currentRepoKey)
    await a.save(input())
    await b.save(input({ name: 'x' }))
    await b.save(input({ name: 'y' }))
    expect(a.list('repo')).toHaveLength(1)
    expect(a.listRepos()).toEqual([
      { key: b.currentRepoKey, label: 'other-repo', root: other, count: 2 },
      { key: a.currentRepoKey, label: 'repo', root: repoDir, count: 1 }
    ])
  })

  it('keys a plain folder by its own path', async () => {
    const plain = join(tmp, 'plain')
    mkdirSync(plain)
    const store = memoryStore({ root, workspace: plain })
    expect(store.currentRepoKey).toMatch(/^[0-9a-f]{16}$/)
    await store.save(input())
    expect(store.list('repo')).toHaveLength(1)
  })
})

describe('memoryStore delete, restore, trash', () => {
  it('moves a deleted memory to the trash and restores it', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const m = (await store.save(input())).record
    expect(await store.remove('repo', m.id)).toBe(true)
    expect(await store.remove('repo', m.id)).toBe(false) // deleting twice is fine
    expect(store.list('repo')).toEqual([])
    expect(await store.restore('repo', m.id)).toEqual(m)
    expect(store.get('repo', m.id)).toEqual(m)
    expect(await store.restore('repo', m.id)).toBeNull() // nothing left in the trash
  })

  it('ignores malformed ids on delete and restore', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    expect(await store.remove('repo', '../global')).toBe(false)
    expect(await store.restore('repo', '../global')).toBeNull()
  })

  it('does not restore over a memory that took the id back', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const m = (await store.save(input())).record
    await store.remove('repo', m.id)
    const dir = join(root, 'repos', store.currentRepoKey!)
    writeFileSync(join(dir, `${m.id}.md`), readFileSync(join(root, '.trash', `repo-${store.currentRepoKey}`, `${m.id}.md`)))
    expect(await store.restore('repo', m.id)).toBeNull()
  })

  it('prunes trash older than the retention window, counted from deletion', async () => {
    let t = new Date('2026-01-01T00:00:00.000Z')
    const store = memoryStore({ root, workspace: repoDir, now: () => t })
    const old = (await store.save(input({ name: 'old' }))).record
    const recent = (await store.save(input({ name: 'recent' }))).record
    t = new Date('2026-10-01T00:00:00.000Z')
    await store.remove('repo', old.id)
    t = new Date('2026-10-30T00:00:00.000Z')
    await store.remove('repo', recent.id)
    // Not yet 30 days since either deletion.
    expect(store.pruneTrash()).toBe(0)
    t = new Date(new Date('2026-10-01T00:00:00.000Z').getTime() + MEMORY_TRASH_TTL_MS + 1000)
    expect(store.pruneTrash()).toBe(1)
    const left = readdirSync(join(root, '.trash', `repo-${store.currentRepoKey}`))
    expect(left).toEqual([`${recent.id}.md`])
  })

  it('prunes by file time even when the clock and files disagree', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    const m = (await store.save(input())).record
    await store.remove('repo', m.id)
    const file = join(root, '.trash', `repo-${store.currentRepoKey}`, `${m.id}.md`)
    const longAgo = new Date(Date.now() - MEMORY_TRASH_TTL_MS - 60_000)
    utimesSync(file, longAgo, longAgo)
    expect(store.pruneTrash()).toBe(1)
  })
})

describe('memoryStore recall usage', () => {
  it('counts recalls per id and survives a corrupt usage file', async () => {
    let t = new Date('2026-10-24T00:00:00.000Z')
    const store = memoryStore({ root, workspace: repoDir, now: () => t })
    expect(store.usage()).toEqual({})
    const m = (await store.save(input())).record
    await store.noteRecalled([m.id, 'not-an-id'])
    t = new Date('2026-10-25T00:00:00.000Z')
    await store.noteRecalled([m.id])
    expect(store.usage()).toEqual({ [m.id]: { recalls: 2, lastRecalled: '2026-10-25T00:00:00.000Z' } })
    writeFileSync(join(root, 'usage.json'), '{not json')
    expect(store.usage()).toEqual({})
    await store.noteRecalled([m.id])
    expect(store.usage()[m.id]?.recalls).toBe(1)
  })

  it('never throws when the usage file cannot be written', async () => {
    const store = memoryStore({ root, workspace: repoDir })
    mkdirSync(join(root, 'usage.json'), { recursive: true }) // a folder where the file should be
    await expect(store.noteRecalled(['m_20261024_aaaaaa'])).resolves.toBeUndefined()
  })
})

describe('defaultMemoryRoot', () => {
  it('lives under ~/.houston/memory', () => {
    expect(defaultMemoryRoot(join(tmp, 'home'))).toBe(join(tmp, 'home', '.houston', 'memory'))
  })

  it('honors HOUSTON_MEMORY_DIR when no home is given', () => {
    const before = process.env.HOUSTON_MEMORY_DIR
    try {
      process.env.HOUSTON_MEMORY_DIR = join(tmp, 'elsewhere')
      expect(defaultMemoryRoot()).toBe(join(tmp, 'elsewhere'))
      expect(defaultMemoryRoot(join(tmp, 'home'))).toBe(join(tmp, 'home', '.houston', 'memory'))
    } finally {
      process.env.HOUSTON_MEMORY_DIR = before
    }
  })
})
