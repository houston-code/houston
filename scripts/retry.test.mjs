import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'retry.sh')
const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Runs retry.sh on a command that fails (exit 7) its first `failures` calls, then succeeds. */
function run(failures, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'retry-'))
  dirs.push(dir)
  const cmd = join(dir, 'flaky.sh')
  writeFileSync(
    cmd,
    `n=$(($(cat "${dir}/count" 2>/dev/null || echo 0) + 1)); echo "$n" > "${dir}/count"\n` +
      `echo "args: $*"; [ "$n" -gt ${failures} ] || exit 7\n`
  )
  const res = spawnSync('bash', [script, 'bash', cmd, 'a b', 'c'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, RETRY_DELAY: '0', ...env }
  })
  return { ...res, calls: Number(readFileSync(join(dir, 'count'), 'utf8')) }
}

describe.skipIf(process.platform === 'win32')('retry.sh', () => {
  it('runs a passing command once, passing its arguments through intact', () => {
    const res = run(0)
    expect(res.status).toBe(0)
    expect(res.calls).toBe(1)
    expect(res.stdout).toContain('args: a b c')
    expect(res.stdout).not.toContain('::warning::')
  })

  it('retries a failing command until it passes', () => {
    const res = run(2)
    expect(res.status).toBe(0)
    expect(res.calls).toBe(3)
    expect(res.stdout).toContain('failed (exit 7, attempt 2 of 3); retrying in 0s')
  })

  it("gives up after the last attempt with the command's exit status", () => {
    const res = run(3)
    expect(res.status).toBe(7)
    expect(res.calls).toBe(3)
    expect(res.stdout).toContain('failed 3 times (last exit 7)')
  })

  it('honours RETRY_ATTEMPTS', () => {
    const res = run(5, { RETRY_ATTEMPTS: '2' })
    expect(res.status).toBe(7)
    expect(res.calls).toBe(2)
  })

  it('refuses to run with no command', () => {
    const res = spawnSync('bash', [script], { encoding: 'utf8' })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('usage: retry.sh')
  })
})
