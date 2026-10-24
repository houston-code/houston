import { fileKey } from './paths.mjs'
import { uriToPath } from './uri.mjs'

/**
 * Diagnostics as the server publishes them (`textDocument/publishDiagnostics`, keyed
 * by URI), looked up by the editor for the file it's showing (keyed by path).
 */
export function createDiagnosticsStore({ platform = process.platform } = {}) {
  const byFile = new Map()
  return {
    publish({ uri, diagnostics }) {
      const key = fileKey(uriToPath(uri), platform)
      if (diagnostics.length) byFile.set(key, diagnostics)
      else byFile.delete(key)
    },
    forFile(path) {
      return byFile.get(fileKey(path, platform)) ?? []
    },
    files() {
      return [...byFile.keys()].sort()
    }
  }
}
