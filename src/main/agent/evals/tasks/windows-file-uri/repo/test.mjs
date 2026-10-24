import assert from 'node:assert/strict'
import { createDiagnosticsStore } from './lsp/diagnostics.mjs'

// The platform is a parameter, so both behaviours are tested on any machine.
const unused = [{ message: "'x' is declared but never used", severity: 2 }]
const typeError = [{ message: "Type 'string' is not assignable to type 'number'", severity: 1 }]

// macOS and Linux.
{
  const store = createDiagnosticsStore({ platform: 'linux' })
  store.publish({ uri: 'file:///home/dev/my%20app/src/a.ts', diagnostics: unused })
  assert.deepEqual(store.forFile('/home/dev/my app/src/a.ts'), unused)
}

// Windows, as reported: TypeScript's server sends the drive lowercased with its colon
// escaped, and the editor asks with a backslash path.
{
  const store = createDiagnosticsStore({ platform: 'win32' })
  store.publish({ uri: 'file:///c%3A/Users/dev/My%20App/src/app.ts', diagnostics: typeError })
  assert.deepEqual(store.forFile('C:\\Users\\dev\\My App\\src\\app.ts'), typeError, 'diagnostics never reach the editor')
}
console.log('ok')
