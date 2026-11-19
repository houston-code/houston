/**
 * The composer's unsent image attachments, persisted per conversation so an image
 * staged in a chat survives a chat switch and an app restart, the same as the
 * draft's text and context chips (see composerDraft.ts).
 *
 * Images live in IndexedDB rather than localStorage: a draft can hold several
 * multi-megabyte images, far past localStorage's few-MB quota, while IndexedDB is
 * sized for it. Like localStorage it is renderer-only and persists across restarts.
 * Every call is async and never throws: storage that is missing or refuses a write
 * just means the images won't survive, which is not worth surfacing.
 *
 * Drafts are keyed like the text draft: one slot per conversation, plus one for the
 * not-yet-created "new chat" composer.
 */

import {
  MAX_ATTACHMENTS,
  exceedsImageSizeLimit,
  isSupportedImageType,
  parseMediaUrl,
  type ImageAttachment
} from '@shared/images'

/** The minimal key/value store the image drafts are kept in. */
export interface ImageDraftStore {
  get(key: string): Promise<unknown>
  put(key: string, value: ImageAttachment[]): Promise<void>
  delete(key: string): Promise<void>
}

const DB_NAME = 'houston-composer'
const DB_VERSION = 1
const STORE = 'draftImages'

function keyFor(conversationId: string | null): string {
  return conversationId ?? 'new'
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** An {@link ImageDraftStore} over the window's IndexedDB, or null where there is none. */
export function indexedDbImageStore(idb: IDBFactory | undefined = globalThis.indexedDB): ImageDraftStore | null {
  if (!idb) return null
  let db: Promise<IDBDatabase> | null = null
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }).catch((err: unknown) => {
      db = null // let a later call try again
      throw err
    })
    return db
  }
  // Transactions on one store complete in the order they were created, so a save
  // followed by a clear of the same draft always lands as the clear.
  const tx = async (mode: IDBTransactionMode): Promise<IDBObjectStore> =>
    (await open()).transaction(STORE, mode).objectStore(STORE)
  return {
    get: async (key) => request((await tx('readonly')).get(key)),
    put: async (key, value) => {
      await request((await tx('readwrite')).put(value, key))
    },
    delete: async (key) => {
      await request((await tx('readwrite')).delete(key))
    }
  }
}

let store: ImageDraftStore | null | undefined

function currentStore(): ImageDraftStore | null {
  if (store === undefined) {
    try {
      store = indexedDbImageStore()
    } catch {
      store = null
    }
  }
  return store
}

/** Swap the backing store (tests); `undefined` goes back to the window's IndexedDB. */
export function setImageDraftStore(next: ImageDraftStore | null | undefined): void {
  store = next
}

function isImageAttachment(v: unknown): v is ImageAttachment {
  if (!v || typeof v !== 'object') return false
  const a = v as Record<string, unknown>
  if (typeof a.mediaType !== 'string' || !isSupportedImageType(a.mediaType)) return false
  if (typeof a.data !== 'string' || exceedsImageSizeLimit(a.data)) return false
  if (a.src === undefined) return a.data.length > 0
  return parseMediaUrl(a.src) !== null
}

/** Only the fields an attachment has, so nothing extra is written or restored. */
function clean(a: ImageAttachment): ImageAttachment {
  return a.src === undefined
    ? { mediaType: a.mediaType, data: a.data }
    : { mediaType: a.mediaType, data: a.data, src: a.src }
}

/** Load a conversation's saved images; absent, unavailable or malformed storage reads as none. */
export async function loadComposerImages(conversationId: string | null): Promise<ImageAttachment[]> {
  const s = currentStore()
  if (!s) return []
  try {
    const raw = await s.get(keyFor(conversationId))
    if (!Array.isArray(raw)) return []
    return raw.filter(isImageAttachment).slice(0, MAX_ATTACHMENTS).map(clean)
  } catch {
    return []
  }
}

/** Persist a conversation's staged images, or clear the slot when there are none. */
export async function saveComposerImages(
  conversationId: string | null,
  images: readonly ImageAttachment[]
): Promise<void> {
  const s = currentStore()
  if (!s) return
  const key = keyFor(conversationId)
  try {
    if (images.length === 0) await s.delete(key)
    else await s.put(key, images.slice(0, MAX_ATTACHMENTS).map(clean))
  } catch {
    // Quota or storage unavailable: the images just won't survive.
  }
}

/** Add images after any already saved for a conversation (up to the per-message cap). */
export async function appendComposerImages(
  conversationId: string | null,
  images: readonly ImageAttachment[]
): Promise<void> {
  if (images.length === 0) return
  const saved = await loadComposerImages(conversationId)
  await saveComposerImages(conversationId, [...saved, ...images])
}
