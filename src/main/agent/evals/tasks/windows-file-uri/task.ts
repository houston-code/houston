import { callTool, say, turn, type EvalTask } from '../../types'

const URI_MJS = `/**
 * file:// URIs <-> filesystem paths, for the language-server client. Servers speak
 * URIs, the editor speaks paths, and both have to agree on one key per file.
 * \`platform\` is a parameter so Windows behaviour can be tested anywhere.
 */

/** "c:\\\\x" -> "C:\\\\x": Windows drive letters are case-insensitive, keys are not. */
export function canonicalDrive(path) {
  return path.replace(/^([a-z]):/, (_, d) => \`\${d.toUpperCase()}:\`)
}

export function uriToPath(uri, platform = process.platform) {
  const url = new URL(uri)
  if (url.protocol !== 'file:') throw new Error(\`not a file URI: \${uri}\`)
  const path = decodeURIComponent(url.pathname)
  if (platform !== 'win32') return path
  // "/c:/Users/x" (the colon may arrive escaped as %3A) -> "C:\\\\Users\\\\x"
  return canonicalDrive(path.replace(/^\\/(?=[A-Za-z]:)/, '').replace(/\\//g, '\\\\'))
}

export function pathToUri(path, platform = process.platform) {
  if (platform !== 'win32') return 'file://' + path.split('/').map(encodeURIComponent).join('/')
  const segments = canonicalDrive(path).split(/[\\\\/]/)
  const drive = /^[A-Z]:$/.test(segments[0]) ? segments.shift() : null
  const rest = segments.map(encodeURIComponent).join('/')
  return drive ? \`file:///\${drive}/\${rest}\` : \`file:///\${rest}\`
}
`

/**
 * From Houston PR #452: on Windows, language servers send `file:///c%3A/...` while
 * Houston keyed files as `C:\...`, so diagnostics never matched the open file. The
 * symptom is an empty panel; the fix is in URI decoding (escaped colon, leading
 * slash, separators) and in the store's key (drive-letter case). The visible test is
 * the one spelling from the report. The holdout publishes and looks up the same file
 * spelled the other ways servers and editors spell it, which `lsp/uri.mjs` says must
 * agree on one key, so decoding just the reported URI correctly is not enough. It also
 * checks the prompt's second report, which the visible test doesn't reproduce:
 * `pathToUri` uses `encodeURI`, which leaves `#` and `%` bare on every platform.
 */
export const task: EvalTask = {
  id: 'windows-file-uri',
  title: 'Match language-server diagnostics to files on Windows',
  prompt:
    "On Windows, the problems panel stays empty: the language server is running and publishing diagnostics, but none of them show up for the open file. macOS and Linux are fine there. Separately, on every platform, files with `#` or `%` in their names never get any diagnostics. `node test.mjs` reproduces the Windows report (the platform is a parameter, so it runs anywhere). Fix it. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  // The other spellings of the same file (drive case, separators, an escaped colon), and
  // the `#`/`%` names the prompt reports separately.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c2', 'read_file', { path: 'lsp/uri.mjs' }),
      callTool('c3', 'read_file', { path: 'lsp/paths.mjs' }),
      callTool('c4', 'read_file', { path: 'lsp/diagnostics.mjs' }),
      callTool('c5', 'read_file', { path: 'lsp/client.mjs' })
    ),
    turn(
      callTool('c6', 'write_file', { path: 'lsp/uri.mjs', content: URI_MJS }),
      callTool('c7', 'multi_edit', {
        path: 'lsp/paths.mjs',
        edits: [
          {
            old_string: '/**\n * The key a file',
            new_string: "import { canonicalDrive } from './uri.mjs'\n\n/**\n * The key a file"
          },
          {
            old_string: "  return path.replace(/\\//g, '\\\\')",
            new_string: "  return canonicalDrive(path.replace(/\\//g, '\\\\'))"
          }
        ]
      }),
      callTool('c8', 'edit_file', {
        path: 'lsp/diagnostics.mjs',
        old_string: '      const key = fileKey(uriToPath(uri), platform)',
        new_string: '      const key = fileKey(uriToPath(uri, platform), platform)'
      }),
      callTool('c9', 'multi_edit', {
        path: 'lsp/client.mjs',
        edits: [
          {
            old_string: 'export function didOpen(path, text, languageId) {',
            new_string: 'export function didOpen(path, text, languageId, platform = process.platform) {'
          },
          { old_string: 'uri: pathToUri(path),', new_string: 'uri: pathToUri(path, platform),' }
        ]
      })
    ),
    turn(callTool('c10', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        "The URI helpers ignored the platform: `file:///c%3A/Users/...` decoded to `/c:/Users/...` and never matched the editor's `C:\\Users\\...`, and the store treated `c:` and `C:` as different files. Decoding now strips the leading slash and converts separators on Windows, keys canonicalize the drive letter, and the client passes the platform through. `pathToUri` also escapes `#` and `%` on every platform now. `node test.mjs` prints ok."
      )
    )
  ]
}
