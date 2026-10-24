import assert from 'node:assert/strict'
import { didOpen } from './lsp/client.mjs'
import { createDiagnosticsStore } from './lsp/diagnostics.mjs'
import { pathToUri } from './lsp/uri.mjs'

// One file, one key (lsp/uri.mjs), however the server or the editor spells it.
const unused = [{ message: "'x' is declared but never used", severity: 2 }]
const typeError = [{ message: "Type 'string' is not assignable to type 'number'", severity: 1 }]
const store = createDiagnosticsStore({ platform: 'win32' })

store.publish({ uri: 'file:///c%3A/Users/dev/My%20App/src/app.ts', diagnostics: typeError })
assert.deepEqual(store.forFile('c:\\Users\\dev\\My App\\src\\app.ts'), typeError, 'a lowercase drive is the same file')
assert.deepEqual(store.forFile('C:/Users/dev/My App/src/app.ts'), typeError, 'forward slashes are the same file')

// Other servers send the drive as-is; a later publish for the same file replaces the first.
store.publish({ uri: 'file:///C:/Users/dev/My%20App/src/app.ts', diagnostics: unused })
assert.deepEqual(store.forFile('C:\\Users\\dev\\My App\\src\\app.ts'), unused)
assert.equal(store.files().length, 1, `one file, one key: ${JSON.stringify(store.files())}`)

// An empty publish clears it, whichever spelling it uses.
store.publish({ uri: 'file:///c%3a/Users/dev/My%20App/src/app.ts', diagnostics: [] })
assert.deepEqual(store.files(), [])

// A second drive is a different file.
store.publish({ uri: 'file:///d%3A/work/api/index.ts', diagnostics: unused })
assert.deepEqual(store.forFile('D:\\work\\api\\index.ts'), unused)
assert.deepEqual(store.forFile('C:\\work\\api\\index.ts'), [])

// Every platform: a `#` or `%` in a file name must be escaped in the URI the client
// sends, or the server reads the rest of the name as a fragment and the file never gets
// diagnostics. (The platform is passed explicitly so this means the same on any host.)
assert.equal(pathToUri('/home/dev/100% done/#1.ts', 'linux'), 'file:///home/dev/100%25%20done/%231.ts')
const opened = didOpen('/home/dev/notes #2.ts', 'export {}', 'typescript', 'linux').params.textDocument.uri
assert.equal(opened, 'file:///home/dev/notes%20%232.ts')
const linux = createDiagnosticsStore({ platform: 'linux' })
linux.publish({ uri: opened, diagnostics: unused })
assert.deepEqual(linux.forFile('/home/dev/notes #2.ts'), unused)
console.log('ok')
