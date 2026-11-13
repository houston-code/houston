import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { VerifySuggestion } from '@shared/types'

/**
 * Infer a "verify on finish" command from the project's own files: package.json
 * scripts (typecheck, test), a Cargo, Go or pytest project. Only a suggestion: the
 * Settings field it fills is still the user's to keep or change, and filling it
 * doesn't turn verification on.
 */

/** Largest manifest read. */
const MAX_MANIFEST_BYTES = 1_000_000

function readSmall(path: string): string | null {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The npm-compatible runner a project uses, from its lockfile. */
function packageRunner(dir: string): { run: (script: string) => string; name: string } {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return { name: 'pnpm', run: (s) => `pnpm ${s}` }
  if (existsSync(join(dir, 'yarn.lock'))) return { name: 'yarn', run: (s) => `yarn ${s}` }
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return { name: 'bun', run: (s) => `bun run ${s}` }
  return { name: 'npm', run: (s) => (s === 'test' ? 'npm test' : `npm run ${s}`) }
}

/** A script that would run once and exit (not a watcher, not npm's placeholder). */
function runsOnce(script: string): boolean {
  return !/--watch\b|\bwatch\b/.test(script) && !/no test specified/i.test(script)
}

function fromPackageJson(dir: string): VerifySuggestion | null {
  const text = readSmall(join(dir, 'package.json'))
  if (text === null) return null
  let scripts: Record<string, unknown>
  try {
    const raw = JSON.parse(text) as { scripts?: unknown }
    if (!raw.scripts || typeof raw.scripts !== 'object') return null
    scripts = raw.scripts as Record<string, unknown>
  } catch {
    return null
  }
  const has = (name: string): boolean => typeof scripts[name] === 'string' && runsOnce(scripts[name] as string)
  const typecheck = ['typecheck', 'type-check', 'check-types', 'tsc'].find(has)
  const picked = [typecheck, has('test') ? 'test' : undefined].filter((s): s is string => !!s)
  if (!picked.length) return null
  const runner = packageRunner(dir)
  return {
    command: picked.map(runner.run).join(' && '),
    source: `package.json ${picked.length > 1 ? 'scripts' : 'script'} ${picked.join(' and ')}`
  }
}

function usesPytest(dir: string): boolean {
  if (existsSync(join(dir, 'pytest.ini')) || existsSync(join(dir, 'conftest.py'))) return true
  const pyproject = readSmall(join(dir, 'pyproject.toml'))
  if (pyproject && /\[tool\.pytest|\bpytest\b/.test(pyproject)) return true
  if (/\[pytest\]/.test(readSmall(join(dir, 'tox.ini')) ?? '')) return true
  if (/\[tool:pytest\]/.test(readSmall(join(dir, 'setup.cfg')) ?? '')) return true
  return existsSync(join(dir, 'tests', 'conftest.py'))
}

/** The verification command this project suggests, or null when nothing fits. */
export function inferVerifyCommand(workspace: string): VerifySuggestion | null {
  let dir: string
  try {
    dir = realpathSync(workspace)
    if (!statSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  const npm = fromPackageJson(dir)
  if (npm) return npm
  if (existsSync(join(dir, 'Cargo.toml'))) return { command: 'cargo test', source: 'Cargo.toml' }
  if (existsSync(join(dir, 'go.mod'))) return { command: 'go test ./...', source: 'go.mod' }
  if (usesPytest(dir)) {
    if (existsSync(join(dir, 'uv.lock'))) return { command: 'uv run pytest', source: 'pytest with uv' }
    if (existsSync(join(dir, 'poetry.lock'))) return { command: 'poetry run pytest', source: 'pytest with Poetry' }
    return { command: 'python -m pytest', source: 'pytest configuration' }
  }
  return null
}
