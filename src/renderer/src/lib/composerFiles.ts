import { looksBinary, MAX_FILE_TEXT_BYTES, type PickedFile } from '@shared/composerContext'

/** A paste at least this many lines long collapses into a chip. */
export const LARGE_PASTE_LINES = 40
/** ...as does one at least this many characters long. */
export const LARGE_PASTE_CHARS = 4000

/** Whether pasted text is large enough to collapse into a chip instead of the field. */
export function isLargePaste(text: string): boolean {
  if (text.length >= LARGE_PASTE_CHARS) return true
  let lines = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines >= LARGE_PASTE_LINES) return true
  }
  return false
}

/** A collapsed paste's chip detail: its line count. */
export function pasteDetail(text: string): string {
  const lines = text.split('\n').length
  return `${lines} line${lines === 1 ? '' : 's'}`
}

/**
 * Read a file dropped on the composer the way "+ Attach files" reads a picked one
 * (main's readPickedFile): its first MAX_FILE_TEXT_BYTES as UTF-8 text, or, for a
 * binary file (a PDF, an archive) or one that can't be read, a marker so only its
 * name is sent. Read in the renderer from the dropped File, so no path is needed.
 */
export async function readDroppedFile(file: File): Promise<PickedFile> {
  const base = { path: file.name, name: file.name, bytes: file.size }
  try {
    const head = new Uint8Array(await file.slice(0, MAX_FILE_TEXT_BYTES).arrayBuffer())
    if (looksBinary(head)) return { ...base, content: null, truncated: false, binary: true }
    return {
      ...base,
      content: new TextDecoder('utf-8').decode(head),
      truncated: file.size > MAX_FILE_TEXT_BYTES,
      binary: false
    }
  } catch {
    return { ...base, content: null, truncated: false, binary: false }
  }
}
