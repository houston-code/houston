import { baseName, shortenPath } from './paths'

/** One recent project folder as the welcome screen and the folder menu list it. */
export interface RecentFolder {
  path: string
  /** The folder's own name. */
  name: string
  /** Where it lives, shortened, to tell two folders with the same name apart. */
  where: string
}

/** How many recent folders the welcome screen and the folder menu show. */
export const RECENT_FOLDER_LIMIT = 5

/**
 * The recent folders worth offering: newest first, without the folder already open
 * (offering it would only restart the same chat), without duplicates, capped.
 */
export function recentFolders(
  recents: readonly string[] | undefined,
  current: string | null,
  limit = RECENT_FOLDER_LIMIT
): RecentFolder[] {
  const seen = new Set<string>()
  const out: RecentFolder[] = []
  for (const path of recents ?? []) {
    if (!path || path === current || seen.has(path)) continue
    seen.add(path)
    out.push({ path, name: baseName(path), where: shortenPath(path, 3) })
    if (out.length >= limit) break
  }
  return out
}

/**
 * The folder paths a drop carried, in order. Only real files have a path (text or a
 * link dragged from a page has none), and `pathFor` reads it through the preload,
 * since the renderer no longer sees `File.path`. Main decides which is a folder.
 */
export function droppedPaths(files: ArrayLike<File>, pathFor: (f: File) => string): string[] {
  const out: string[] = []
  for (let i = 0; i < files.length; i++) {
    const p = pathFor(files[i])
    if (p) out.push(p)
  }
  return out
}

/** Whether a drag carries files (as opposed to text, a link, or a sidebar row). */
export function dragHasFiles(types: readonly string[] | DOMStringList | undefined): boolean {
  if (!types) return false
  return Array.from(types as ArrayLike<string>).includes('Files')
}
