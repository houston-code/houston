/** `file:` URIs for LSP, kept dependency-free so the tool definitions can import it. */
import { fileURLToPath, pathToFileURL } from 'node:url'

export function toUri(abs: string): string {
  return pathToFileURL(abs).href
}

/** The local path a `file:` URI names, or null for any other scheme. */
export function fromUri(uri: string): string | null {
  if (!uri.startsWith('file:')) return null
  try {
    return fileURLToPath(uri)
  } catch {
    return null
  }
}
