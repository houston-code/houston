import { pathToUri } from './uri.mjs'

/** The `textDocument/didOpen` notification for a file the editor opened. */
export function didOpen(path, text, languageId) {
  return {
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: pathToUri(path), languageId, version: 1, text } }
  }
}
