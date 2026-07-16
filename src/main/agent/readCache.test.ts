import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as realFs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ReadCache,
  cacheKey,
  canonicalArgs,
  isCacheableRead,
  readDeps,
  statPath,
  writePaths,
  writeTouchesUnknownPaths,
  type CachedRead,
  type PathStamp,
  type StatPath
} from './readCache'

/** Mirror of the cache's internal freshness comparison, for asserting on stamps. */
const sameFile = (a: PathStamp, b: PathStamp): boolean =>
  a === null || b === null ? a === b : a.mtimeMs === b.mtimeMs && a.size === b.size

const hit = (output: string): CachedRead => ({ output, ok: true, images: [], documents: [] })
// Simple deterministic path resolver for tests: join to a fake workspace root.
const resolve = (rel: string): string => (rel.startsWith('/') ? rel : `/w/${rel}`)

/**
 * A stat-able fake filesystem keyed by canonical absolute path. Mutating it stands
 * in for the writers the cache can't see (the user's editor, a git checkout) — the
 * cache is only handed the {@link StatPath}, exactly as the loop hands it the real
 * one, so these tests exercise revalidation without touching disk.
 */
function fakeFs(initial: Record<string, string> = {}): {
  stat: StatPath
  write: (abs: string, content: string) => void
  writeKeepingMtime: (abs: string, content: string) => void
  remove: (abs: string) => void
} {
  const files = new Map(Object.entries(initial))
  const mtimes = new Map([...files.keys()].map((k) => [k, 1000]))
  let clock = 1000
  return {
    stat: async (abs) => {
      const content = files.get(abs)
      return content === undefined ? null : { mtimeMs: mtimes.get(abs) as number, size: content.length }
    },
    write(abs, content) {
      clock += 1
      files.set(abs, content)
      mtimes.set(abs, clock)
    },
    // Models a filesystem whose mtime resolution is too coarse to register the edit.
    writeKeepingMtime(abs, content) {
      files.set(abs, content)
    },
    remove(abs) {
      files.delete(abs)
      mtimes.delete(abs)
    }
  }
}

describe('canonicalArgs / cacheKey', () => {
  it('is order-independent for object keys', () => {
    expect(canonicalArgs({ a: 1, b: 2 })).toBe(canonicalArgs({ b: 2, a: 1 }))
    expect(cacheKey('read_file', { a: 1, b: 2 })).toBe(cacheKey('read_file', { b: 2, a: 1 }))
  })

  it('sorts nested object keys but preserves array order', () => {
    expect(canonicalArgs({ x: { p: 1, q: 2 } })).toBe(canonicalArgs({ x: { q: 2, p: 1 } }))
    expect(canonicalArgs({ xs: [1, 2] })).not.toBe(canonicalArgs({ xs: [2, 1] }))
  })

  it('distinguishes different tools with the same args', () => {
    expect(cacheKey('read_file', { path: 'a' })).not.toBe(cacheKey('list_dir', { path: 'a' }))
  })

  it('keys an explicit undefined-valued arg the same as an omitted one', () => {
    // {a:1} and {a:1,b:undefined} are the same call — an absent optional arg and one
    // passed as undefined must not split into two cache entries (and lose the hit).
    expect(canonicalArgs({ a: 1 })).toBe(canonicalArgs({ a: 1, b: undefined }))
    expect(cacheKey('read_file', { path: 'a.ts' })).toBe(
      cacheKey('read_file', { path: 'a.ts', offset: undefined })
    )
    // A defined value still differs from the omitted/undefined form.
    expect(canonicalArgs({ a: 1, b: 2 })).not.toBe(canonicalArgs({ a: 1 }))
  })
})

describe('isCacheableRead', () => {
  it('caches the pure on-disk reads on the allowlist', () => {
    for (const name of ['read_file', 'list_dir', 'search_files', 'glob', 'ast_grep']) {
      expect(isCacheableRead(name, 'read')).toBe(true)
    }
  })

  it('never caches non-read kinds', () => {
    expect(isCacheableRead('write_file', 'write')).toBe(false)
    expect(isCacheableRead('run_shell', 'shell')).toBe(false)
    expect(isCacheableRead('fetch_url', 'network')).toBe(false)
    expect(isCacheableRead('some_mcp_tool', 'mcp')).toBe(false)
  })

  it('never caches ask_user despite its read kind', () => {
    expect(isCacheableRead('ask_user', 'read')).toBe(false)
  })

  // The whole point of the allowlist: `read` kind means "no approval needed", NOT
  // "side-effect-free". These read-kind tools are stateful or non-deterministic and
  // caching them would replay a stale result — a cursor-poll that never advances, a
  // subagent that never re-runs, or external/session state the cache can't invalidate.
  it('never caches stateful or non-deterministic read-kind tools', () => {
    for (const name of [
      'read_shell_output', // cursor-advancing poll — replaying its chunk hangs a polling loop
      'kill_shell',
      'dispatch_agent', // non-deterministic subagent
      'review_changes', // non-deterministic subagent
      'pr_sweep',
      'git_status',
      'git_diff',
      'todo_write',
      'recall_history'
    ]) {
      expect(isCacheableRead(name, 'read')).toBe(false)
    }
  })

  it('never caches an unknown read-kind tool (allowlist is closed)', () => {
    expect(isCacheableRead('some_future_read_tool', 'read')).toBe(false)
  })
})

describe('ReadCache get/set', () => {
  it('serves a repeated identical read from the cache', async () => {
    const fs = fakeFs({ '/w/a.ts': 'contents' })
    const c = new ReadCache({ stat: fs.stat })
    expect(await c.get('read_file', { path: 'a.ts' })).toBeUndefined()
    await c.set('read_file', { path: 'a.ts' }, hit('contents'), readDeps('read_file', { path: 'a.ts' }, resolve))
    expect((await c.get('read_file', { path: 'a.ts' }))?.output).toBe('contents')
    // An explicit undefined-valued arg keys the same as an omitted one, so it hits.
    expect((await c.get('read_file', { path: 'a.ts', offset: undefined }))?.output).toBe('contents')
  })

  it('misses on different args', async () => {
    const fs = fakeFs({ '/w/a.ts': 'A' })
    const c = new ReadCache({ stat: fs.stat })
    await c.set('read_file', { path: 'a.ts' }, hit('A'), readDeps('read_file', { path: 'a.ts' }, resolve))
    expect(await c.get('read_file', { path: 'b.ts' })).toBeUndefined()
    expect(await c.get('read_file', { path: 'a.ts', offset: 5 })).toBeUndefined()
  })

  it('does not cache failed reads', async () => {
    const fs = fakeFs()
    const c = new ReadCache({ stat: fs.stat })
    await c.set(
      'read_file',
      { path: 'a.ts' },
      { output: 'Error: nope', ok: false, images: [], documents: [] },
      readDeps('read_file', { path: 'a.ts' }, resolve)
    )
    expect(await c.get('read_file', { path: 'a.ts' })).toBeUndefined()
  })

  it('round-trips images and documents', async () => {
    const fs = fakeFs({ '/w/x.png': 'PNGBYTES' })
    const c = new ReadCache({ stat: fs.stat })
    const result: CachedRead = {
      output: '[image attached]',
      ok: true,
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
      documents: [{ mediaType: 'application/pdf', data: 'BBBB', name: 'x.pdf' }]
    }
    await c.set('read_file', { path: 'x.png' }, result, readDeps('read_file', { path: 'x.png' }, resolve))
    const got = await c.get('read_file', { path: 'x.png' })
    expect(got?.images).toHaveLength(1)
    expect(got?.documents[0].name).toBe('x.pdf')
  })
})

describe('ReadCache staleness revalidation', () => {
  it('re-reads a file edited on disk by someone other than the agent', async () => {
    // The whole point: no write tool ran, so nothing called invalidatePaths. The
    // user edited the file in their editor mid-run.
    const fs = fakeFs({ '/w/a.ts': 'before' })
    const c = new ReadCache({ stat: fs.stat })
    await c.set('read_file', { path: 'a.ts' }, hit('before'), readDeps('read_file', { path: 'a.ts' }, resolve))
    expect((await c.get('read_file', { path: 'a.ts' }))?.output).toBe('before')

    fs.write('/w/a.ts', 'after the user edited it')
    expect(await c.get('read_file', { path: 'a.ts' })).toBeUndefined()
  })

  it('catches a same-size edit via mtime, and a same-mtime edit via size', async () => {
    const fs = fakeFs({ '/w/a.ts': 'aaa' })
    const c = new ReadCache({ stat: fs.stat })
    await c.set('read_file', { path: 'a.ts' }, hit('aaa'), readDeps('read_file', { path: 'a.ts' }, resolve))
    fs.write('/w/a.ts', 'bbb') // same size, bumped mtime
    expect(await c.get('read_file', { path: 'a.ts' })).toBeUndefined()

    await c.set('read_file', { path: 'a.ts' }, hit('bbb'), readDeps('read_file', { path: 'a.ts' }, resolve))
    fs.writeKeepingMtime('/w/a.ts', 'bbbb') // coarse-mtime filesystem; size still moved
    expect(await c.get('read_file', { path: 'a.ts' })).toBeUndefined()
  })

  it('drops a stale entry rather than re-checking it on every later get', async () => {
    const fs = fakeFs({ '/w/a.ts': 'A' })
    const c = new ReadCache({ stat: fs.stat })
    await c.set('read_file', { path: 'a.ts' }, hit('A'), readDeps('read_file', { path: 'a.ts' }, resolve))
    fs.write('/w/a.ts', 'B')
    await c.get('read_file', { path: 'a.ts' })
    expect(c.size).toBe(0)
  })

  it('treats a file deleted, then recreated identically, as fresh and stale respectively', async () => {
    const fs = fakeFs({ '/w/a.ts': 'A' })
    const c = new ReadCache({ stat: fs.stat })
    await c.set('read_file', { path: 'a.ts' }, hit('A'), readDeps('read_file', { path: 'a.ts' }, resolve))
    fs.remove('/w/a.ts')
    expect(await c.get('read_file', { path: 'a.ts' })).toBeUndefined()
  })

  it('invalidates a list_dir when the directory itself changes on disk', async () => {
    const fs = fakeFs({ '/w/src': 'a.ts\nb.ts' })
    const c = new ReadCache({ stat: fs.stat })
    await c.set('list_dir', { path: 'src' }, hit('a.ts\nb.ts'), readDeps('list_dir', { path: 'src' }, resolve))
    expect((await c.get('list_dir', { path: 'src' }))?.output).toBe('a.ts\nb.ts')
    // An entry added/removed outside the agent bumps the directory's own mtime.
    fs.write('/w/src', 'a.ts\nb.ts\nc.ts')
    expect(await c.get('list_dir', { path: 'src' })).toBeUndefined()
  })

  it('serves an unchanged file indefinitely — revalidation must not cost the hit', async () => {
    const fs = fakeFs({ '/w/a.ts': 'A' })
    const c = new ReadCache({ stat: fs.stat, now: () => 0 })
    await c.set('read_file', { path: 'a.ts' }, hit('A'), readDeps('read_file', { path: 'a.ts' }, resolve))
    for (let i = 0; i < 5; i += 1) {
      expect((await c.get('read_file', { path: 'a.ts' }))?.output).toBe('A')
    }
  })

  it('expires a tree-spanning read once its staleness window passes', async () => {
    // A search can't be revalidated by stat — it depends on files that did not
    // match — so it gets a bounded window instead of an exact check.
    const fs = fakeFs()
    let clock = 0
    const c = new ReadCache({ stat: fs.stat, now: () => clock, treeTtlMs: 1000 })
    const deps = readDeps('search_files', { pattern: 'foo' }, resolve)
    await c.set('search_files', { pattern: 'foo' }, hit('hits'), deps)

    clock = 999
    expect((await c.get('search_files', { pattern: 'foo' }))?.output).toBe('hits')
    clock = 1000
    expect(await c.get('search_files', { pattern: 'foo' })).toBeUndefined()
  })
})

describe('statPath', () => {
  // The fake filesystem above proves the revalidation logic; this proves the real
  // stamper the loop actually injects agrees with it against a real disk.
  let dir: string
  beforeEach(async () => {
    dir = await realFs.mkdtemp(join(tmpdir(), 'houston-readcache-'))
  })
  afterEach(async () => {
    await realFs.rm(dir, { recursive: true, force: true })
  })

  it('stamps a real file and registers an edit to it', async () => {
    const file = join(dir, 'a.ts')
    await realFs.writeFile(file, 'before', 'utf8')
    const first = await statPath(file)
    expect(first).not.toBeNull()
    expect(first?.size).toBe(6)

    // Differ in length as well as content: a rewrite this fast can land inside one
    // mtime tick, and this test is about the stamp changing at all, not about which
    // of the two fields caught it.
    await realFs.writeFile(file, 'after!!', 'utf8')
    const second = await statPath(file)
    expect(second?.size).toBe(7)
    expect(sameFile(first, second)).toBe(false)
  })

  it('stamps a missing path as null, and a directory as present', async () => {
    expect(await statPath(join(dir, 'nope.ts'))).toBeNull()
    expect(await statPath(dir)).not.toBeNull()
  })

  it('round-trips through the cache: a real external edit forces a re-read', async () => {
    const file = join(dir, 'a.ts')
    await realFs.writeFile(file, 'before', 'utf8')
    const c = new ReadCache({ stat: statPath })
    const deps = { paths: [file], wholeTree: false }
    await c.set('read_file', { path: file }, hit('before'), deps)
    expect((await c.get('read_file', { path: file }))?.output).toBe('before')

    await realFs.writeFile(file, 'edited by the user', 'utf8')
    expect(await c.get('read_file', { path: file })).toBeUndefined()
  })
})

describe('readDeps', () => {
  it('scopes read_file/list_dir to the resolved path', () => {
    expect(readDeps('read_file', { path: 'src/a.ts' }, resolve)).toEqual({
      paths: ['/w/src/a.ts'],
      wholeTree: false
    })
    expect(readDeps('list_dir', { path: 'src' }, resolve)).toEqual({
      paths: ['/w/src'],
      wholeTree: false
    })
  })

  it('treats tree-spanning searches as whole-tree', () => {
    expect(readDeps('search_files', { pattern: 'foo' }, resolve).wholeTree).toBe(true)
    expect(readDeps('glob', { pattern: '**/*.ts' }, resolve).wholeTree).toBe(true)
    expect(readDeps('ast_grep', { pattern: 'f($A)', lang: 'ts' }, resolve).wholeTree).toBe(true)
  })

  it('treats a root/empty path as whole-tree', () => {
    expect(readDeps('list_dir', {}, resolve).wholeTree).toBe(true)
    expect(readDeps('list_dir', { path: '.' }, resolve).wholeTree).toBe(true)
  })

  it('falls back to whole-tree when the path cannot be resolved', () => {
    const throwing = (): string => {
      throw new Error('escapes roots')
    }
    expect(readDeps('read_file', { path: '../etc/passwd' }, throwing).wholeTree).toBe(true)
  })
})

describe('invalidatePaths', () => {
  it('invalidates a read of the exact written path', async () => {
    const c = new ReadCache({ stat: fakeFs({ '/w/a.ts': 'A' }).stat })
    await c.set('read_file', { path: 'a.ts' }, hit('A'), readDeps('read_file', { path: 'a.ts' }, resolve))
    c.invalidatePaths(['/w/a.ts'])
    expect(await c.get('read_file', { path: 'a.ts' })).toBeUndefined()
  })

  it('leaves an unrelated read intact', async () => {
    const c = new ReadCache({ stat: fakeFs({ '/w/a.ts': 'A', '/w/b.ts': 'B' }).stat })
    await c.set('read_file', { path: 'a.ts' }, hit('A'), readDeps('read_file', { path: 'a.ts' }, resolve))
    await c.set('read_file', { path: 'b.ts' }, hit('B'), readDeps('read_file', { path: 'b.ts' }, resolve))
    c.invalidatePaths(['/w/a.ts'])
    expect(await c.get('read_file', { path: 'a.ts' })).toBeUndefined()
    expect((await c.get('read_file', { path: 'b.ts' }))?.output).toBe('B')
  })

  it('invalidates a list_dir when a file inside it is written', async () => {
    const c = new ReadCache({ stat: fakeFs({ '/w/src': 'a.ts\nb.ts' }).stat })
    await c.set('list_dir', { path: 'src' }, hit('a.ts\nb.ts'), readDeps('list_dir', { path: 'src' }, resolve))
    c.invalidatePaths(['/w/src/c.ts'])
    expect(await c.get('list_dir', { path: 'src' })).toBeUndefined()
  })

  it('always invalidates tree-spanning reads on any write', async () => {
    const c = new ReadCache({ stat: fakeFs().stat })
    await c.set('search_files', { pattern: 'foo' }, hit('hits'), readDeps('search_files', { pattern: 'foo' }, resolve))
    await c.set('glob', { pattern: '**/*.ts' }, hit('files'), readDeps('glob', { pattern: '**/*.ts' }, resolve))
    // A write to a single unrelated-looking file still drops both searches.
    c.invalidatePaths(['/w/deeply/nested/other.ts'])
    expect(await c.get('search_files', { pattern: 'foo' })).toBeUndefined()
    expect(await c.get('glob', { pattern: '**/*.ts' })).toBeUndefined()
  })
})

describe('invalidateAll', () => {
  it('drops every entry (shell semantics)', async () => {
    const c = new ReadCache({ stat: fakeFs({ '/w/a.ts': 'A', '/w/src': 'L' }).stat })
    await c.set('read_file', { path: 'a.ts' }, hit('A'), readDeps('read_file', { path: 'a.ts' }, resolve))
    await c.set('list_dir', { path: 'src' }, hit('L'), readDeps('list_dir', { path: 'src' }, resolve))
    expect(c.size).toBe(2)
    c.invalidateAll()
    expect(c.size).toBe(0)
  })
})

describe('writePaths / writeTouchesUnknownPaths', () => {
  const patchPaths = (patch: string): string[] => (patch === 'MULTI' ? ['x.ts', 'y.ts'] : [])

  it('extracts the path from single-file write tools', () => {
    expect(writePaths('write_file', { path: 'a.ts', content: 'x' }, resolve, patchPaths)).toEqual([
      '/w/a.ts'
    ])
    expect(writePaths('edit_file', { path: 'b.ts' }, resolve, patchPaths)).toEqual(['/w/b.ts'])
  })

  it('extracts multiple paths from apply_patch', () => {
    const got = writePaths('apply_patch', { patch: 'MULTI' }, resolve, patchPaths)
    expect(got).toEqual(['/w/x.ts', '/w/y.ts'])
  })

  it('flags an unresolvable write for broad invalidation', () => {
    const throwing = (): string => {
      throw new Error('escapes')
    }
    const got = writePaths('write_file', { path: '../evil' }, throwing, patchPaths)
    expect(got).toEqual([])
    expect(writeTouchesUnknownPaths(got)).toBe(true)
  })

  it('flags a malformed apply_patch (no paths) for broad invalidation', () => {
    const got = writePaths('apply_patch', { patch: 'garbage' }, resolve, patchPaths)
    expect(writeTouchesUnknownPaths(got)).toBe(true)
  })
})
