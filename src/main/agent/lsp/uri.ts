/** `file:` URIs for LSP, kept dependency-free so the tool definitions can import it. */
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * A Windows path with its drive letter uppercased (`c:\w\a.ts` to `C:\w\a.ts`); any
 * other path as given. Servers spell the drive either way (many send
 * `file:///c%3A/...`), and a document's URI is the key its diagnostics are filed and
 * looked up under, so one file must have one spelling whichever case produced it.
 */
export function canonicalDrive(path: string): string {
  return /^[a-z]:/.test(path) ? `${path[0].toUpperCase()}${path.slice(1)}` : path
}

export function toUri(abs: string): string {
  return pathToFileURL(canonicalDrive(abs)).href
}

/** The local path a `file:` URI names, or null for any other scheme. */
export function fromUri(uri: string): string | null {
  if (!uri.startsWith('file:')) return null
  try {
    return canonicalDrive(fileURLToPath(uri))
  } catch {
    return null
  }
}
