import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_ATTACHMENTS, type ImageAttachment } from '@shared/images'
import {
  appendComposerImages,
  indexedDbImageStore,
  loadComposerImages,
  saveComposerImages,
  setImageDraftStore,
  type ImageDraftStore
} from './composerImageDraft'

/** A Map-backed store standing in for IndexedDB (jsdom has none). */
function memoryImageStore(): ImageDraftStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    map,
    get: async (key) => map.get(key),
    put: async (key, value) => {
      map.set(key, structuredClone(value))
    },
    delete: async (key) => {
      map.delete(key)
    }
  }
}

const png: ImageAttachment = { mediaType: 'image/png', data: 'AA==' }
const jpg: ImageAttachment = { mediaType: 'image/jpeg', data: 'BB==' }
const stored: ImageAttachment = {
  mediaType: 'image/png',
  data: '',
  src: `houston-media://00000000-0000-4000-8000-000000000000/${'a'.repeat(64)}.png`
}

let store: ReturnType<typeof memoryImageStore>
beforeEach(() => {
  store = memoryImageStore()
  setImageDraftStore(store)
})
afterEach(() => setImageDraftStore(undefined))

describe('composerImageDraft', () => {
  it('reads as no images when nothing is saved', async () => {
    expect(await loadComposerImages('c1')).toEqual([])
  })

  it('round-trips a conversation’s staged images, a stored-file image included', async () => {
    await saveComposerImages('c1', [png, stored])
    expect(await loadComposerImages('c1')).toEqual([png, stored])
  })

  it('keeps each conversation’s images apart, with its own slot for the new chat', async () => {
    await saveComposerImages('c1', [png])
    await saveComposerImages(null, [jpg])
    expect(await loadComposerImages('c1')).toEqual([png])
    expect(await loadComposerImages(null)).toEqual([jpg])
    expect(await loadComposerImages('c2')).toEqual([])
  })

  it('clears the slot when saved with no images', async () => {
    await saveComposerImages('c1', [png])
    await saveComposerImages('c1', [])
    expect(store.map.has('c1')).toBe(false)
    expect(await loadComposerImages('c1')).toEqual([])
  })

  it('keeps at most a message’s worth of images, and only their own fields', async () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 3 }, () => ({ ...png, extra: 'x' }))
    await saveComposerImages('c1', many)
    const loaded = await loadComposerImages('c1')
    expect(loaded).toHaveLength(MAX_ATTACHMENTS)
    expect(loaded[0]).toEqual(png)
  })

  it('drops malformed or unsupported entries read back from storage', async () => {
    store.map.set('c1', [
      png,
      null,
      'nope',
      { mediaType: 'image/tiff', data: 'AA==' },
      { mediaType: 'image/png', data: 42 },
      { mediaType: 'image/png', data: '' },
      { mediaType: 'image/png', data: '', src: 'https://example.com/a.png' },
      stored
    ])
    expect(await loadComposerImages('c1')).toEqual([png, stored])
    store.map.set('c2', { not: 'an array' })
    expect(await loadComposerImages('c2')).toEqual([])
  })

  it('appends after the images already saved', async () => {
    await saveComposerImages('c1', [png])
    await appendComposerImages('c1', [jpg])
    expect(await loadComposerImages('c1')).toEqual([png, jpg])
    await appendComposerImages('c1', [])
    expect(await loadComposerImages('c1')).toEqual([png, jpg])
  })

  it('never throws when storage fails or is missing', async () => {
    setImageDraftStore({
      get: () => Promise.reject(new Error('gone')),
      put: () => Promise.reject(new Error('quota')),
      delete: () => Promise.reject(new Error('gone'))
    })
    await expect(saveComposerImages('c1', [png])).resolves.toBeUndefined()
    await expect(saveComposerImages('c1', [])).resolves.toBeUndefined()
    expect(await loadComposerImages('c1')).toEqual([])
    setImageDraftStore(null)
    await expect(saveComposerImages('c1', [png])).resolves.toBeUndefined()
    expect(await loadComposerImages('c1')).toEqual([])
  })

  it('has no store where the window has no IndexedDB', () => {
    expect(indexedDbImageStore(undefined)).toBeNull()
  })

  it('opens its database once and creates the store on first use', async () => {
    // A tiny synchronous-callback fake of the IndexedDB calls the store makes.
    const data = new Map<string, unknown>()
    const req = <T,>(result: T): IDBRequest<T> => {
      const r = { result, onsuccess: null, onerror: null } as unknown as IDBRequest<T>
      queueMicrotask(() => (r.onsuccess as (() => void) | null)?.call(r))
      return r
    }
    const objectStore = {
      get: (k: string) => req(data.get(k)),
      put: (v: unknown, k: string) => (data.set(k, v), req(k)),
      delete: (k: string) => (data.delete(k), req(undefined))
    }
    const createObjectStore = vi.fn()
    const db = {
      objectStoreNames: { contains: () => false },
      createObjectStore,
      transaction: () => ({ objectStore: () => objectStore })
    }
    const open = vi.fn(() => {
      const r = { result: db } as unknown as IDBOpenDBRequest
      queueMicrotask(() => {
        ;(r.onupgradeneeded as (() => void) | null)?.call(r)
        ;(r.onsuccess as (() => void) | null)?.call(r)
      })
      return r
    })
    const idbStore = indexedDbImageStore({ open } as unknown as IDBFactory)!
    await idbStore.put('c1', [png])
    expect(await idbStore.get('c1')).toEqual([png])
    await idbStore.delete('c1')
    expect(await idbStore.get('c1')).toBeUndefined()
    expect(open).toHaveBeenCalledTimes(1)
    expect(createObjectStore).toHaveBeenCalledWith('draftImages')
  })
})
