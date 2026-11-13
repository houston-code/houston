import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inferVerifyCommand } from './verifyInfer'

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-verify-'))
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const put = (rel: string, text: string): void => {
  mkdirSync(join(ws, rel, '..'), { recursive: true })
  writeFileSync(join(ws, rel), text)
}
const pkg = (scripts: Record<string, string>): void => put('package.json', JSON.stringify({ scripts }))

describe('inferVerifyCommand', () => {
  it('finds nothing in an empty folder, or a missing one', () => {
    expect(inferVerifyCommand(ws)).toBeNull()
    expect(inferVerifyCommand(join(ws, 'missing'))).toBeNull()
  })

  it('combines a typecheck and a test script, with the lockfile runner', () => {
    pkg({ typecheck: 'tsc --noEmit', test: 'vitest run', build: 'vite build' })
    expect(inferVerifyCommand(ws)).toEqual({
      command: 'npm run typecheck && npm test',
      source: 'package.json scripts typecheck and test'
    })
    put('pnpm-lock.yaml', '')
    expect(inferVerifyCommand(ws)?.command).toBe('pnpm typecheck && pnpm test')
  })

  it('uses yarn or bun when their lockfile is there', () => {
    pkg({ test: 'jest' })
    put('yarn.lock', '')
    expect(inferVerifyCommand(ws)).toEqual({ command: 'yarn test', source: 'package.json script test' })
    rmSync(join(ws, 'yarn.lock'))
    put('bun.lock', '')
    expect(inferVerifyCommand(ws)?.command).toBe('bun run test')
  })

  it("skips npm's placeholder test and watch-mode scripts", () => {
    pkg({ test: 'echo "Error: no test specified" && exit 1' })
    expect(inferVerifyCommand(ws)).toBeNull()
    pkg({ test: 'jest --watch', 'type-check': 'tsc -p .' })
    expect(inferVerifyCommand(ws)).toEqual({ command: 'npm run type-check', source: 'package.json script type-check' })
  })

  it('ignores a broken package.json and falls through to other manifests', () => {
    put('package.json', '{nope')
    put('Cargo.toml', '[package]\nname = "x"')
    expect(inferVerifyCommand(ws)).toEqual({ command: 'cargo test', source: 'Cargo.toml' })
  })

  it('reads Go and pytest projects', () => {
    put('go.mod', 'module x')
    expect(inferVerifyCommand(ws)?.command).toBe('go test ./...')
    rmSync(join(ws, 'go.mod'))
    put('pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-q"')
    expect(inferVerifyCommand(ws)).toEqual({ command: 'python -m pytest', source: 'pytest configuration' })
    put('uv.lock', '')
    expect(inferVerifyCommand(ws)?.command).toBe('uv run pytest')
  })

  it('reads pytest from setup.cfg, tox.ini or a tests conftest', () => {
    put('setup.cfg', '[tool:pytest]\n')
    expect(inferVerifyCommand(ws)?.command).toBe('python -m pytest')
    rmSync(join(ws, 'setup.cfg'))
    put(join('tests', 'conftest.py'), '')
    expect(inferVerifyCommand(ws)?.command).toBe('python -m pytest')
  })
})
