// eslint-disable-next-line no-restricted-imports -- host-capability gesture (Finder/Explorer reveal); not agent-engine code (only the shell's ipc.ts imports it). Belongs outside agent/; relocating it is the remaining electron-in-engine cleanup.
import { shell } from 'electron'
import { promises as fs, existsSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { OpenResult } from '@shared/editors'
import { MAX_PREVIEW_TEXT_BYTES, type FileEntry, type FilePreview } from '@shared/files'
import { imageMediaTypeForPath, MAX_ATTACH_IMAGE_BYTES } from './attachments'
import { resolveInWorkspace } from './tools'

/**
 * Backs the Finder-like "Files" panel: a lazy, one-level-at-a-time directory
 * listing of the workspace plus a reveal-in-file-manager action. Unlike the
 * `@`-mention search (which walks the whole tree to fuzzy-match a query), this
 * returns only a directory's immediate children so even a huge repo expands
 * cheaply — the renderer fetches deeper levels on demand as folders open.
 *
 * It is a *user gesture* (never an agent tool) but stays confined to the
 * workspace via {@link resolveInWorkspace}, whose realpath check also blocks a
 * committed symlink from listing or revealing anything outside the project.
 */

/**
 * The immediate children of `relPath` (relative to the workspace root; '' is the
 * root itself), folders first then files, each group case-insensitively sorted.
 * Returns [] for a missing workspace, an unreadable directory, or a path that
 * escapes the workspace. Symlinks are followed only to classify dir-vs-file.
 */
export async function listDirectory(workspace: string, relPath = ''): Promise<FileEntry[]> {
  if (!workspace) return []
  let root: string
  try {
    root = realpathSync(workspace)
  } catch {
    return []
  }
  let dir: string
  try {
    dir = relPath ? resolveInWorkspace(root, relPath) : root
  } catch {
    return [] // escapes the workspace (incl. via symlink) — refuse to list it
  }
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: FileEntry[] = []
  for (const e of entries) {
    let isDirectory = e.isDirectory()
    // A Dirent reports the *link* type, so resolve symlinks to know whether the
    // target is a directory (and thus expandable). Best-effort: a dangling or
    // out-of-tree link falls back to "file".
    if (e.isSymbolicLink()) {
      try {
        isDirectory = (await fs.stat(join(dir, e.name))).isDirectory()
      } catch {
        isDirectory = false
      }
    } else if (!isDirectory && !e.isFile()) {
      continue // skip sockets / fifos / devices
    }
    out.push({ name: e.name, path: relative(root, join(dir, e.name)).split(sep).join('/'), isDirectory })
  }
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' })
  })
  return out
}

/** Bytes sniffed from the head of a file to decide text-vs-binary (a NUL means binary). */
const BINARY_SNIFF_BYTES = 8000

/**
 * Read a workspace file for the in-app preview pane. Supported images come back
 * as an attachment the renderer can render; text is returned up to
 * {@link MAX_PREVIEW_TEXT_BYTES} (flagged `truncated` past that, read partially so
 * a huge file never loads whole); binary and over-cap files return a note kind so
 * the UI can point at "Reveal in file manager". Confined like {@link listDirectory}.
 */
export async function readWorkspaceFile(workspace: string, relPath: string): Promise<FilePreview> {
  if (!workspace || !relPath) return { kind: 'error', message: 'No file selected.' }
  let abs: string
  try {
    abs = resolveInWorkspace(realpathSync(workspace), relPath)
  } catch {
    return { kind: 'error', message: 'Path is outside the workspace.' }
  }
  let stat
  try {
    stat = await fs.stat(abs)
  } catch {
    return { kind: 'error', message: 'That file no longer exists.' }
  }
  if (stat.isDirectory()) return { kind: 'error', message: 'That path is a directory.' }
  const bytes = stat.size

  const imageType = imageMediaTypeForPath(relPath)
  if (imageType) {
    if (bytes > MAX_ATTACH_IMAGE_BYTES) return { kind: 'too-large', bytes, limit: MAX_ATTACH_IMAGE_BYTES }
    try {
      const buf = await fs.readFile(abs)
      return { kind: 'image', image: { mediaType: imageType, data: buf.toString('base64') }, bytes }
    } catch (e) {
      return { kind: 'error', message: (e as Error).message }
    }
  }

  // Text: read only up to the cap so an enormous file never loads in full.
  const toRead = Math.min(bytes, MAX_PREVIEW_TEXT_BYTES)
  let buf: Buffer
  try {
    const fh = await fs.open(abs, 'r')
    try {
      buf = Buffer.alloc(toRead)
      const { bytesRead } = await fh.read(buf, 0, toRead, 0)
      buf = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  } catch (e) {
    return { kind: 'error', message: (e as Error).message }
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: 'binary', bytes }
  return { kind: 'text', text: buf.toString('utf8'), truncated: bytes > MAX_PREVIEW_TEXT_BYTES, bytes }
}

/** Reveal a workspace-relative path in the OS file manager (Finder / Explorer). */
export function revealWorkspacePath(workspace: string, relPath: string): OpenResult {
  if (!workspace || !relPath) return { ok: false, error: 'No file to reveal.' }
  let abs: string
  try {
    abs = resolveInWorkspace(realpathSync(workspace), relPath)
  } catch {
    return { ok: false, error: 'Path is outside the workspace.' }
  }
  if (!existsSync(abs)) return { ok: false, error: 'That file no longer exists.' }
  shell.showItemInFolder(abs)
  return { ok: true }
}
