/**
 * Shared types for the Finder-like Files panel: a lazily-expanded, one-level
 * directory listing of the workspace plus an in-app preview of a selected file.
 * Lives in `@shared` so the main process (which produces the data), the preload
 * bridge, and the renderer agree on the shape.
 */
import type { ImageAttachment } from './images'

/** One row in the file browser — a file or directory directly inside its parent. */
export interface FileEntry {
  name: string
  /** Path relative to the workspace root, POSIX-separated, for stable keys + reveal. */
  path: string
  isDirectory: boolean
}

/** Max bytes of a text file the in-app preview reads (a viewer cap, not the agent's). */
export const MAX_PREVIEW_TEXT_BYTES = 512 * 1024

/**
 * The result of previewing a workspace file in-app. Text is shown in a code
 * pane (truncated past the cap), supported images are rendered, and everything
 * else falls back to a note pointing at "Reveal in file manager".
 */
export type FilePreview =
  | { kind: 'text'; text: string; truncated: boolean; bytes: number }
  | { kind: 'image'; image: ImageAttachment; bytes: number }
  | { kind: 'binary'; bytes: number }
  | { kind: 'too-large'; bytes: number; limit: number }
  | { kind: 'error'; message: string }

/** Human-readable byte size, e.g. "12.3 KB" / "1.4 MB". */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
