/**
 * file:// URIs <-> filesystem paths, for the language-server client. Servers speak
 * URIs, the editor speaks paths, and both have to agree on one key per file.
 */
export function uriToPath(uri) {
  if (!uri.startsWith('file://')) throw new Error(`not a file URI: ${uri}`)
  return decodeURIComponent(new URL(uri).pathname)
}

export function pathToUri(path) {
  return 'file://' + encodeURI(path)
}
