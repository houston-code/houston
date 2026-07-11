import { describe, it, expect } from 'vitest'
import {
  ReadCache,
  cacheKey,
  canonicalArgs,
  isCacheableRead,
  readDeps,
  writePaths,
  writeTouchesUnknownPaths,
  type CachedRead
} from './readCache'

const hit = (output: string): CachedRead => ({ output, ok: true, images: [], documents: [] })
// Simple deterministic path resolver for tests: join to a fake workspace root.
const resolve = (rel: string): string => (rel.startsWith('/') ? rel : `/w/${rel}`)

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
  it('serves a repeated identical read from the cache', () => {
    const c = new ReadCache()
    expect(c.get('read_file', { path: 'a.ts' })).toBeUndefined()
    c.set('read_file', { path: 'a.ts' }, hit('contents'), readDeps('read_file', { path: 'a.ts' }, resolve))
    expect(c.get('read_file', { path: 'a.ts' })?.output).toBe('contents')
    // An explicit undefined-valued arg keys the same as an omitted one, so it hits.
    expect(c.get('read_file', { path: 'a.ts', offset: undefined })?.output).toBe('contents')
  })

  it('misses on different args', () => {
    const c = new ReadCache()
    c.set('read_file', { path: 'a.ts' }, hit('A'), readDeps('read_file', { path: 'a.ts' }, resolve))
    expect(c.get('read_file', { path: 'b.ts' })).toBeUndefined()
    expect(c.get('read_file', { path: 'a.ts', offset: 5 })).toBeUndefined()
  })

  it('does not cache failed reads', () => {
    const c = new ReadCache()
    c.set(
      'read_file',
      { path: 'a.ts' },
      { output: 'Error: nope', ok: false, images: [], documents: [] },
      readDeps('read_file', { path: 'a.ts' }, resolve)
    )
    expect(c.get('read_file', { path: 'a.ts' })).toBeUndefined()
  })

  it('round-trips images and documents', () => {
    const c = new ReadCache()
    const result: CachedRead = {
      output: '[image attached]',
      ok: true,
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
      documents: [{ mediaType: 'application/pdf', data: 'BBBB', name: 'x.pdf' }]
    }
    c.set('read_file', { path: 'x.png' }, result, readDeps('read_file', { path: 'x.png' }, resolve))
    const got = c.get('read_file', { path: 'x.png' })
    expect(got?.images).toHaveLength(1)
    expect(got?.documents[0].name).toBe('x.pdf')
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
  it('invalidates a read of the exact written path', () => {
    const c = new ReadCache()
    c.set('read_file', { path: 'a.ts' }, hit('A'), readDeps('read_file', { path: 'a.ts' }, resolve))
    c.invalidatePaths(['/w/a.ts'])
    expect(c.get('read_file', { path: 'a.ts' })).toBeUndefined()
  })

  it('leaves an unrelated read intact', () => {
    const c = new ReadCache()
    c.set('read_file', { path: 'a.ts' }, hit('A'), readDeps('read_file', { path: 'a.ts' }, resolve))
    c.set('read_file', { path: 'b.ts' }, hit('B'), readDeps('read_file', { path: 'b.ts' }, resolve))
    c.invalidatePaths(['/w/a.ts'])
    expect(c.get('read_file', { path: 'a.ts' })).toBeUndefined()
    expect(c.get('read_file', { path: 'b.ts' })?.output).toBe('B')
  })

  it('invalidates a list_dir when a file inside it is written', () => {
    const c = new ReadCache()
    c.set('list_dir', { path: 'src' }, hit('a.ts\nb.ts'), readDeps('list_dir', { path: 'src' }, resolve))
    c.invalidatePaths(['/w/src/c.ts'])
    expect(c.get('list_dir', { path: 'src' })).toBeUndefined()
  })

  it('always invalidates tree-spanning reads on any write', () => {
    const c = new ReadCache()
    c.set('search_files', { pattern: 'foo' }, hit('hits'), readDeps('search_files', { pattern: 'foo' }, resolve))
    c.set('glob', { pattern: '**/*.ts' }, hit('files'), readDeps('glob', { pattern: '**/*.ts' }, resolve))
    // A write to a single unrelated-looking file still drops both searches.
    c.invalidatePaths(['/w/deeply/nested/other.ts'])
    expect(c.get('search_files', { pattern: 'foo' })).toBeUndefined()
    expect(c.get('glob', { pattern: '**/*.ts' })).toBeUndefined()
  })
})

describe('invalidateAll', () => {
  it('drops every entry (shell semantics)', () => {
    const c = new ReadCache()
    c.set('read_file', { path: 'a.ts' }, hit('A'), readDeps('read_file', { path: 'a.ts' }, resolve))
    c.set('list_dir', { path: 'src' }, hit('L'), readDeps('list_dir', { path: 'src' }, resolve))
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
