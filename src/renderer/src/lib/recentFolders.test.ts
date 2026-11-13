import { describe, expect, it } from 'vitest'
import { dragHasFiles, droppedPaths, recentFolders } from './recentFolders'

describe('recentFolders', () => {
  it('lists newest first with the folder name and a short location', () => {
    expect(recentFolders(['/home/me/code/app', '/home/me/code/site'], null)).toEqual([
      { path: '/home/me/code/app', name: 'app', where: '…/me/code/app' },
      { path: '/home/me/code/site', name: 'site', where: '…/me/code/site' }
    ])
  })

  it('leaves out the open folder, duplicates and empty entries', () => {
    const got = recentFolders(['/a/one', '', '/a/two', '/a/one', '/a/three'], '/a/two')
    expect(got.map((r) => r.path)).toEqual(['/a/one', '/a/three'])
  })

  it('caps the list', () => {
    const many = Array.from({ length: 9 }, (_, i) => `/p/f${i}`)
    expect(recentFolders(many, null)).toHaveLength(5)
    expect(recentFolders(many, null, 2).map((r) => r.name)).toEqual(['f0', 'f1'])
  })

  it('handles missing recents and Windows paths', () => {
    expect(recentFolders(undefined, null)).toEqual([])
    expect(recentFolders(['C:\\Users\\me\\proj'], null)[0].name).toBe('proj')
  })
})

describe('droppedPaths', () => {
  it('keeps only items that have a file-system path', () => {
    const a = new File([''], 'a')
    const b = new File([''], 'b')
    const paths = new Map([[a, '/x/a']])
    expect(droppedPaths([a, b], (f) => paths.get(f) ?? '')).toEqual(['/x/a'])
  })
})

describe('dragHasFiles', () => {
  it('is true only for drags that carry files', () => {
    expect(dragHasFiles(['Files'])).toBe(true)
    expect(dragHasFiles(['text/plain'])).toBe(false)
    expect(dragHasFiles(undefined)).toBe(false)
  })
})
