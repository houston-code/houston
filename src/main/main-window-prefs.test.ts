import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainWindowWebPreferences } from './main-window-prefs'

const ROOT = join(__dirname, '..', '..')

/** The non-type `import ... from '<spec>'` specifiers in a TypeScript source file. */
function runtimeImports(source: string): string[] {
  const specs: string[] = []
  for (const m of source.matchAll(/^import\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
    if (!m[1]) specs.push(m[2])
  }
  for (const m of source.matchAll(/^import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1])
  return specs
}

describe('main window webPreferences', () => {
  it('runs the renderer sandboxed and isolated, with no Node integration', () => {
    const prefs = mainWindowWebPreferences('/app/out/preload/index.js')
    expect(prefs).toEqual({
      preload: '/app/out/preload/index.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    })
  })

  it('keeps the preload loadable in a sandbox: it may only need electron at runtime', () => {
    // A sandboxed preload can require only 'electron' and a few polyfilled modules.
    // Its other runtime import is the IPC channel table, which must stay free of
    // imports itself so the bundler inlines plain data.
    const preload = readFileSync(join(ROOT, 'src', 'preload', 'index.ts'), 'utf8')
    expect(runtimeImports(preload).sort()).toEqual(['@shared/constants', 'electron'])
    expect(preload).not.toMatch(/\brequire\(|\bprocess\.|\bBuffer\b/)

    const constants = readFileSync(join(ROOT, 'src', 'shared', 'constants.ts'), 'utf8')
    expect(runtimeImports(constants)).toEqual([])
    expect(constants).not.toMatch(/\brequire\(|\bprocess\.|\bBuffer\b/)
  })
})
